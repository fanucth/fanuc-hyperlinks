# Scrap Photo Capture System — FANUC Thai Limited

## บริบทโปรเจกต์
ระบบเก็บหลักฐานภาพถ่ายก่อน/หลังทำลายชิ้นงาน scrap สำหรับ FANUC Thailand
- ผู้ดูแล: วีรชัย จิตสุวรรณทายา (แมค) — IT Support, FANUC Thai Limited
- สเกลที่ตั้งเป้า: ~3,000 ชิ้นงาน (ใหญ่ 1,000 + เล็ก 2,000), ~6,000+ รูปภาพ (อาจมากกว่านี้เพราะรองรับหลายรูป/เฟส)
- Workflow: สแกนบาร์โค้ด Code 39 บนชิ้นงาน → ถ่ายภาพ "ก่อนทำลาย" และ "หลังทำลาย" (หลายรูปได้) → บันทึกขึ้น Cloud → Export Excel/PDF เป็นหลักฐานตรวจสอบ (audit)

## ไฟล์หลัก
- `scrap_scan_prototype.html` — ไฟล์เดียวจบ (HTML+CSS+JS ทั้งหมด, ไม่มี build step)
- เวอร์ชันล่าสุดที่ส่งมอบ: **v2.8**
- Hosting ปัจจุบัน: GitHub Pages → `https://macweerachai.github.io/fanuc-hyperlinks/scrap_scan_prototype.html`
- Repo: `macweerachai/fanuc-hyperlinks` (branch `main`)

## Tech Stack
| ส่วน | เทคโนโลยี |
|------|-----------|
| Barcode scanning | `html5-qrcode` v2.3.8 (CDN: unpkg) — **จำกัดแค่ Code 39 เท่านั้น** (ตัด Code128/93/ITF/EAN13/QR ออกแล้วเพื่อความเร็ว+แม่นยำ) |
| OCR fallback | `Tesseract.js` v5.1.0 — อ่าน Part No. จากตัวอักษรบนป้าย เมื่อบาร์โค้ดชำรุด/สแกนไม่ติด (regex pattern จับรูปแบบ FANUC เช่น A06B-1407-B153) |
| Export | `XLSX.js` (Excel), `jsPDF` (PDF audit report พร้อมรูปภาพ) |
| Backend (กำลังทำ) | **Supabase** (PostgreSQL + Storage + Auth) — โค้ดเขียนรอไว้แล้วในไฟล์ แต่ `SUPABASE_CONFIG` (url + anonKey) ยังว่างอยู่ ต้องสร้าง Supabase project แล้วใส่ค่าจริง |

## ประวัติการตัดสินใจสำคัญ (สำคัญมาก อย่าย้อนกลับไปทำผิดซ้ำ)
1. **Firebase → Supabase**: ตอนแรกเริ่มด้วย Firebase (สร้าง project `fanuctha1limited` ไว้แล้วแต่เลิกใช้) แล้วเปลี่ยนมา Supabase เพราะผู้ใช้ถนัด SQL (มีหลาย project ที่ใช้ MySQL อยู่แล้ว) — Migrate MySQL→PostgreSQL ง่ายกว่า NoSQL→SQL มาก จึงเลือก Supabase ตั้งแต่ต้นเพื่อเลี่ยงปัญหาย้ายฐานข้อมูลทีหลัง
2. **ไม่ใช้ Firebase/Supabase Hosting**: ตั้งใจเลี่ยง CLI เพราะผู้ใช้ไม่ถนัด — ใช้ GitHub Pages hosting เดิม (อัพเดตผ่านหน้าเว็บ GitHub, copy-paste เนื้อไฟล์) backend (Supabase) ใช้แค่ Database/Storage/Auth เท่านั้น
3. **QR Code ตัดออกแล้ว**: เคยรองรับทั้ง Code 39 + QR แต่เจอบั๊ก (กรอบสแกนสี่เหลี่ยมจัตุรัสที่ต้องใช้รองรับ QR ทำให้สแกนช้าลง) → ผู้ใช้ยืนยันว่าชิ้นงานจริงใช้ **Code 39 อย่างเดียว 100%** จึงตัด QR/Code128/93/ITF/EAN13 ออกทั้งหมด เหลือ Code 39 อย่างเดียว เพื่อความเร็ว+แม่นยำสูงสุด (fps 20, disableFlip, กรอบสแกนแถบแนวนอน)
4. **บั๊กที่เคยเจอและแก้แล้ว** (ห้ามทำผิดซ้ำ):
   - ห้ามซ่อนกล้อง (`display:none`) ตอนเรียก `Html5Qrcode.start()` — ต้องโชว์กล้องก่อนเสมอ ไม่งั้นไลบรารีคำนวณขนาดกรอบสแกนเป็น 0 ทำให้สแกนไม่ติดเลย
   - กรอบสแกน (qrbox) ต้องเลือกทรงให้เข้ากับชนิดโค้ด — บาร์โค้ด 1 มิติ (Code 39) ใช้กรอบแถบแนวนอนกว้าง+เตี้ย (ปัจจุบัน: `h = w * 0.38`)
5. **รองรับหลายภาพต่อเฟส**: เดิมจำกัด 1 รูป/เฟส (ก่อน/หลัง) → เปลี่ยนเป็น array รองรับไม่จำกัดจำนวน (soft limit เตือนที่ 10 รูป) — UI เป็นแกลเลอรี่ thumbnail พร้อมปุ่มลบ (✕) รายรูป

## Database Schema (Supabase — ยังไม่ได้สร้างจริง รอ setup)
```sql
-- ตารางหลัก (1 แถวต่อ 1 ครั้งที่กดบันทึก)
create table scrap_records (
  id uuid primary key default gen_random_uuid(),
  item_code text not null,
  status text default 'partial',           -- 'complete' เมื่อมีทั้ง before และ after อย่างน้อยเฟสละ 1 รูป
  created_by uuid references auth.users(id),
  created_by_email text,
  created_at timestamptz default now()
);

-- ตารางรูปภาพ (หลายแถวต่อ 1 record — 1-to-many)
create table scrap_photos (
  id uuid primary key default gen_random_uuid(),
  record_id uuid references scrap_records(id) on delete cascade,
  phase text not null check (phase in ('before','after')),
  photo_url text not null,
  uploaded_at timestamptz default now()
);

alter table scrap_records enable row level security;
alter table scrap_photos enable row level security;

create policy "ต้อง login ก่อนถึงจะใช้งานได้" on scrap_records
for all using (auth.uid() is not null) with check (auth.uid() is not null);

create policy "ต้อง login ก่อนถึงจะใช้งานได้" on scrap_photos
for all using (auth.uid() is not null) with check (auth.uid() is not null);
```

**Storage bucket**: ชื่อ `scrap-photos`, ตั้งเป็น public bucket
```sql
create policy "ต้อง login ก่อนอัพโหลดรูป" on storage.objects
for insert with check (bucket_id = 'scrap-photos' and auth.uid() is not null);

create policy "ทุกคนดูรูปได้ (public read)" on storage.objects
for select using (bucket_id = 'scrap-photos');
```

โค้ดในไฟล์ (`uploadOne`, `uploadPhaseAll`, `uploadToCloud` ในส่วนที่ 7) เขียนรองรับ schema นี้ไว้แล้ว — พาธไฟล์ใน Storage: `{itemCode}/{phase}_{timestamp}_{index}.jpg`

## งานที่เหลือ (Next Steps)
1. [ ] สร้าง Supabase project จริง (region: Southeast Asia/Singapore)
2. [ ] รัน SQL schema ด้านบนใน Supabase SQL Editor
3. [ ] สร้าง Storage bucket `scrap-photos` (public) + policies
4. [ ] เปิด Authentication (Email/Password) + สร้าง user ทดสอบ
5. [ ] เอา Project URL + anon key ใส่ใน `SUPABASE_CONFIG` ของไฟล์ HTML
6. [ ] Push ไฟล์ล่าสุดขึ้น GitHub (`git add`, `commit`, `push` — Claude Code ทำให้ได้ตรงๆ ไม่ต้อง copy-paste ผ่านหน้าเว็บแบบเดิม)
7. [ ] ทดสอบ end-to-end: สแกน Code 39 → ถ่ายหลายภาพ → บันทึกขึ้น Supabase → login flow
8. [ ] เพิ่ม 2FA (requirement เดิมตั้งแต่ต้นโปรเจกต์ ยังไม่ได้ทำ)
9. [ ] ทดสอบ scale จริง ~3,000 ชิ้นงาน

## หมายเหตุอื่นๆ
- ผู้ใช้สื่อสารเป็นภาษาไทยเป็นหลัก ชอบคำตอบกระชับ ตรงประเด็น มี step-by-step
- ผู้ใช้ต้องการ UI ที่ใช้งานง่ายบนมือถือ (ทดสอบบน iPhone จริง) — เคยเจอปัญหา layout ไม่พอดีจอ, กล้องจอดำ, กรอบสแกนผิดสัดส่วน ล้วนแก้ไปแล้วใน v2.5-v2.7
- Firebase project `fanuctha1limited` ถูกสร้างไว้ตอนแรกแต่เลิกใช้แล้ว ปล่อยว่างไว้ได้ไม่มีผลกระทบ (free tier)
