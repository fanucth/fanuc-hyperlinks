/* =====================================================================
   นำเข้าบิลค่าน้ำมันจาก Excel (เฉพาะ fuel admin) — ใช้ร่วมกับ index.html (sb, $, esc, money, toast, show)
   รูปแบบไฟล์: ชีต "Summarized" ของไฟล์ Gasoline MM-YYYY.xlsx
     - แต่ละบล็อกมีหัวข้อ "... during 1-31 March 2026" -> เดือนที่เรียกเก็บของแถวในบล็อกนั้น
       (ไฟล์เดียวมีหลายบล็อกได้ เช่น บล็อกปรับย้อนหลังของเดือนก่อน)
     - แถวหัวคอลัมน์มี "Name of staff", "Cost Center", [ประเภท], Gasoline, Tollgate, Car wash, Parking Fee,
       adjustment, Total, Remark   | แถว "Total"/"Grand Total" ปิดบล็อก
     - ชื่อพนักงานเป็นชื่อต้น เช่น "Mr. Sahaphob" / "Mr. Chatchai C."  -> จับคู่กับ employees.fname (+ ตัวอักษรต้นนามสกุล)
     - ชีต "Calculation" (ถ้ามี) ใช้ดึงทะเบียนรถ (No. car) ตามชื่อ
   ===================================================================== */
const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
let EMP = [];            // พนักงาน active (id,fname,lname,department) จาก RPC fuel_employee_lookup
let IMP_ROWS = [];       // แถวที่อ่านจากไฟล์
let IMP_EXISTING = new Set();   // "employee_id|billing_month" ที่มีบิลอยู่แล้ว
let IMP_LAST_BATCH = null;

const norm = v => (typeof v === 'string' ? v.trim() : v);
function num(v){
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
const r2 = n => Math.round(n * 100) / 100;

// "Mr. Chatchai C." -> {f:'chatchai', rest:'c'} ; "Mr. Chatchai.T" -> {f:'chatchai', rest:'t'}
function splitName(s){
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^(mr|mrs|ms|miss)\.?\s+/i, '');
  const tok = t.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
  return { f: (tok[0] || '').toLowerCase(), rest: tok.slice(1).join('').toLowerCase() };
}
function matchEmp(nameRaw){
  const { f, rest } = splitName(nameRaw);
  if (!f) return [];
  let c = EMP.filter(e => String(e.fname).trim().toLowerCase() === f);
  if (c.length > 1 && rest) {
    const c2 = c.filter(e => String(e.lname).trim().toLowerCase().startsWith(rest));
    if (c2.length) c = c2;
  }
  return c;
}

function mapCols(r){
  const col = {};
  r.forEach((v, i) => {
    if (typeof v !== 'string') return;
    const k = v.trim().toLowerCase();
    if (/name of staff/.test(k)) col.name = i;
    else if (k === 'cost center') { col.cc = i; col.type = i + 1; }
    else if (k === 'gasoline') col.g = i;
    else if (k === 'tollgate') col.t = i;
    else if (k === 'car wash') col.w = i;
    else if (k === 'parking fee') col.p = i;
    else if (k === 'adjustment') col.adj = i;
    else if (k === 'total') col.total = i;
    else if (k === 'remark') col.remark = i;
  });
  return (col.name != null && col.g != null && col.t != null) ? col : null;
}

function readCars(wb){
  const nm = wb.SheetNames.find(n => /^calculation$/i.test(n.trim())) ||
             wb.SheetNames.find(n => /calculation/i.test(n) && !/\d\s*$/.test(n.trim()));
  const map = new Map();
  if (!nm) return map;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null });
  let ci = -1, ni = -1;
  for (const r of rows) {
    const c = r.findIndex(v => typeof v === 'string' && /no\.?\s*car/i.test(v));
    if (c >= 0) { ci = c; ni = r.findIndex(v => typeof v === 'string' && /name of staff/i.test(v)); continue; }
    if (ci < 0 || ni < 0 || typeof r[ni] !== 'string' || typeof r[ci] !== 'string') continue;
    const { f, rest } = splitName(r[ni]);
    if (f && r[ci].trim()) map.set(f + '|' + rest, r[ci].trim());
  }
  return map;
}

function parseSummarized(wb, fallbackMonth){
  const sn = wb.SheetNames.find(n => /summar/i.test(n));
  if (!sn) throw new Error('The "Summarized" sheet was not found — check that this is the monthly Gasoline file.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
  const cars = readCars(wb);
  let blk = null, col = null;
  const out = [];
  rows.forEach((r, i) => {
    const text = r.filter(v => typeof v === 'string').join(' ');
    const t = /during\s+\d+\s*-\s*(\d+)\s+([A-Za-z]+)\s+(\d{4})/i.exec(text);
    if (t && MON[t[2].slice(0, 3).toLowerCase()]) {
      blk = { y: +t[3], m: MON[t[2].slice(0, 3).toLowerCase()], last: +t[1] }; col = null; return;
    }
    if (r.some(v => typeof v === 'string' && /name of staff/i.test(v))) { const c = mapCols(r); if (c) { col = c; return; } }
    if (!col) return;
    const nm = norm(r[col.name]);
    if (typeof nm !== 'string' || !nm) return;
    if (/^(grand\s+)?total$/i.test(nm)) { col = null; return; }

    let b = blk;
    if (!b) {
      if (!fallbackMonth) throw new Error('No billing period was found in the file heading — pick a "Billing month" above and try again.');
      const [fy, fm] = fallbackMonth.split('-').map(Number);
      b = { y: fy, m: fm, last: new Date(fy, fm, 0).getDate() };
    }
    const g = num(r[col.g]), tl = num(r[col.t]), w = col.w != null ? num(r[col.w]) : 0,
          p = col.p != null ? num(r[col.p]) : 0, adj = col.adj != null ? num(r[col.adj]) : 0;
    if (!g && !tl && !w && !p && !adj) return;
    const computed = r2(g + tl + w + p + adj);
    const totalFile = col.total != null && r[col.total] != null ? num(r[col.total]) : null;
    const { f, rest } = splitName(nm);
    const mm = String(b.m).padStart(2, '0');
    const typeCell = col.type != null ? norm(r[col.type]) : null;
    out.push({
      src: i + 1, nameRaw: nm,
      cc: col.cc != null ? (norm(r[col.cc]) || null) : null,
      type: typeof typeCell === 'string' && typeCell ? typeCell.toUpperCase() : null,
      g, t: tl, w, p, adj, computed,
      warn: totalFile != null && Math.abs(totalFile - computed) > 0.01 ? `file total ${money(totalFile)} differs from calculated ${money(computed)}` : '',
      remark: col.remark != null ? (norm(r[col.remark]) || null) : null,
      billing_month: `${b.y}-${mm}`, bill_date: `${b.y}-${mm}-${String(b.last).padStart(2, '0')}`,
      car_no: cars.get(f + '|' + rest) || null,
      cand: [], empId: null,
    });
  });
  return out;
}

function rowStatus(r){
  if (!r.empId) return 'pick';
  if (IMP_EXISTING.has(r.empId + '|' + r.billing_month)) return 'dup';
  return 'ok';
}

function renderImport(){
  const cnt = { ok: 0, pick: 0, dup: 0 }; let sum = 0;
  IMP_ROWS.forEach(r => { const s = rowStatus(r); cnt[s]++; if (s === 'ok') sum += r.computed; });
  const empName = id => { const e = EMP.find(x => x.id === id); return e ? `${esc(e.fname)} ${esc(e.lname)}` : ''; };

  $('impBody').innerHTML = IMP_ROWS.map((r, i) => {
    const s = rowStatus(r);
    let who;
    if (r.cand.length === 1) who = empName(r.empId);
    else {
      const list = r.cand.length ? r.cand : EMP;
      who = `<select class="fc-input" data-i="${i}" style="min-width:200px">
        <option value="">Select employee…</option>` +
        list.map(e => `<option value="${e.id}" ${e.id === r.empId ? 'selected' : ''}>${esc(e.fname)} ${esc(e.lname)} (${esc(e.department || '-')})</option>`).join('') + '</select>';
    }
    const badge = s === 'ok' ? '<span class="fc-badge fc-badge--ok">Ready</span>'
      : s === 'dup' ? '<span class="fc-badge fc-badge--info">Already imported — skipped</span>'
      : `<span class="fc-badge fc-badge--warn">${r.cand.length > 1 ? 'Duplicate name — pick one' : 'Not found — pick one'}</span>`;
    const n = v => v ? money(v) : '<span class="dash">—</span>';
    return `<tr><td>${esc(r.billing_month)}</td><td>${esc(r.nameRaw)}</td><td>${who}</td>
      <td>${esc(r.cc || '-')}</td><td>${esc(r.type || '-')}</td><td>${esc(r.car_no || '-')}</td>
      <td class="num">${n(r.g)}</td><td class="num">${n(r.t)}</td>
      <td class="num">${n(r.w)}</td><td class="num">${n(r.p)}</td><td class="num">${n(r.adj)}</td>
      <td class="num total">${money(r.computed)}</td>
      <td>${badge}${r.warn ? `<div class="fc-note" style="color:var(--fc-warn);white-space:normal">Check: ${esc(r.warn)}</div>` : ''}</td></tr>`;
  }).join('');

  $('impBody').querySelectorAll('select[data-i]').forEach(sel => sel.onchange = () => {
    IMP_ROWS[+sel.dataset.i].empId = sel.value || null; renderImport();
  });
  $('impSummary').innerHTML =
    `<span class="fc-badge fc-badge--neutral">${IMP_ROWS.length} rows in file</span>` +
    `<span class="fc-badge fc-badge--ok">${cnt.ok} ready · ${money(sum)} THB</span>` +
    (cnt.pick ? `<span class="fc-badge fc-badge--warn">${cnt.pick} need an employee</span>` : '') +
    (cnt.dup ? `<span class="fc-badge fc-badge--info">${cnt.dup} already imported (skipped)</span>` : '');
  $('btnDoImport').disabled = cnt.ok === 0;
  $('btnDoImport').textContent = cnt.ok ? `Import ${cnt.ok} bill${cnt.ok === 1 ? '' : 's'}` : 'Nothing to import';
}

async function onPickFile(file){
  $('impResult').classList.add('hidden'); $('impPreview').classList.add('hidden'); $('impErr').textContent = '';
  if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = parseSummarized(wb, $('impMonth').value);
    if (!rows.length) throw new Error('No rows with amounts were found in the Summarized sheet.');

    const lk = await sb.rpc('fuel_employee_lookup');
    if (lk.error) throw new Error('Could not load the employee list: ' + lk.error.message);
    EMP = lk.data || [];
    rows.forEach(r => { r.cand = matchEmp(r.nameRaw); r.empId = r.cand.length === 1 ? r.cand[0].id : null; });

    const months = [...new Set(rows.map(r => r.billing_month))];
    const ex = await sb.from('fuel_bills').select('employee_id,billing_month').in('billing_month', months).limit(5000);
    if (ex.error) throw new Error('Could not check existing bills: ' + ex.error.message);
    IMP_EXISTING = new Set((ex.data || []).map(b => b.employee_id + '|' + b.billing_month));

    IMP_ROWS = rows;
    $('impPreview').classList.remove('hidden');
    renderImport();
  } catch (e) {
    IMP_ROWS = []; $('impErr').textContent = e.message || String(e);
  }
}

async function doImport(){
  const todo = IMP_ROWS.filter(r => rowStatus(r) === 'ok');
  if (!todo.length) return;
  const total = todo.reduce((s, r) => s + r.computed, 0);
  if (!confirm(`Import ${todo.length} bills totalling ${money(total)} THB?\nEmployees will see their own bills immediately, with status "Pending".`)) return;

  const { data: { user } } = await sb.auth.getUser();
  const batch = crypto.randomUUID();
  const recs = todo.map(r => ({
    employee_id: r.empId, bill_date: r.bill_date, billing_month: r.billing_month, cost_center: r.cc, bill_type: r.type,
    car_no: r.car_no, gasoline: r.g, tollgate: r.t, car_wash: r.w, parking_fee: r.p, adjustment: r.adj,
    remark: r.remark, created_by: user?.email || null, import_batch: batch,
  }));
  $('btnDoImport').disabled = true;
  let done = 0, err = '';
  for (let i = 0; i < recs.length; i += 200) {
    const { error } = await sb.from('fuel_bills').insert(recs.slice(i, i + 200));
    if (error) { err = error.message; break; }
    done += Math.min(200, recs.length - i);
  }
  IMP_LAST_BATCH = done ? batch : null;
  $('impPreview').classList.add('hidden');
  const box = $('impResult'); box.classList.remove('hidden');
  box.innerHTML = err
    ? `<span class="fc-badge fc-badge--danger">Stopped after ${done} of ${recs.length}</span>
       <span class="fc-note">${esc(err)}${done ? ' — undo this import, fix the problem, then import again so no data is left half-done.' : ''}</span>`
    : `<span class="fc-badge fc-badge--ok">Imported ${done} bill${done === 1 ? '' : 's'}</span>
       <span class="fc-note">Employees can see their bills now. Imported the wrong file? Undo removes only this batch's bills that are still Pending.</span>`;
  if (IMP_LAST_BATCH) box.insertAdjacentHTML('beforeend', '<button class="fc-btn" id="btnUndoImport">Undo this import</button>');
  const u = $('btnUndoImport');
  if (u) u.onclick = undoImport;
  $('impFile').value = '';
  IMP_ROWS = [];
}

async function undoImport(){
  if (!IMP_LAST_BATCH || !confirm('Delete the bills from this import (only those still Pending)?')) return;
  const { data, error } = await sb.from('fuel_bills').delete().eq('import_batch', IMP_LAST_BATCH).eq('pay_status', 'pending').select('id');
  if (error) return toast('Could not undo: ' + error.message, true);
  toast(`Removed ${data.length} bill${data.length === 1 ? '' : 's'}`);
  IMP_LAST_BATCH = null; $('impResult').classList.add('hidden');
}


/* ---------- downloadable Excel template (same layout the importer reads) ---------- */
function downloadTemplate(){
  if (typeof XLSX === 'undefined') return toast('The Excel library is not loaded yet — try again in a moment', true);
  const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today = new Date(), py = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear(), pm = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
  const last = new Date(py, pm + 1, 0).getDate();
  const adjPm = pm === 0 ? 11 : pm - 1, adjPy = pm === 0 ? py - 1 : py, adjLast = new Date(adjPy, adjPm + 1, 0).getDate();
  const title = (d1, d2, m, y) => `Summarized  of gasoline, tollgate and other expenses claim during ${d1}-${d2} ${MONTHS_EN[m]} ${y}`;

  const num = v => ({ t: 'n', v });
  const fml = (f, v) => ({ t: 'n', f, v });
  const HEAD = ['', '', 'No.', 'Name of staff', 'Cost Center', 'Type', 'Gasoline', 'Tollgate', 'Car wash', 'Parking Fee', 'Subtotal (auto)', 'adjustment', 'Total', '', 'Remark'];
  const block = (ttl, rows, startRow) => {              // startRow = 1-based Excel row of the title
    const out = [[ '', '', ttl ], [], HEAD];
    let r = startRow + 3, first = r;
    rows.forEach((x, i) => {
      const sub = x.g + x.t + x.w + x.p;
      out.push(['', '', i + 1, x.name, x.cc, x.type, num(x.g), num(x.t), x.w ? num(x.w) : '', x.p ? num(x.p) : '',
                fml(`SUM(G${r}:J${r})`, sub), x.adj ? num(x.adj) : '', fml(`K${r}+L${r}`, sub + x.adj), '', x.remark || '']);
      r++;
    });
    const tg = rows.reduce((s, x) => s + x.g, 0), tt = rows.reduce((s, x) => s + x.t, 0), tw = rows.reduce((s, x) => s + x.w, 0),
          tp = rows.reduce((s, x) => s + x.p, 0), ta = rows.reduce((s, x) => s + x.adj, 0);
    out.push(['', '', '', 'Total', '', '', fml(`SUM(G${first}:G${r - 1})`, tg), fml(`SUM(H${first}:H${r - 1})`, tt), fml(`SUM(I${first}:I${r - 1})`, tw), fml(`SUM(J${first}:J${r - 1})`, tp),
              fml(`SUM(K${first}:K${r - 1})`, tg + tt + tw + tp), fml(`SUM(L${first}:L${r - 1})`, ta), fml(`SUM(M${first}:M${r - 1})`, tg + tt + tw + tp + ta)]);
    return out;
  };

  const b1 = block(title(1, last, pm, py), [
    { name: 'Mr. Example1',    cc: 'FTH1SE2',  type: 'V', g: 4500.5, t: 1200, w: 0,   p: 0,  adj: 0,    remark: 'EXAMPLE — delete these rows and type your own' },
    { name: 'Mr. Example2 C.', cc: 'FTH1SA2',  type: 'S', g: 3200,   t: 800,  w: 140, p: 60, adj: 0,    remark: 'Same first name as someone else? add the first letter of the last name' },
    { name: 'Mr. Example3',    cc: 'FTH1SE31', type: 'V', g: 2800,   t: 0,    w: 0,   p: 0,  adj: -100, remark: 'adjustment can be negative' },
  ], 1);
  const gap = [[], []];
  const b2start = b1.length + gap.length + 1;
  const b2 = block(title(1, adjLast, adjPm, adjPy), [
    { name: 'Mr. Example1', cc: 'FTH1SE2', type: 'V', g: 300, t: 0, w: 0, p: 0, adj: 0, remark: 'OPTIONAL second block: a correction for an earlier month (delete the whole block if not needed)' },
  ], b2start);
  const ws1 = XLSX.utils.aoa_to_sheet([...b1, ...gap, ...b2]);
  ws1['!cols'] = [{ wch: 2 }, { wch: 2 }, { wch: 6 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 13 }, { wch: 3 }, { wch: 60 }];

  const ws2 = XLSX.utils.aoa_to_sheet([
    ['', 'Car plate list (optional) — used to fill the Car plate column'],
    [],
    ['', 'No.', 'No. car', 'Name of staff'],
    ['', 1, '1กข-1234', 'Mr. Example1'],
    ['', 2, '2ขค-5678', 'Mr. Example2 C.'],
    ['', 3, '', 'Mr. Example3'],
  ]);
  ws2['!cols'] = [{ wch: 2 }, { wch: 6 }, { wch: 14 }, { wch: 24 }];

  const ws0 = XLSX.utils.aoa_to_sheet([
    ['MyFTH — fuel bills import template'],
    [],
    ['How to use'],
    ['1.', 'Open the sheet "Summarized". Change the month in the title line (e.g. "during 1-31 March 2026") — it decides the billing month of every row below it.'],
    ['2.', 'One row per employee. Name of staff = "Mr./Ms. Firstname" as in the employee list. If two people share a first name add the first letter of the last name (e.g. "Mr. Chatchai C.").'],
    ['3.', 'Cost Center = the code from the cost center list (e.g. FTH1SA2). Type = S or V. Amounts are in THB; leave empty or 0 when there is none. Adjustment may be negative.'],
    ['4.', 'Subtotal and Total are formulas — you can overwrite them, the system recalculates from Gasoline + Tollgate + Car wash + Parking Fee + adjustment.'],
    ['5.', 'Keep the sheet names ("Summarized", and optionally "Calculation" for car plates) and keep the header row and the "Total" row of each block.'],
    ['6.', 'A second block (own title line, header row, rows and a Total row) can hold corrections for an earlier month. Delete it if you do not need it.'],
    ['7.', 'Delete the three EXAMPLE rows (names Example1-3) before importing. Then in MyFTH: Import bills -> choose this file -> review -> Import.'],
    [],
    ['Tip', 'Rows already imported for the same employee and month are skipped, so importing the same file twice is safe. "Undo this import" removes a batch that was just imported (only bills still Pending).'],
  ]);
  ws0['!cols'] = [{ wch: 6 }, { wch: 140 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws0, 'How to use');
  XLSX.utils.book_append_sheet(wb, ws1, 'Summarized');
  XLSX.utils.book_append_sheet(wb, ws2, 'Calculation');
  XLSX.writeFile(wb, 'MyFTH_fuel_bills_template.xlsx');
}

function wireImport(){
  $('btnImport').onclick = () => show('viewImport');
  $('btnTemplate').onclick = downloadTemplate;
  $('btnImpBack').onclick = async () => { show('viewMain'); await reloadBills(); };
  $('impFile').onchange = e => onPickFile(e.target.files[0]);
  $('impMonth').onchange = () => { if ($('impFile').files[0]) onPickFile($('impFile').files[0]); };
  $('btnDoImport').onclick = doImport;
}
