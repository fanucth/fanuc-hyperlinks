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

function wireImport(){
  $('btnImport').onclick = () => show('viewImport');
  $('btnImpBack').onclick = async () => { show('viewMain'); await reloadBills(); };
  $('impFile').onchange = e => onPickFile(e.target.files[0]);
  $('impMonth').onchange = () => { if ($('impFile').files[0]) onPickFile($('impFile').files[0]); };
  $('btnDoImport').onclick = doImport;
}
