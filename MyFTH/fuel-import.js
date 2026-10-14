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
let IMP_CALC_OK = true;           // fuel_calc exists (017_fuel_calc.sql installed)
let IMP_CALC_EXISTING = new Set();   // "employee_id|billing_month" that already have calculation data


const norm = v => (typeof v === 'string' ? v.trim() : v);
function num(v){
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
const r2 = n => Math.round(n * 100) / 100;

// "row|col" (0-based, relative to the rows array of sheet_to_json) of every cell that holds an Excel error value
function errorCells(ws){
  const set = new Map();
  if (!ws || !ws['!ref']) return set;
  const r0 = XLSX.utils.decode_range(ws['!ref']).s.r;
  for (const a of Object.keys(ws)) {
    if (a[0] === '!') continue;
    const c = ws[a];
    if (c && c.t === 'e') { const p = XLSX.utils.decode_cell(a); set.set((p.r - r0) + '|' + p.c, c.w || '#ERROR'); }
  }
  return set;
}

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
    else if (k === 'car rental') col.cr = i;
    else if (k === 'f&d') col.fnd = i;
    else if (k === 'taxi') col.taxi = i;
    else if (k === 'hotel fee') col.hotel = i;
    else if (/^misc/.test(k) || /^other/.test(k)) col.misc = col.misc ?? i;
    else if (k === 'vat') col.vat = i;
    else if (k === 'wt') col.wt = i;
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

/* ---------- "Calculation" sheet(s): km / litres / actual fuel bill per car + the tax columns ---------- */
function parseCalculations(wb){
  const out = [];
  wb.SheetNames.filter(n => /calculation/i.test(n)).forEach(sn => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    const errs = errorCells(wb.Sheets[sn]);
    let month = null, col = null;
    rows.forEach((r, ri) => {
      const text = r.filter(v => typeof v === 'string').join(' ');
      const t = /(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
      if (t && MON[t[3].slice(0, 3).toLowerCase()] && /kilometer|period|during/i.test(text)) {
        month = t[4] + '-' + String(MON[t[3].slice(0, 3).toLowerCase()]).padStart(2, '0'); col = null; return;
      }
      if (r.some(v => typeof v === 'string' && /name of staff/i.test(v)) && r.some(v => typeof v === 'string' && /total\s+use/i.test(v))) {
        const c = {};
        r.forEach((v, i) => {
          if (typeof v !== 'string') return;
          const k = v.trim().toLowerCase().replace(/\s+/g, ' ');
          if (/name of staff/.test(k)) c.name = i; else if (/no\.?\s*car/.test(k)) c.car = i; else if (/^total use\s*\(km\)/.test(k)) c.a = i;
          else if (/^private\s*\(km\)/.test(k)) c.b = i; else if (/total actual litre/.test(k)) c.d = i; else if (/actual gasoline bill/.test(k)) c.e = i;
          else if (/transportation for tax \(km\)/.test(k)) c.tk = i; else if (/toll ?gate for tax/.test(k)) c.tt = i;
        });
        col = (c.name != null && c.a != null && c.d != null && c.e != null) ? c : null; return;
      }
      if (!col || !month) return;
      const nm = norm(r[col.name]); if (typeof nm !== 'string' || !nm) return;
      const a = num(r[col.a]), b = col.b != null ? num(r[col.b]) : 0, d = num(r[col.d]), e = num(r[col.e]);
      if ([col.a, col.b, col.d, col.e].some(c => c != null && errs.has(ri + '|' + c))) return;   // never save numbers computed from an error
      if (!a && !d && !e) return;
      const { f, rest } = splitName(nm);
      out.push({ month, key: f + '|' + rest, name: nm,
        car: col.car != null && typeof r[col.car] === 'string' && r[col.car].trim() ? r[col.car].trim() : null,
        odo: col.a > 0 && typeof r[col.a - 1] === 'number' ? r[col.a - 1] : null,
        a, b, d, e, tk: col.tk != null ? num(r[col.tk]) : 0, tt: col.tt != null ? num(r[col.tt]) : 0 });
    });
  });
  return out;
}
// same formulas as the sheet / fuel_calc_v:  h = (e/d)/(a/d);  claim = ROUND(h*(a-b));  private = ROUND(h*b)
function calcCompute(c){
  const h = c.d && c.a ? (c.e / c.d) / (c.a / c.d) : 0;
  const claim = r2(h * (c.a - c.b)), priv = r2(h * c.b);
  return { claim, priv, diff: r2(c.e - (claim + priv)) };
}

function parseSummarized(wb, fallbackMonth){
  const sn = wb.SheetNames.find(n => /summar/i.test(n));
  if (!sn) throw new Error('The "Summarized" sheet was not found — check that this is the monthly Gasoline file.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
  const errs = errorCells(wb.Sheets[sn]);
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
    // the other expense types (Car rental, F&D, Taxi, Hotel fee, Misc., Vat, WT) — each is added to the total, may be negative
    const ex = { car_rental: col.cr, fnd: col.fnd, taxi: col.taxi, hotel_fee: col.hotel, misc: col.misc, vat: col.vat, wt: col.wt };
    let o = 0; for (const k of Object.keys(ex)) { ex[k] = ex[k] != null ? num(r[ex[k]]) : 0; o += ex[k]; }
    if (!g && !tl && !w && !p && !adj && !Object.values(ex).some(Boolean)) return;
    const computed = r2(g + tl + w + p + o + adj);
    const errCols = [col.g, col.t, col.w, col.p, col.adj, col.cr, col.fnd, col.taxi, col.hotel, col.misc, col.vat, col.wt, col.total].filter(c => c != null && errs.has(i + '|' + c));
    const errText = errCols.length ? `Excel error ${errs.get(i + '|' + errCols[0])} in this row — fix the file (usually a deleted row in the Calculation sheet) and choose it again` : '';
    const totalFile = col.total != null && r[col.total] != null ? num(r[col.total]) : null;
    const { f, rest } = splitName(nm);
    const mm = String(b.m).padStart(2, '0');
    const typeCell = col.type != null ? norm(r[col.type]) : null;
    out.push({
      src: i + 1, nameRaw: nm,
      cc: col.cc != null ? (norm(r[col.cc]) || null) : null,
      type: typeof typeCell === 'string' && typeCell ? typeCell.toUpperCase() : null,
      g, t: tl, w, p, o, ex, adj, computed, err: errText,
      warn: totalFile != null && Math.abs(totalFile - computed) > 0.01 ? `file total ${money(totalFile)} differs from calculated ${money(computed)}` : '',
      remark: col.remark != null ? (norm(r[col.remark]) || null) : null,
      billing_month: `${b.y}-${mm}`, bill_date: `${b.y}-${mm}-${String(b.last).padStart(2, '0')}`,
      car_no: cars.get(f + '|' + rest) || null,
      cand: [], empId: null,
    });
  });
  // attach the calculation (same month + same name) to each bill row and cross-check the Gasoline amount
  const calcs = parseCalculations(wb);
  out.forEach(r => {
    const { f, rest } = splitName(r.nameRaw);
    const c = calcs.find(x => x.month === r.billing_month && x.key === f + '|' + rest);
    if (!c) return;
    r.calc = c; r.calcWarn = [];
    const k = calcCompute(c);
    if (Math.abs(k.claim - r.g) > 0.005) r.calcWarn.push(`Gasoline ${money(r.g)} differs from the calculation ${money(k.claim)}`);
    if (Math.abs(k.diff) > 0.005) r.calcWarn.push(`difference ${money(k.diff)} (should be 0.00)`);
  });
  return out;
}

const calcPending = r => !!(r.calc && !r.err && r.empId && IMP_CALC_OK && !IMP_CALC_EXISTING.has(r.empId + '|' + r.billing_month));

const carOf = r => r.car_no || ((EMP.find(e => e.id === r.empId) || {}).car_no) || null;   // plate from Excel, else the one saved on the employee

function rowStatus(r){
  if (r.err) return 'bad';
  if (!r.empId) return 'pick';
  if (IMP_EXISTING.has(r.empId + '|' + r.billing_month)) return 'dup';
  return 'ok';
}

function renderImport(){
  const cnt = { ok: 0, pick: 0, dup: 0, bad: 0 }; let sum = 0;
  IMP_ROWS.forEach(r => { const s = rowStatus(r); cnt[s]++; if (s === 'ok') sum += r.computed; });
  const calcN = IMP_ROWS.filter(calcPending).length, calcWarnN = IMP_ROWS.filter(r => r.calcWarn && r.calcWarn.length).length, hasCalc = IMP_ROWS.some(r => r.calc);
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
      : s === 'bad' ? '<span class="fc-badge fc-badge--danger">Excel error — not imported</span>'
      : s === 'dup' ? '<span class="fc-badge fc-badge--info">Already imported — skipped</span>'
      : `<span class="fc-badge fc-badge--warn">${r.cand.length > 1 ? 'Duplicate name — pick one' : 'Not found — pick one'}</span>`;
    const n = v => v ? money(v) : '<span class="dash">—</span>';
    return `<tr><td>${esc(r.billing_month)}</td><td>${esc(r.nameRaw)}</td><td>${who}</td>
      <td>${esc(r.cc || '-')}</td><td>${esc(r.type || '-')}</td><td>${esc(carOf(r) || '-')}</td>
      <td class="num">${n(r.g)}</td><td class="num">${n(r.t)}</td>
      <td class="num">${n(r.w)}</td><td class="num">${n(r.p)}</td><td class="num">${n(r.o)}</td><td class="num">${n(r.adj)}</td>
      <td class="num total">${money(r.computed)}</td>
      <td>${r.calc ? `${cK(r.calc.a)} km · ${cK(r.calc.d)} L` +
          (IMP_CALC_EXISTING.has(r.empId + '|' + r.billing_month) ? ' <span class="fc-badge fc-badge--neutral">stored</span>' : calcPending(r) ? ' <span class="fc-badge fc-badge--ok">will save</span>' : '') +
          (r.calcWarn.length ? `<div class="fc-note" style="color:var(--fc-warn);white-space:normal">Check: ${esc(r.calcWarn.join('; '))}</div>` : '')
        : '<span class="dash">—</span>'}</td>
      <td>${badge}${r.warn ? `<div class="fc-note" style="color:var(--fc-warn);white-space:normal">Check: ${esc(r.warn)}</div>` : ''}${r.err ? `<div class="fc-note" style="color:var(--fc-danger,#c0392b);white-space:normal">${esc(r.err)}</div>` : ''}</td></tr>`;
  }).join('');

  $('impBody').querySelectorAll('select[data-i]').forEach(sel => sel.onchange = () => {
    IMP_ROWS[+sel.dataset.i].empId = sel.value || null; renderImport();
  });
  $('impSummary').innerHTML =
    `<span class="fc-badge fc-badge--neutral">${IMP_ROWS.length} rows in file</span>` +
    `<span class="fc-badge fc-badge--ok">${cnt.ok} ready · ${money(sum)} THB</span>` +
    (cnt.pick ? `<span class="fc-badge fc-badge--warn">${cnt.pick} need an employee</span>` : '') +
    (cnt.dup ? `<span class="fc-badge fc-badge--info">${cnt.dup} already imported (skipped)</span>` : '') +
    (cnt.bad ? `<span class="fc-badge fc-badge--danger">${cnt.bad} with an Excel error (not imported)</span>` : '');
  if (hasCalc) {
    $('impSummary').insertAdjacentHTML('beforeend',
      !IMP_CALC_OK ? '<span class="fc-badge fc-badge--warn">Calculation data in the file will not be saved until IT installs 017_fuel_calc.sql</span>'
      : `<span class="fc-badge fc-badge--ok">${calcN} calculation${calcN === 1 ? '' : 's'} to save</span>` + (calcWarnN ? `<span class="fc-badge fc-badge--warn">${calcWarnN} to check</span>` : ''));
  }
  const cs = calcN ? ` + ${calcN} calculation${calcN === 1 ? '' : 's'}` : '';
  $('btnDoImport').disabled = cnt.ok === 0 && calcN === 0;
  $('btnDoImport').textContent = cnt.ok ? `Import ${cnt.ok} bill${cnt.ok === 1 ? '' : 's'}${cs}` : calcN ? `Save ${calcN} calculation${calcN === 1 ? '' : 's'} (bills already imported)` : 'Nothing to import';
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
    const ec = await sb.from('fuel_calc').select('employee_id,billing_month').in('billing_month', months).limit(5000);
    IMP_CALC_OK = !ec.error;                      // error = table not installed yet (017_fuel_calc.sql)
    IMP_CALC_EXISTING = new Set((ec.data || []).map(b => b.employee_id + '|' + b.billing_month));

    IMP_ROWS = rows;
    $('impPreview').classList.remove('hidden');
    renderImport();
  } catch (e) {
    IMP_ROWS = []; $('impErr').textContent = e.message || String(e);
  }
}

// crypto.randomUUID() exists only on https / localhost; getRandomValues also works on plain http (the LAN test copy)
function uuid4(){
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// never fail silently: any unexpected error is shown at the top of the page
async function doImport(){
  try { await doImportRun(); }
  catch (e) {
    console.error(e);
    $('btnDoImport').disabled = false;
    const box = $('impResult'); box.classList.remove('hidden');
    box.innerHTML = `<span class="fc-badge fc-badge--danger">Import failed</span> <span class="fc-note">${esc(e.message || String(e))}</span>`;
    toast('Import failed: ' + (e.message || e), true);
    box.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }
}

async function doImportRun(){
  const todo = IMP_ROWS.filter(r => rowStatus(r) === 'ok');
  const calcTodo = IMP_ROWS.filter(calcPending);
  if (!todo.length && !calcTodo.length) return;
  const total = todo.reduce((s, r) => s + r.computed, 0);
  const ask = (todo.length ? `Import ${todo.length} bill${todo.length === 1 ? '' : 's'} totalling ${money(total)} THB?\nEmployees will see their own bills immediately, with status "Pending".` : 'Save the calculation details only (the bills are already imported)?')
    + (calcTodo.length ? `\n\nThe calculation details of ${calcTodo.length} bill${calcTodo.length === 1 ? '' : 's'} (km, litres, fuel bill, tax columns) will be saved too.` : '');
  if (!confirm(ask)) return;

  const { data: { user } } = await sb.auth.getUser();
  const batch = uuid4();
  const withExtra = todo.some(r => Object.values(r.ex || {}).some(Boolean));     // expense types need 019_fuel_expense_types.sql
  const recs = todo.map(r => ({
    employee_id: r.empId, bill_date: r.bill_date, billing_month: r.billing_month, cost_center: r.cc, bill_type: r.type,
    car_no: carOf(r), gasoline: r.g, tollgate: r.t, car_wash: r.w, parking_fee: r.p, ...(withExtra ? r.ex : {}), adjustment: r.adj,
    remark: r.remark, created_by: user?.email || null, import_batch: batch,
  }));
  $('btnDoImport').disabled = true; $('btnDoImport').textContent = 'Importing… please wait';
  let done = 0, err = '';
  for (let i = 0; i < recs.length; i += 200) {
    const { error } = await sb.from('fuel_bills').insert(recs.slice(i, i + 200));
    if (error) { err = error.message; break; }
    done += Math.min(200, recs.length - i);
  }
  // calculation details: only inserted when none exist yet for that employee + month (never overwrites)
  let calcDone = 0, calcErr = '';
  if (!err && calcTodo.length) {
    const crecs = calcTodo.map(r => ({
      employee_id: r.empId, billing_month: r.billing_month, car_no: r.calc.car || carOf(r), odometer: r.calc.odo,
      total_km: r.calc.a, private_km: r.calc.b, litres: r.calc.d, fuel_amount: r.calc.e, tax_km: r.calc.tk, tax_toll: r.calc.tt,
      created_by: user?.email || null, import_batch: batch,
    }));
    for (let i = 0; i < crecs.length; i += 200) {
      const { error } = await sb.from('fuel_calc').upsert(crecs.slice(i, i + 200), { onConflict: 'employee_id,billing_month', ignoreDuplicates: true });
      if (error) { calcErr = error.message; break; }
      calcDone += Math.min(200, crecs.length - i);
    }
  }
  IMP_LAST_BATCH = (done || calcDone) ? batch : null;
  $('impPreview').classList.add('hidden');
  const box = $('impResult'); box.classList.remove('hidden');
  box.innerHTML = err
    ? `<span class="fc-badge fc-badge--danger">Stopped after ${done} of ${recs.length}</span>
       <span class="fc-note">${esc(err)}${done ? ' — undo this import, fix the problem, then import again so no data is left half-done.' : ''}</span>`
    : `<span class="fc-badge fc-badge--ok">${done ? `Imported ${done} bill${done === 1 ? '' : 's'}` : 'No new bills'}${calcDone ? ` · saved ${calcDone} calculation${calcDone === 1 ? '' : 's'}` : ''}</span>
       ${calcErr ? `<span class="fc-badge fc-badge--warn">Calculations not saved: ${esc(calcErr)}</span>` : ''}
       <span class="fc-note">Employees can see their bills now. Imported the wrong file? Undo removes only this batch's bills that are still Pending and its calculations.</span>`;
  if (IMP_LAST_BATCH) box.insertAdjacentHTML('beforeend', '<button class="fc-btn" id="btnUndoImport">Undo this import</button>');
  const u = $('btnUndoImport');
  if (u) u.onclick = undoImport;
  $('impFile').value = '';
  IMP_ROWS = [];
  // the result box is at the top of the page while the Import button was at the bottom: bring it into view and say so
  toast(err ? 'Import stopped — see the message at the top' : `Imported ${done} bill${done === 1 ? '' : 's'}${calcDone ? ' and saved ' + calcDone + ' calculation' + (calcDone === 1 ? '' : 's') : ''}`, !!err);
  box.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

async function undoImport(){
  if (!IMP_LAST_BATCH || !confirm('Delete the bills from this import (only those still Pending)?')) return;
  const { data, error } = await sb.from('fuel_bills').delete().eq('import_batch', IMP_LAST_BATCH).eq('pay_status', 'pending').select('id');
  if (error) return toast('Could not undo: ' + error.message, true);
  await sb.from('fuel_calc').delete().eq('import_batch', IMP_LAST_BATCH);   // calculation rows of the same import (ignored if 017 is not installed)
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
  const HEAD = ['', '', 'No.', 'Name of staff', 'Cost Center', 'Type', 'Gasoline', 'Tollgate', 'Car wash', 'Parking Fee', 'Subtotal (auto)',
                'Car rental', 'F&D', 'Taxi', 'Hotel fee', 'Misc.', 'Vat', 'adjustment', 'WT', 'Total', 'Transfer', 'Remark'];
  const XK = ['cr', 'fnd', 'taxi', 'hotel', 'misc', 'vat'];                       // columns L..Q ; R = adjustment ; S = WT
  const blank = v => v ? num(v) : '';
  const block = (ttl, rows, startRow) => {              // startRow = 1-based Excel row of the title
    const out = [[ '', '', ttl ], [], HEAD];
    let r = startRow + 3, first = r;
    rows.forEach((x, i) => {
      const sub = x.g + x.t + x.w + x.p;
      const ext = XK.reduce((s, k) => s + (x[k] || 0), 0) + x.adj + (x.wt || 0);
      out.push(['', '', i + 1, x.name, x.cc, x.type, num(x.g), num(x.t), blank(x.w), blank(x.p),
                fml(`SUM(G${r}:J${r})`, sub),
                ...XK.map(k => blank(x[k])), blank(x.adj), blank(x.wt),
                fml(`K${r}+SUM(L${r}:S${r})`, sub + ext), fml(`T${r}`, sub + ext), x.remark || '']);
      r++;
    });
    const sum = (col, f) => fml(`SUM(${col}${first}:${col}${r - 1})`, rows.reduce((s, x) => s + f(x), 0));
    const sub = x => x.g + x.t + x.w + x.p, ext = x => XK.reduce((s, k) => s + (x[k] || 0), 0) + x.adj + (x.wt || 0);
    out.push(['', '', '', 'Total', '', '', sum('G', x => x.g), sum('H', x => x.t), sum('I', x => x.w), sum('J', x => x.p), sum('K', sub),
              sum('L', x => x.cr || 0), sum('M', x => x.fnd || 0), sum('N', x => x.taxi || 0), sum('O', x => x.hotel || 0), sum('P', x => x.misc || 0), sum('Q', x => x.vat || 0),
              sum('R', x => x.adj), sum('S', x => x.wt || 0), sum('T', x => sub(x) + ext(x)), sum('U', x => sub(x) + ext(x))]);
    return out;
  };

  const b1 = block(title(1, last, pm, py), [
    { name: 'Mr. Example1',    cc: 'FTH1SE2',  type: 'V', g: 4500.5, t: 1200, w: 0,   p: 0,  adj: 0,    remark: 'EXAMPLE — delete these rows and type your own' },
    { name: 'Mr. Example2 C.', cc: 'FTH1SA2',  type: 'S', g: 3200,   t: 800,  w: 140, p: 60, adj: 0,    remark: 'Same first name as someone else? add the first letter of the last name' },
    { name: 'Mr. Example3',    cc: 'FTH1SE31', type: 'V', g: 2800,   t: 0,    w: 0,   p: 0,  fnd: 120, taxi: 80, adj: -100, remark: 'F&D / Taxi / Car rental / Hotel fee / Misc. / Vat / WT go in their own columns; adjustment can be negative' },
  ], 1);
  const gap = [[], []];
  const b2start = b1.length + gap.length + 1;
  const b2 = block(title(1, adjLast, adjPm, adjPy), [
    { name: 'Mr. Example1', cc: 'FTH1SE2', type: 'V', g: 300, t: 0, w: 0, p: 0, adj: 0, remark: 'OPTIONAL second block: a correction for an earlier month (delete the whole block if not needed)' },
  ], b2start);
  const ws1 = XLSX.utils.aoa_to_sheet([...b1, ...gap, ...b2]);
  ws1['!cols'] = [{ wch: 2 }, { wch: 2 }, { wch: 6 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 15 },
                  { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 9 }, { wch: 13 }, { wch: 13 }, { wch: 60 }];

  const ws2 = XLSX.utils.aoa_to_sheet([
    ['', `Kilometer use for the period of  1 - ${last} ${MONTHS_EN[pm]} ${py}`],
    ['', 'Fill in the white columns; the system works out claim km, price per litre, km per litre, cost per km, private use and the Gasoline claim. The same month must be in the Summarized title.'],
    [],
    ['', 'No.', 'No. car', 'Name of staff', 'Odometer (km)', 'Total  use (KM)', 'private (KM)', 'Total actual litre filling in', 'Actual gasoline bill', 'Transportation for tax (KM)', 'Toll gate for tax cal'],
    ['', 1, '1กข-1234', 'Mr. Example1',    52000, 1500, 0,   100,   4500.5,  400, 1200],
    ['', 2, '2ขค-5678', 'Mr. Example2 C.', 81000, 1000, 100, 80,    3555.56, 300, 800],
    ['', 3, '',         'Mr. Example3',    23000, 900,  0,   60,    2800,    0,   0],
  ]);
  ws2['!cols'] = [{ wch: 2 }, { wch: 6 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 20 }, { wch: 26 }, { wch: 22 }];

  const ws0 = XLSX.utils.aoa_to_sheet([
    ['MyFTH — fuel bills import template'],
    [],
    ['How to use'],
    ['1.', 'Open the sheet "Summarized". Change the month in the title line (e.g. "during 1-31 March 2026") — it decides the billing month of every row below it.'],
    ['2.', 'One row per employee. Name of staff = "Mr./Ms. Firstname" as in the employee list. If two people share a first name add the first letter of the last name (e.g. "Mr. Chatchai C.").'],
    ['3.', 'Cost Center = the code from the cost center list (e.g. FTH1SA2). Type = S or V. Amounts are in THB; leave empty or 0 when there is none. Columns L-S (Car rental, F&D, Taxi, Hotel fee, Misc., Vat, adjustment, WT) are optional; every amount is added to the Total and may be negative.'],
    ['4.', 'Subtotal and Total are formulas — you can overwrite them, the system recalculates from all the amount columns.'],
    ['5.', 'Keep the sheet names ("Summarized", and optionally "Calculation") and keep the header rows and the "Total" row of each block. The "Calculation" sheet holds km, litres, the actual fuel bill and the tax columns; its title line gives the month. When it is in the file the importer also saves those details and checks that Gasoline equals the calculated claim.'],
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
