/* =====================================================================
   Payment Advice (fuel claim) — preview + print, same layout as the "pmt" sheet of the monthly Gasoline workbook
   - an employee prints their own bill (button on each row of "My fuel bills")
   - a fuel admin opens "Payment advice": pick a billing month, tick people, print selected / the whole month
   - document no.  PC-<year>/ G<month of the document date>-<No. of the bill in that billing month>   e.g. PC-2026/ G4-1
   - A4: two identical copies per sheet (top / bottom, cut line between) or one copy; text fields can be edited before printing
   Needs 016_payment_advice.sql (fuel_advice_rows / fuel_advice_months).
   Uses globals from index.html: sb, $, esc, money, dmy, toast, show
   ===================================================================== */
const ADV = { rows: [], list: [] };
const ADV_MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ADV_MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ADV_MISSING = 'Not available yet — IT needs to install 016_payment_advice.sql first.';

/* ---------- Thai baht in words (e.g. 8874.12 -> แปดพันแปดร้อยเจ็ดสิบสี่บาทสิบสองสตางค์) ---------- */
const TH_D = ['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'], TH_P = ['','สิบ','ร้อย','พัน','หมื่น','แสน'];
function thBelowMillion(s, higher){          // s: 1-6 digits, no leading zeros; higher = a larger group exists (… ล้าน เอ็ด)
  let out = ''; const L = s.length;
  for (let i = 0; i < L; i++) {
    const d = +s[i], pos = L - i - 1;
    if (!d) continue;
    if (pos === 0 && d === 1 && (L > 1 || higher)) out += 'เอ็ด';
    else if (pos === 1 && d === 2) out += 'ยี่สิบ';
    else if (pos === 1 && d === 1) out += 'สิบ';
    else out += TH_D[d] + TH_P[pos];
  }
  return out;
}
function thInt(n){
  let s = String(Math.floor(n)); if (/^0*$/.test(s)) return 'ศูนย์';
  const parts = []; while (s.length) { parts.unshift(s.slice(-6)); s = s.slice(0, -6); }
  return parts.map((g, i) => {
    const t = g.replace(/^0+/, ''); if (!t) return '';
    return thBelowMillion(t, i > 0) + (i < parts.length - 1 ? 'ล้าน' : '');
  }).join('');
}
function bahtText(amount){
  const v = Math.round(Math.abs(Number(amount) || 0) * 100);
  const baht = Math.floor(v / 100), satang = v % 100;
  if (!baht && !satang) return 'ศูนย์บาทถ้วน';
  return (baht ? thInt(baht) + 'บาท' : '') + (satang ? thInt(satang) + 'สตางค์' : 'ถ้วน');
}

/* ---------- document pieces ---------- */
const advToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const advDmy = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };          // 2026-10-15 -> 15/10/2026
function advParseDmy(t){                                                                          // "15/10/2026" -> "2026-10-15" (null when not a real date)
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(t || '').trim()); if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3], dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const advBkk = ts => new Date(ts).toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });          // approval time -> dd/mm/yyyy (Thai time)
const advDateTxt = iso => advDmy(iso);                                                           // printed date: dd/mm/yyyy
function advPeriod(bm){
  if (!/^\d{4}-\d{2}$/.test(bm || '')) return 'Gasoline, tollgate and other expenses claim';
  const [y, m] = bm.split('-').map(Number), last = new Date(y, m, 0).getDate();
  return `Gasoline, tollgate and other expenses claim during 1-${last} ${ADV_MON[m - 1]} ${y}`;
}
const advAmt = n => Number(n) ? money(n) : '-';
const advCe = (k, v, cls) => `<span class="adv-ce ${cls || ''}" contenteditable="true" spellcheck="false" data-k="${k}">${esc(v)}</span>`;

function advCopy(r, ctx){
  const N = k => Number(r[k] || 0);                       // 018/019 columns are undefined until their SQL is installed
  // printed lines: the four fixed ones, then the other types only when they have an amount ("Adj." is the adjustment column)
  const items = [['Toll gate fee', N('tollgate')], ['Car wash', N('car_wash')], ['Car parking', N('parking_fee')]]
    .concat([['Car rental', N('car_rental')], ['F&D', N('fnd')], ['Taxi', N('taxi')], ['Hotel fee', N('hotel_fee')], ['Misc.', N('misc')], ['Adj.', N('adjustment')]].filter(x => x[1] !== 0));
  const lineSum = N('gasoline') + items.reduce((s, x) => s + x[1], 0);
  const vat = N('vat'), wt = N('wt');
  const total = Number(r.total);
  const who = `${r.fname || ''} ${r.lname || ''}`.trim() + (r.employee_no ? ` (${r.employee_no})` : '');
  const line = (label, v, last) => `<tr class="adv-line${last ? ' adv-last' : ''}"><td>${label}</td><td class="c">-</td>
      <td class="n">${advAmt(v)}</td><td class="c">-</td><td class="n">${advAmt(v)}</td><td class="c">-</td></tr>`;
  return `<div class="adv-copy">
    <div class="adv-head">
      <div class="adv-co">
        <img class="adv-logo" src="fanuc-thai-logo.png" alt="FANUC THAI LIMITED">
        <div class="adv-th">บริษัท ฟานัคไทย จำกัด</div>
        <div class="adv-addr">1301 Pattanakarn Road, Kwaeng Suanluang, Khet Suanluang,<br>Bangkok 10250 Tel : 02-714-6111 Fax : 02-714-6120</div>
      </div>
      <div class="adv-meta">
        <div class="adv-title">PAYMENT ADVICE</div>
        <div class="adv-mrow"><span>No. / เลขที่ :</span>${advCe('no', ctx.docNo, 'adv-box')}</div>
        <div class="adv-mrow"><span>Date / วันที่ :</span>${advCe('date', ctx.dateTxt, 'adv-box')}</div>
      </div>
    </div>
    <div class="adv-to"><b>PAID TO :</b> ${advCe('to', who, 'adv-line-in')}</div>
    <table class="adv-tbl">
      <thead><tr><th class="l" style="width:46%">Description</th><th style="width:8%">inv.</th><th class="r" style="width:13%">AMOUNT</th>
        <th class="r" style="width:10%">VAT</th><th class="r" style="width:14%">Net Amount</th><th class="r" style="width:9%">W/T</th></tr></thead>
      <tbody>
        <tr><td colspan="6" class="adv-period">${advCe('period', advPeriod(r.billing_month))}</td></tr>
        <tr class="adv-line"><td>Gasoline fee for car no. ${advCe('car', r.car_no || '', 'adv-dash')}</td><td class="c">-</td>
          <td class="n">${advAmt(r.gasoline)}</td><td class="c">-</td><td class="n">${advAmt(r.gasoline)}</td><td class="c">-</td></tr>
        ${items.map((x, k) => line(x[0], x[1], k === items.length - 1)).join('')}
        <tr><td colspan="2" class="r adv-tp">Total amount</td><td class="n adv-tp adv-ul">${money(lineSum)}</td><td class="n adv-tp">${advAmt(vat)}</td><td class="n adv-tp adv-ul"><b>${money(lineSum + vat)}</b></td><td class="n adv-tp">${advAmt(wt)}</td></tr>
        <tr><td colspan="4" class="r adv-tp adv-mut">Withholding tax adjustment</td><td class="n adv-tp adv-ul">${money(wt)}</td><td></td></tr>
        <tr><td colspan="4" class="r adv-tp"><b>Total amount</b></td><td class="n adv-tp adv-dbl"><b>${money(total)}</b></td><td></td></tr>
      </tbody>
    </table>
    <div class="adv-baht">
      <div class="adv-baht-l"><u>The sum of Thai Baht</u><br><b>จำนวนเงินบาท :</b></div>
      ${advCe('baht', `( ${bahtText(total)} )`, 'adv-bahtbox')}
    </div>
    <div class="adv-sign">
      <div>Prepare by ${advCe('prep', ctx.prep, 'adv-sig')}</div>
      <div class="adv-hr"><div>HR Div. <span class="adv-sig adv-hrline">${ctx.appr && ctx.appr.signature ? `<img class="adv-sigpic" src="${esc(ctx.appr.signature)}" alt="">` : ''}</span></div>
        ${ctx.appr ? `<div class="adv-signame">${esc(ctx.appr.approver_name)} · ${esc(advBkk(ctx.appr.approved_at))}</div>` : ''}</div>
    </div>
  </div>`;
}

// the lower half of a sheet: the calculation table of the "Calculation" sheet (litres, amount on bill, averages, use / claim / total)
// and, for fuel admins only, the "Transportation for Tax calculation" lines (the database returns the tax columns only to fuel admins)
function advCalcBlock(c, r){
  const cn = (v, d) => v == null ? '—' : cN(v, d), km = v => v == null ? '—' : cK(v);
  const who = `${r.fname || ''} ${r.lname || ''}`.trim() + (r.employee_no ? ` (${r.employee_no})` : '');
  const taxed = c.tax_km != null || c.tax_total != null;
  const diff = Math.abs(Number(c.diff)) > 0.005 ? cn(c.diff) : '-';
  return `<div class="adv-copy adv-calcbox">
    <div class="adv-ctitle"><b>Gasoline calculation</b> — ${esc(who)} · billing month ${esc(r.billing_month || '')}${c.car_no ? ' · car ' + esc(c.car_no) : ''}</div>
    <table class="adv-ctbl">
      <thead><tr><th class="l"></th><th>Liter</th><th>amount on bill</th><th>Average cost /litre</th><th>Average KM /litre</th><th>Average cost /km</th><th></th><th>use</th><th>claim</th><th>Total</th><th></th></tr></thead>
      <tbody>
        <tr class="adv-ctot"><td class="l">Total</td><td>${cn(c.litres)}</td><td>${cn(c.fuel_amount)}</td><td>${cn(c.price_per_litre)}</td><td>${cn(c.km_per_litre)}</td><td>${cn(c.cost_per_km, 4)}</td>
          <td class="k">KM</td><td>${km(c.private_km)}</td><td>${km(c.claim_km)}</td><td>${km(c.total_km)}</td><td></td></tr>
        <tr class="adv-cdot"><td colspan="6"></td><td class="k">amount(Bht)</td><td>${cn(c.private_amount)}</td><td>${cn(c.claim_amount)}</td><td>${cn(c.fuel_amount)}</td><td class="mut">${diff}</td></tr>
      </tbody>
    </table>
    ${taxed ? `<table class="adv-ctbl adv-ctax">
      <thead><tr><th class="l" style="width:46%">Transportation for Tax calculation</th><th></th><th>Gasoline</th><th>Tollgate</th><th>Total</th></tr></thead>
      <tbody>
        <tr><td></td><td class="k">KM</td><td>${km(c.tax_km)}</td><td></td><td></td></tr>
        <tr class="adv-cdot"><td></td><td class="k">amount(Bht)</td><td>${cn(c.tax_km_amount)}</td><td>${cn(c.tax_toll)}</td><td>${cn(c.tax_total)}</td></tr>
      </tbody></table>` : ''}
  </div>`;
}

function advRender(){
  const mode = $('advCopies').value;                     // 'calc' = advice + calculation (when the bill has one, else two copies) · '2' = two copies · '1' = one copy
  const iso = advParseDmy($('advDate').value) || advToday(), [dy, dm] = iso.split('-');
  const prep = $('advPrep').value;
  $('advPages').innerHTML = ADV.rows.map((r, i) => {
    const bm = /^(\d{4})-(\d{2})$/.exec(r.billing_month || '');           // PC-<year>/ G<billing month>-<No.>  e.g. September 2026 -> PC-2026/ G9-5
    const one = advCopy(r, { docNo: bm ? `PC-${bm[1]}/ G${+bm[2]}-${r.seq}` : `PC-${dy}/ G${+dm}-${r.seq}`, dateTxt: advDateTxt(iso), prep, appr: ADV.sig ? ADV.sig.get(r.id) : null });
    const c = CALCS.get(r.id), withCalc = mode === 'calc' && !!c;
    const lower = withCalc ? advCalcBlock(c, r) : (mode === '1' ? '' : one);
    return `<div class="adv-sheet${lower ? '' : ' one'}" data-i="${i}" data-calc="${withCalc ? 1 : 0}">${one}${lower ? '<div class="adv-cut"></div>' + lower : ''}</div>`;
  }).join('');
  let big = 0;
  if (mode !== '1' && !$('advModal').classList.contains('hidden')) {
    document.querySelectorAll('#advPages .adv-sheet:not(.one)').forEach(sh => {
      const cp = sh.querySelector('.adv-copy');
      if (cp.scrollHeight > cp.clientHeight + 1) {         // too many lines for half a sheet: the advice takes the whole sheet, the calculation goes to the next sheet
        sh.classList.add('one'); sh.querySelector('.adv-cut').remove(); sh.querySelectorAll('.adv-copy')[1].remove(); big++;
        if (sh.dataset.calc === '1') { const r = ADV.rows[+sh.dataset.i]; sh.insertAdjacentHTML('afterend', `<div class="adv-sheet one">${advCalcBlock(CALCS.get(r.id), r)}</div>`); }
      }
    });
  }
  const sheets = document.querySelectorAll('#advPages .adv-sheet').length || ADV.rows.length;
  $('advInfo').textContent = `${ADV.rows.length} document${ADV.rows.length === 1 ? '' : 's'} · ${sheets} A4 sheet${sheets === 1 ? '' : 's'}` + (big ? ` · ${big} with many lines use a whole sheet` : '');
}

// "Prepare by": first names of the active employees of the General Admin department (fuel admins can read the list); anyone else keeps the remembered name
async function advPrepNames(){
  if (ADV.prepNames) return ADV.prepNames;
  let names = [];
  try {
    const { data, error } = await sb.rpc('fuel_employee_lookup');
    if (!error) names = [...new Set((data || []).filter(e => /^\s*general\s+admin\s*$/i.test(e.department || '')).map(e => String(e.fname || '').trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y));
  } catch { /* not a fuel admin */ }
  return (ADV.prepNames = names);
}
async function advFillPrep(){
  const opts = (await advPrepNames()).slice();
  let saved = ''; try { saved = localStorage.getItem('fth_adv_prep') || ''; } catch {}
  const want = saved || (opts.includes('Butchadeekarn') ? 'Butchadeekarn' : opts[0] || 'Butchadeekarn');
  if (!opts.includes(want)) opts.unshift(want);
  $('advPrep').innerHTML = opts.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  $('advPrep').value = want;
}

// who approved which bill, with the signature image (024_advice_approval.sql); a bill without approval prints with an empty HR Div. line
async function advLoadSigs(rows){
  ADV.sig = new Map();
  try {
    const { data, error } = await sb.rpc('fuel_advice_approvals', { p_ids: rows.map(r => r.id), p_sig: true });
    if (!error) (data || []).forEach(a => ADV.sig.set(a.bill_id, a));
  } catch { /* 024 not installed yet: no signatures */ }
}

async function advOpen(rows, own){
  if (!rows.length) { toast('Nothing to print', true); return; }
  ADV.rows = rows; ADV.own = !!own;
  $('advMail').classList.toggle('hidden', !(own && rows.length === 1));
  if (!advParseDmy($('advDate').value)) $('advDate').value = advDmy(advToday());
  ADV.lastDate = $('advDate').value;
  $('advModal').classList.remove('hidden');
  await Promise.all([advFillPrep(), advLoadSigs(rows), loadCalcs(rows.map(r => r.id).filter(id => !CALCS.has(id)))]);   // calculation details for the lower half of the sheet
  advRender();
  $('advPages').scrollTop = 0;
}
function advClose(){ $('advModal').classList.add('hidden'); document.body.classList.remove('adv-print'); }

async function advFetch(args){
  const { data, error } = await sb.rpc('fuel_advice_rows', args);
  if (error) {
    toast(/fuel_advice|PGRST202|could not find the function/i.test((error.message || '') + (error.code || '')) ? ADV_MISSING : 'Could not load the bill: ' + error.message, true);
    return null;
  }
  return data || [];
}
async function adviceForIds(ids){
  const rows = await advFetch({ p_month: null, p_ids: ids });
  if (rows && !rows.length) { toast('This payment advice is not available yet', true); return; }       // a month the fuel team has not opened to employees
  if (rows) advOpen(rows, true);
}

/* ---------- email my own payment advice (Edge Function send-advice; always goes to the signed-in person's own address) ---------- */
let ADV_MAILING = false;
async function advMailMe(id){
  if (ADV_MAILING) return;
  ADV_MAILING = true; toast('Sending…');
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_CONFIG.url}/functions/v1/send-advice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_CONFIG.anonKey, Authorization: 'Bearer ' + (session?.access_token || '') },
      body: JSON.stringify({ id, lang: window.FTHLang ? FTHLang.lang : 'th' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) toast('Payment advice sent to ' + data.to + (data.pdf === false ? ' (the PDF could not be attached)' : ', with the PDF'));
    else if (res.status === 404 && !data.error) toast('Not available yet — IT needs to deploy the send-advice function.', true);
    else toast('Could not send: ' + (data.error || res.status), true);
  } catch (e) {
    toast('Could not send: ' + (e.message || e), true);
  } finally { ADV_MAILING = false; }
}

/* ---------- which months employees may print / email (023_advice_release.sql) ---------- */
// FUEL_REL.on = false while 023 is not installed (then nothing is hidden); FUEL_REL.months = months the fuel team has opened
const FUEL_REL = { on: false, months: new Map() };
async function loadRelease(){
  try {
    const { data, error } = await sb.from('fuel_advice_release').select('billing_month,released');
    FUEL_REL.on = !error;
    FUEL_REL.months = new Map((data || []).map(x => [x.billing_month, x.released === true]));
  } catch { FUEL_REL.on = false; }
}
const advReleased = m => !FUEL_REL.on || IS_FUEL_ADMIN || FUEL_REL.months.get(m) === true;      // may this person print / email the bill of month m?

function advRelPaint(){
  const m = $('advMonth').value, box = $('advRel');
  if (!m || !FUEL_REL.on) { box.classList.add('hidden'); return; }
  const on = FUEL_REL.months.get(m) === true;
  box.classList.remove('hidden');
  $('advRelState').innerHTML = on ? '<span class="fc-badge fc-badge--ok">Employees can print and email</span>' : '<span class="fc-badge fc-badge--neutral">Hidden from employees</span>';
  $('advRelBtn').textContent = on ? 'Hold from employees' : 'Open to employees';
}
async function advRelToggle(){
  const m = $('advMonth').value; if (!m) return;
  const on = FUEL_REL.months.get(m) === true;
  if (!confirm(on ? `Hold ${m} from employees? Their Print and Email buttons disappear for this month.`
                  : `Open ${m} to employees? They will be able to print and email their own payment advice for this month.`)) return;
  const { error } = await sb.rpc('fuel_advice_set_release', { p_month: m, p_released: !on });
  if (error) return toast('Could not update: ' + error.message, true);
  FUEL_REL.months.set(m, !on); advRelPaint();
  toast(on ? `${m} is hidden from employees` : `${m} is open to employees`);
}

/* ---------- fuel admin: pick a month, tick people ---------- */
async function advLoadMonths(){
  const { data, error } = await sb.rpc('fuel_advice_months');
  if (error) {
    $('advMonth').innerHTML = '<option value="">—</option>'; $('advBody').innerHTML = '';
    $('advStatus').textContent = /fuel_advice|PGRST202|could not find the function/i.test((error.message || '') + (error.code || '')) ? ADV_MISSING : 'Could not load: ' + error.message;
    return;
  }
  const keep = $('advMonth').value;
  $('advMonth').innerHTML = (data || []).map(m => `<option value="${esc(m.billing_month)}">${esc(m.billing_month)} (${m.bills})</option>`).join('') || '<option value="">No bills yet</option>';
  if (keep && (data || []).some(m => m.billing_month === keep)) $('advMonth').value = keep;
  await advLoadList();
}
async function advLoadList(){
  const m = $('advMonth').value;
  await loadRelease(); advRelPaint();
  ADV.list = m ? (await advFetch({ p_month: m, p_ids: null })) || [] : [];
  ADV.paid = new Map();
  if (m) { const pr = await sb.from('fuel_bills').select('id,paid_at').eq('billing_month', m).limit(5000); (pr.data || []).forEach(x => ADV.paid.set(x.id, x.paid_at)); }
  await Promise.all([loadCalcs(ADV.list.map(r => r.id)), advLoadApprovals()]);
  advFillDept();
  advRenderList();
}
async function advLoadApprovals(){
  ADV.appr = new Map();
  if (!ADV.list.length) return;
  try {
    const { data, error } = await sb.rpc('fuel_advice_approvals', { p_ids: ADV.list.map(r => r.id), p_sig: false });
    if (!error) (data || []).forEach(a => ADV.appr.set(a.bill_id, a));
  } catch { /* 024 not installed yet */ }
}
// department filter: the departments that really occur in this billing month (with the number of bills)
function advFillDept(){
  const cur = $('advDept').value, dep = r => (r.department || '').trim();
  const ds = [...new Set(ADV.list.map(dep).filter(Boolean))].sort((x, y) => x.localeCompare(y));
  $('advDept').innerHTML = '<option value="">All departments</option>' + ds.map(d => `<option value="${esc(d)}">${esc(d)} (${ADV.list.filter(r => dep(r) === d).length})</option>`).join('');
  $('advDept').value = ds.includes(cur) ? cur : '';
}
function advCalcCell(r){
  const c = CALCS.get(r.id); if (!c) return '<span class="dash">—</span>';
  const issues = calcIssues(c);
  return `<button type="button" class="bar-btn" data-calc="${r.id}" data-who="${esc(r.fname)} ${esc(r.lname)}" title="Show the calculation">${cK(c.total_km)} km · ${cK(c.litres)} L</button>` +
    (issues.length ? ` <span class="fc-badge fc-badge--warn" title="${esc(issues.join('; '))}">Check</span>` : '');
}
const advApprCell = r => {
  const a = ADV.appr && ADV.appr.get(r.id);
  return a ? `<span class="fc-badge fc-badge--ok" title="${esc(a.approver_name)} · ${esc(advBkk(a.approved_at))}">Approved</span>` : '<span class="dash">—</span>';
};
function advRenderList(){
  const q = $('advSearch').value.trim().toLowerCase();
  const pay = $('advPay').value, dept = $('advDept').value;
  const shown = ADV.list.filter(r => (!dept || (r.department || '').trim() === dept) && (!q || `${r.fname} ${r.lname} ${r.employee_no} ${r.department} ${r.car_no}`.toLowerCase().includes(q)) && (!pay || (pay === 'paid') === (r.pay_status === 'paid')));
  const num = v => Number(v) ? money(v) : '<span class="dash">—</span>';
  ADV.shown = shown;                                            // used by Export Excel
  $('advBody').innerHTML = shown.length ? shown.map(r => `<tr>
      <td><input type="checkbox" class="advTick" data-id="${r.id}" aria-label="Select ${esc(r.fname)} ${esc(r.lname)}"></td>
      <td>${r.seq}</td>
      <td><strong>${esc(r.fname)} ${esc(r.lname)}</strong><div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(r.employee_no || '')}</div></td>
      <td>${esc(r.department || '—')}</td><td>${esc(r.car_no || '—')}</td>
      <td class="num">${num(r.gasoline)}</td><td class="num">${num(r.tollgate)}</td><td class="num">${num(r.car_wash)}</td>
      <td class="num">${num(r.parking_fee)}</td><td class="num" title="${esc(fuelExtraTip(r))}">${num(fuelExtraSum(r))}</td><td class="num">${num(r.adjustment)}</td>
      <td class="num total">${money(r.total)}</td>
      <td>${advCalcCell(r)}</td>
      <td>${advApprCell(r)}</td>
      <td>${r.pay_status === 'paid' ? `<span class="fc-badge fc-badge--ok">Approved, awaiting payment${ADV.paid && ADV.paid.get(r.id) ? ' · ' + dmy(ADV.paid.get(r.id)) : ''}</span>` : '<span class="fc-badge fc-badge--warn">Pending</span>'}</td></tr>`).join('')
    : `<tr><td colspan="15"><div class="fc-empty"><div class="fc-empty__title">${ADV.list.length ? 'No one matches' : 'No bills in this month'}</div></div></td></tr>`;
  $('advStatus').textContent = ADV.list.length ? `${shown.length} of ${ADV.list.length} bills` : '';
  $('advTickAll').checked = false; advCount();
}
function advTicked(){ return [...document.querySelectorAll('.advTick:checked')].map(x => +x.dataset.id); }
function advCount(){
  const n = advTicked().length;
  $('advPrintSel').disabled = !n; $('advPrintSel').querySelector('span').textContent = n ? `Print selected (${n})` : 'Print selected';
  $('advMarkPaid').disabled = !n; $('advMarkPaid').querySelector('span').textContent = n ? `Mark as approved, awaiting payment (${n})` : 'Mark as approved, awaiting payment';
  $('advApprove').disabled = !n; $('advUnapprove').disabled = !n;
  $('advApprove').querySelector('span').textContent = n ? `Approve (${n})` : 'Approve'; $('advUnapprove').querySelector('span').textContent = n ? `Withdraw approval (${n})` : 'Withdraw approval';
  $('advMarkPending').disabled = !n; $('advMarkPending').querySelector('span').textContent = n ? `Mark as pending (${n})` : 'Mark as pending';
}

// calendar dialog for the payment date (returns yyyy-mm-dd, or null when cancelled)
function advAskPayDate(info){
  return new Promise(resolve => {
    $('payDateInfo').textContent = info;
    $('payDateIn').value = advToday();
    $('payDateModal').classList.remove('hidden');
    const done = v => { $('payDateModal').classList.add('hidden'); $('payDateForm').onsubmit = null; $('payDateCancel').onclick = null; resolve(v); };
    $('payDateForm').onsubmit = e => { e.preventDefault(); const v = $('payDateIn').value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) done(v); };
    $('payDateCancel').onclick = () => done(null);
    setTimeout(() => { try { $('payDateIn').focus(); } catch {} }, 0);
  });
}

// the approver (department General Admin, title mgr): approve the ticked bills = the signature appears in "HR Div."
async function advApproveSel(on){
  const ids = advTicked(); if (!ids.length) return;
  const plural = ids.length === 1 ? '' : 's';
  if (!confirm(on ? `Approve ${ids.length} payment advice${plural}? Your signature will appear in the HR Div. box.` : `Withdraw the approval of ${ids.length} payment advice${plural}?`)) return;
  const { data, error } = await sb.rpc('fuel_advice_approve', { p_ids: ids, p_approve: on });
  if (error) return toast('Could not update: ' + error.message, true);
  toast(on ? `${data} payment advice${data === 1 ? '' : 's'} approved` : `Approval withdrawn from ${data} payment advice${data === 1 ? '' : 's'}`);
  await advLoadApprovals(); advRenderList();
}
async function advLoadMySig(){
  const box = $('advSigBox');
  box.classList.toggle('hidden', !IS_APPROVER);
  ['advApprove', 'advUnapprove'].forEach(i => $(i).classList.toggle('hidden', !IS_APPROVER));
  if (!IS_APPROVER) return;
  const { data } = await sb.rpc('fuel_signature_get');
  ADV.mySig = data || null;
  $('advSigImg').src = ADV.mySig || ''; $('advSigImg').classList.toggle('hidden', !ADV.mySig);
  $('advSigNone').classList.toggle('hidden', !!ADV.mySig);
  $('advSigRemove').classList.toggle('hidden', !ADV.mySig);
}
// a photo / scan of the signature -> small PNG with a transparent background, trimmed to the ink
function advSigFromFile(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be read. Try another file.')); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 900 / img.width), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h), px = d.data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2], a = px[i + 3] / 255;
        const alpha = a * (lum >= 235 ? 0 : lum <= 170 ? 1 : (235 - lum) / 65);          // white paper -> transparent, ink stays
        px[i + 3] = Math.round(alpha * 255);
        if (alpha > 0.15) { const p = i / 4, x = p % w, y = (p - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) return reject(new Error('No signature found in this image — use dark ink on white paper.'));
      g.putImageData(d, 0, 0);
      const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1, s = Math.min(1, 480 / cw, 200 / ch), o = document.createElement('canvas');
      o.width = Math.max(1, Math.round(cw * s)); o.height = Math.max(1, Math.round(ch * s));
      o.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, o.width, o.height);
      resolve(o.toDataURL('image/png'));
    };
    img.src = url;
  });
}
async function advSigPick(file){
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('Please choose an image file (JPG, PNG or WebP).', true);
  try {
    const png = await advSigFromFile(file);
    const { error } = await sb.rpc('fuel_signature_set', { p_image: png });
    if (error) return toast('Could not save: ' + error.message, true);
    toast('Signature saved'); await advLoadMySig();
  } catch (e) { toast(e.message || String(e), true); }
}
async function advSigRemove(){
  if (!confirm('Remove your signature? Documents you approved will print without it.')) return;
  const { error } = await sb.rpc('fuel_signature_set', { p_image: null });
  if (error) return toast('Could not save: ' + error.message, true);
  toast('Signature removed'); await advLoadMySig();
}

// payment status of the ticked bills (a fuel admin may change it; the date is the day the money was transferred)
async function advMark(paid){
  const ids = advTicked(); if (!ids.length) return;
  const plural = ids.length === 1 ? '' : 's';
  let iso = null;
  if (paid) {
    iso = await advAskPayDate(`Mark ${ids.length} bill${plural} as approved, awaiting payment.`);
    if (!iso) return;
  } else if (!confirm(`Mark ${ids.length} bill${plural} as pending again?`)) return;
  const { data: { user } } = await sb.auth.getUser();
  const patch = paid ? { pay_status: 'paid', paid_at: `${iso}T12:00:00+07:00`, paid_by: user?.email || null } : { pay_status: 'pending', paid_at: null, paid_by: null };
  const { data, error } = await sb.from('fuel_bills').update(patch).in('id', ids).select('id');
  if (error) return toast('Could not update: ' + error.message, true);
  toast(`${data.length} bill${data.length === 1 ? '' : 's'} marked as ${paid ? 'approved, awaiting payment' : 'pending'}`);
  await advLoadList();
}

function wireAdvice(){
  $('btnAdvice').onclick = async () => { show('viewAdvice'); await advLoadMonths(); await advLoadMySig(); };
  $('btnAdvBack').onclick = () => show('viewMain');
  $('advMonth').onchange = advLoadList;
  $('advRelBtn').onclick = advRelToggle;
  $('advSearch').oninput = advRenderList;
  $('advTickAll').onchange = e => { document.querySelectorAll('.advTick').forEach(x => { x.checked = e.target.checked; }); advCount(); };
  $('advBody').onchange = e => { if (e.target.classList.contains('advTick')) advCount(); };
  $('advPay').onchange = advRenderList;
  $('advDept').onchange = advRenderList;
  $('advReset').onclick = async () => {
    $('advSearch').value = ''; $('advPay').value = ''; $('advDept').value = '';
    const first = $('advMonth').options[0] ? $('advMonth').options[0].value : '';
    if (first && $('advMonth').value !== first) { $('advMonth').value = first; await advLoadList(); } else advRenderList();   // advRenderList also clears the ticks
  };
  $('advMarkPaid').onclick = () => advMark(true);
  $('advMarkPending').onclick = () => advMark(false);
  $('advApprove').onclick = () => advApproveSel(true);
  $('advUnapprove').onclick = () => advApproveSel(false);
  $('advSigPick').onclick = () => $('advSigFile').click();
  $('advSigFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; advSigPick(f); };
  $('advSigRemove').onclick = advSigRemove;
  $('advPrintSel').onclick = () => { const ids = new Set(advTicked()); advOpen(ADV.list.filter(r => ids.has(r.id))); };
  $('advPrintAll').onclick = () => advOpen(ADV.list);
  // my own bills (profile page)
  $('fuelBody').addEventListener('click', e => {
    const b = e.target.closest('[data-adv]'); if (b) return adviceForIds([+b.dataset.adv]);
    const m = e.target.closest('[data-mail]'); if (m) advMailMe(+m.dataset.mail);
  });
  $('advMail').onclick = () => { if (ADV.own && ADV.rows.length === 1) advMailMe(ADV.rows[0].id); };
  // preview dialog
  $('advCopies').onchange = advRender;
  $('advDate').oninput = e => {                                   // type digits only, slashes are added: 15102026 -> 15/10/2026
    const d = e.target.value.replace(/\D/g, '').slice(0, 8);
    e.target.value = d.length > 4 ? d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4) : d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  };
  $('advDate').onchange = () => {
    if (!advParseDmy($('advDate').value)) { toast('Use the date format dd/mm/yyyy', true); $('advDate').value = ADV.lastDate || advDmy(advToday()); return; }
    ADV.lastDate = $('advDate').value; advRender();
  };
  $('advPrep').onchange = () => { try { localStorage.setItem('fth_adv_prep', $('advPrep').value); } catch {} advRender(); };
  $('advClose').onclick = advClose;
  $('advPrint').onclick = () => { document.body.classList.add('adv-print'); window.print(); };
  window.addEventListener('afterprint', () => document.body.classList.remove('adv-print'));
  // the two copies on a sheet stay identical while you edit a field
  $('advPages').addEventListener('input', e => {
    const el = e.target.closest('[data-k]'); if (!el) return;
    el.closest('.adv-sheet').querySelectorAll(`[data-k="${el.dataset.k}"]`).forEach(o => { if (o !== el) o.textContent = el.textContent; });
  });
}
