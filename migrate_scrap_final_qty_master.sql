-- =====================================================================
-- Scrap v3.18: Master Final Disposal Qty
-- รันทั้งไฟล์ใน Supabase SQL Editor ของโปรเจกต์ scrap ก่อน deploy scrap.html v3.18
-- รันซ้ำได้อย่างปลอดภัย ไม่ลบข้อมูลเดิม
-- =====================================================================

begin;

-- เวอร์ชันก่อนหน้ามีช่อง QTY ในหน้าเว็บ แต่ฐานข้อมูลเดิมอาจยังไม่มีคอลัมน์นี้
-- ต้องสร้างก่อนประกาศ RPC/Trigger ที่อ้างถึง disposal_qty
alter table scrap_records
  add column if not exists disposal_qty integer check (disposal_qty >= 0);

-- แปลงรหัสให้อยู่รูปแบบเดียวกับข้อมูลปัจจุบัน: ตัวพิมพ์ใหญ่ + / เป็น #
create or replace function normalize_scrap_item_code(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select replace(upper(trim(coalesce(p_code, ''))), '/', '#');
$$;

-- แหล่งข้อมูลมาตรฐานจาก Excel (1 แถวต่อ 1 Item No.)
create table if not exists scrap_final_qty_master (
  item_code text primary key,
  final_disposal_qty integer not null check (final_disposal_qty >= 0),
  source_filename text,
  imported_at timestamptz not null default now(),
  imported_by_email text
);

alter table scrap_final_qty_master enable row level security;
-- ไม่มี policy อ่าน/เขียนตรง: ผู้ใช้ตรวจได้เฉพาะผล match/mismatch ผ่าน RPC
-- และ Admin นำเข้าได้ผ่าน import_scrap_final_qty() เท่านั้น

-- ประวัติการนำเข้า
create table if not exists scrap_qty_import_log (
  id bigint generated always as identity primary key,
  source_filename text,
  input_rows integer not null,
  imported_master integer not null,
  updated_records integer not null,
  imported_by_email text,
  imported_at timestamptz not null default now()
);
alter table scrap_qty_import_log enable row level security;

-- ให้หน้าเว็บตรวจเพียงว่า QTY ตรงหรือไม่ โดยไม่คืนค่ามาตรฐานให้ผู้กรอก
create or replace function check_scrap_final_qty(p_item_code text, p_qty integer)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_expected integer;
begin
  select final_disposal_qty into v_expected
  from scrap_final_qty_master
  where item_code = normalize_scrap_item_code(p_item_code);

  if not found then return 'not_found'; end if;
  if p_qty = v_expected then return 'match'; end if;
  return 'mismatch';
end;
$$;

revoke all on function check_scrap_final_qty(text, integer) from public;
grant execute on function check_scrap_final_qty(text, integer) to authenticated;

-- Admin นำเข้า JSON จาก Excel: upsert Master แล้วเติม QTY ให้ scrap_records เดิมที่ตรงกัน
create or replace function import_scrap_final_qty(p_rows jsonb, p_filename text default null)
returns table(imported_master integer, updated_records integer, input_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imported integer := 0;
  v_updated integer := 0;
  v_input integer := 0;
begin
  if not is_scrap_admin() then
    raise exception 'ADMIN_ONLY';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_QTY_IMPORT';
  end if;

  v_input := jsonb_array_length(p_rows);

  with parsed as (
    select
      normalize_scrap_item_code(x.obj->>'item_code') as item_code,
      (x.obj->>'qty')::integer as qty,
      x.ord
    from jsonb_array_elements(p_rows) with ordinality as x(obj, ord)
    where normalize_scrap_item_code(x.obj->>'item_code') <> ''
      and coalesce(x.obj->>'qty', '') ~ '^\d+$'
  ), dedup as (
    select distinct on (item_code) item_code, qty
    from parsed
    order by item_code, ord desc
  )
  insert into scrap_final_qty_master
    (item_code, final_disposal_qty, source_filename, imported_at, imported_by_email)
  select
    item_code, qty, p_filename, now(), lower(auth.jwt()->>'email')
  from dedup
  on conflict (item_code) do update set
    final_disposal_qty = excluded.final_disposal_qty,
    source_filename = excluded.source_filename,
    imported_at = excluded.imported_at,
    imported_by_email = excluded.imported_by_email;

  get diagnostics v_imported = row_count;

  with imported_codes as (
    select distinct normalize_scrap_item_code(x.obj->>'item_code') as item_code
    from jsonb_array_elements(p_rows) as x(obj)
    where normalize_scrap_item_code(x.obj->>'item_code') <> ''
  )
  update scrap_records r
  set disposal_qty = m.final_disposal_qty
  from scrap_final_qty_master m
  where normalize_scrap_item_code(r.item_code) = m.item_code
    and m.item_code in (select item_code from imported_codes)
    and r.disposal_qty is distinct from m.final_disposal_qty;

  get diagnostics v_updated = row_count;

  insert into scrap_qty_import_log
    (source_filename, input_rows, imported_master, updated_records, imported_by_email)
  values
    (p_filename, v_input, v_imported, v_updated, lower(auth.jwt()->>'email'));

  return query select v_imported, v_updated, v_input;
end;
$$;

revoke all on function import_scrap_final_qty(jsonb, text) from public;
grant execute on function import_scrap_final_qty(jsonb, text) to authenticated;

-- บังคับที่ฐานข้อมูลอีกชั้น: insert หรือแก้ Item/QTY ต้องตรงกับ Master เสมอ
create or replace function enforce_scrap_final_qty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer;
begin
  -- ช่วงหลังรัน migration แต่ยังไม่ได้นำเข้า Excel: ไม่บล็อกระบบเดิม
  -- เมื่อ Master มีข้อมูลอย่างน้อย 1 แถว การตรวจจะเริ่มบังคับอัตโนมัติ
  if not exists (select 1 from scrap_final_qty_master limit 1) then
    return new;
  end if;

  select final_disposal_qty into v_expected
  from scrap_final_qty_master
  where item_code = normalize_scrap_item_code(new.item_code);

  if not found then
    raise exception 'FINAL_QTY_NOT_FOUND';
  end if;
  if new.disposal_qty is null or new.disposal_qty <> v_expected then
    raise exception 'FINAL_QTY_MISMATCH';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_scrap_final_qty on scrap_records;
create trigger trg_enforce_scrap_final_qty
before insert or update of item_code, disposal_qty on scrap_records
for each row execute function enforce_scrap_final_qty();

commit;

-- ให้ PostgREST เห็นคอลัมน์/RPC ใหม่ทันที
notify pgrst, 'reload schema';

-- ตรวจหลังรัน (ควรได้ฟังก์ชัน 2 ตัวและตาราง Master ว่าง จนกว่าจะกด Import ในหน้าเว็บ)
select to_regclass('public.scrap_final_qty_master') as master_table,
       to_regclass('public.scrap_qty_import_log') as log_table;
