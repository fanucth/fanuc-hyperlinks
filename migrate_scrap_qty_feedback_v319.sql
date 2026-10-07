-- =====================================================================
-- Scrap v3.19: QTY feedback + strict Final Disposal Master validation
-- Run once in Supabase SQL Editor before deploying scrap.html v3.19.
-- Safe to run again. Existing scrap records and photos are not deleted.
-- =====================================================================

begin;

-- Return the expected QTY only when the user entered a different value.
-- The web page displays it as guidance but never fills the input automatically.
drop function if exists check_scrap_final_qty(text, integer);

create function check_scrap_final_qty(p_item_code text, p_qty integer)
returns jsonb
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

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_qty = v_expected then
    return jsonb_build_object('status', 'match');
  end if;

  return jsonb_build_object(
    'status', 'mismatch',
    'expected_qty', v_expected
  );
end;
$$;

revoke all on function check_scrap_final_qty(text, integer) from public;
grant execute on function check_scrap_final_qty(text, integer) to authenticated;

-- Enforce the same rule in the database. A missing/empty Master must block saves.
create or replace function enforce_scrap_final_qty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer;
begin
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

notify pgrst, 'reload schema';
