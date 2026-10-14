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
function advDateTxt(iso){ const [y, m, d] = iso.split('-'); return `${+d}-${ADV_MON3[+m - 1]}-${y.slice(2)}`; }   // 25-Apr-26
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
      <div>Check by ${advCe('chk', '', 'adv-sig')}</div>
      <div>HR Div. ${advCe('hr', '', 'adv-sig')}</div>
    </div>
  </div>`;
}

function advRender(){
  const copies = +$('advCopies').value;
  const iso = $('advDate').value || advToday(), [dy, dm] = iso.split('-');
  const prep = $('advPrep').value;
  $('advPages').innerHTML = ADV.rows.map(r => {
    const one = advCopy(r, { docNo: `PC-${dy}/ G${+dm}-${r.seq}`, dateTxt: advDateTxt(iso), prep });
    return `<div class="adv-sheet${copies === 2 ? '' : ' one'}">${one}${copies === 2 ? '<div class="adv-cut"></div>' + one : ''}</div>`;
  }).join('');
  let big = 0;
  if (copies === 2 && !$('advModal').classList.contains('hidden')) {
    document.querySelectorAll('#advPages .adv-sheet').forEach(sh => {
      const cp = sh.querySelector('.adv-copy');
      if (cp.scrollHeight > cp.clientHeight + 1) { sh.classList.add('one'); sh.querySelector('.adv-cut').remove(); sh.querySelectorAll('.adv-copy')[1].remove(); big++; }
    });
  }
  $('advInfo').textContent = `${ADV.rows.length} document${ADV.rows.length === 1 ? '' : 's'} · one A4 sheet each` + (big ? ` · ${big} with many lines printed as one copy` : '');
}

function advOpen(rows){
  if (!rows.length) { toast('Nothing to print', true); return; }
  ADV.rows = rows;
  try { $('advPrep').value = localStorage.getItem('fth_adv_prep') ?? 'Butchadeekarn'; } catch { $('advPrep').value = 'Butchadeekarn'; }
  if (!$('advDate').value) $('advDate').value = advToday();
  $('advModal').classList.remove('hidden');
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
  if (rows) advOpen(rows);
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
  ADV.list = m ? (await advFetch({ p_month: m, p_ids: null })) || [] : [];
  await loadCalcs(ADV.list.map(r => r.id));
  advRenderList();
}
function advCalcCell(r){
  const c = CALCS.get(r.id); if (!c) return '<span class="dash">—</span>';
  const issues = calcIssues(c);
  return `<button type="button" class="bar-btn" data-calc="${r.id}" data-who="${esc(r.fname)} ${esc(r.lname)}" title="Show the calculation">${cK(c.total_km)} km · ${cK(c.litres)} L</button>` +
    (issues.length ? ` <span class="fc-badge fc-badge--warn" title="${esc(issues.join('; '))}">Check</span>` : '');
}
function advRenderList(){
  const q = $('advSearch').value.trim().toLowerCase();
  const shown = ADV.list.filter(r => !q || `${r.fname} ${r.lname} ${r.employee_no} ${r.department} ${r.car_no}`.toLowerCase().includes(q));
  const num = v => Number(v) ? money(v) : '<span class="dash">—</span>';
  $('advBody').innerHTML = shown.length ? shown.map(r => `<tr>
      <td><input type="checkbox" class="advTick" data-id="${r.id}" aria-label="Select ${esc(r.fname)} ${esc(r.lname)}"></td>
      <td>${r.seq}</td>
      <td><strong>${esc(r.fname)} ${esc(r.lname)}</strong><div class="fc-mut" style="font-size:12px">${esc(r.employee_no || '')}</div></td>
      <td>${esc(r.department || '—')}</td><td>${esc(r.car_no || '—')}</td>
      <td class="num">${num(r.gasoline)}</td><td class="num">${num(r.tollgate)}</td><td class="num">${num(r.car_wash)}</td>
      <td class="num">${num(r.parking_fee)}</td><td class="num" title="${esc(fuelExtraTip(r))}">${num(fuelExtraSum(r))}</td><td class="num">${num(r.adjustment)}</td>
      <td class="num total">${money(r.total)}</td>
      <td>${advCalcCell(r)}</td>
      <td>${r.pay_status === 'paid' ? '<span class="fc-badge fc-badge--ok">Paid</span>' : '<span class="fc-badge fc-badge--warn">Pending</span>'}</td></tr>`).join('')
    : `<tr><td colspan="14"><div class="fc-empty"><div class="fc-empty__title">${ADV.list.length ? 'No one matches' : 'No bills in this month'}</div></div></td></tr>`;
  $('advStatus').textContent = ADV.list.length ? `${shown.length} of ${ADV.list.length} bills` : '';
  $('advTickAll').checked = false; advCount();
}
function advTicked(){ return [...document.querySelectorAll('.advTick:checked')].map(x => +x.dataset.id); }
function advCount(){
  const n = advTicked().length;
  $('advPrintSel').disabled = !n; $('advPrintSel').querySelector('span').textContent = n ? `Print selected (${n})` : 'Print selected';
}

function wireAdvice(){
  $('btnAdvice').onclick = async () => { show('viewAdvice'); await advLoadMonths(); };
  $('btnAdvBack').onclick = () => show('viewMain');
  $('advMonth').onchange = advLoadList;
  $('advSearch').oninput = advRenderList;
  $('advTickAll').onchange = e => { document.querySelectorAll('.advTick').forEach(x => { x.checked = e.target.checked; }); advCount(); };
  $('advBody').onchange = e => { if (e.target.classList.contains('advTick')) advCount(); };
  $('advPrintSel').onclick = () => { const ids = new Set(advTicked()); advOpen(ADV.list.filter(r => ids.has(r.id))); };
  $('advPrintAll').onclick = () => advOpen(ADV.list);
  // my own bills (profile page)
  $('fuelBody').addEventListener('click', e => { const b = e.target.closest('[data-adv]'); if (b) adviceForIds([+b.dataset.adv]); });
  // preview dialog
  ['advDate', 'advCopies'].forEach(id => { $(id).onchange = advRender; });
  $('advPrep').oninput = () => { try { localStorage.setItem('fth_adv_prep', $('advPrep').value); } catch {} advRender(); };
  $('advClose').onclick = advClose;
  $('advPrint').onclick = () => { document.body.classList.add('adv-print'); window.print(); };
  window.addEventListener('afterprint', () => document.body.classList.remove('adv-print'));
  // the two copies on a sheet stay identical while you edit a field
  $('advPages').addEventListener('input', e => {
    const el = e.target.closest('[data-k]'); if (!el) return;
    el.closest('.adv-sheet').querySelectorAll(`[data-k="${el.dataset.k}"]`).forEach(o => { if (o !== el) o.textContent = el.textContent; });
  });
}
