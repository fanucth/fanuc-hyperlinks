/* =====================================================================
   Fuel claims — one form, three modes
     admin  : a fuel admin enters / edits the bills of a billing month ("Monthly claim" page)
     self   : an employee enters his / her own month; Save draft, or Submit for approval (button "New claim" in My fuel bills)
     review : a fuel admin checks a submitted claim, may change the figures, then Approves (creates the bill) or Sends it back with a reason
   The database does the real work: Gasoline is calculated with the same formula as the Excel "Calculation" sheet and bill + calculation are saved together
   (020_fuel_claim_entry.sql: fuel_save_claim; 021_fuel_claim_submissions.sql: fuel_submission_*). The figures shown while typing are only a preview.
   Uses globals from index.html: sb, $, esc, money, dmy, toast, show, BILLS   and from fuel-calc.js: cK, cN
   ===================================================================== */
const CL = { month: '', emps: [], byId: new Map(), bills: [], names: new Map(), calcs: new Map(), prev: [], subs: [], cur: null, mine: [] };
const CL_MISSING = 'Not available yet — IT needs to install 020_fuel_claim_entry.sql first.';
const CL_MISSING_SUB = 'Not available yet — IT needs to install 021_fuel_claim_submissions.sql first.';
const clIsMissing = e => /fuel_save_claim|fuel_delete_claim|PGRST202|could not find the function/i.test((e.message || '') + (e.code || ''));
const clIsMissingSub = e => /fuel_submission|fuel_claim_submissions|PGRST202|PGRST205|42P01|does not exist|could not find/i.test((e.message || '') + (e.code || ''));

const clNum = id => { const v = String($(id).value).replace(/,/g, '').trim(); return v === '' ? 0 : Number(v); };
const clYm = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const clPrevMonth = ym => { const [y, m] = ym.split('-').map(Number); return clYm(new Date(y, m - 2, 1)); };
const clR2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// what the database will calculate for these figures (same formulas as the sheet)
function clGasoline(a, b, d, e){
  if (!(a > 0 && d > 0)) return null;
  const h = (e / d) / (a / d);
  return { h, claimKm: a - b, claim: clR2(h * (a - b)), priv: clR2(h * b) };
}
const clSubTotal = s => { const g = clGasoline(+s.total_km, +s.private_km, +s.litres, +s.fuel_amount); return clR2((g ? g.claim : 0) + ['tollgate', 'car_wash', 'parking_fee', 'car_rental', 'fnd', 'taxi', 'hotel_fee', 'misc'].reduce((t, k) => t + Number(s[k] || 0), 0)); };

/* =====================================================================
   admin: the Monthly claim page
   ===================================================================== */
async function clLoadEmps(){
  if (CL.emps.length) return;
  const { data, error } = await sb.rpc('fuel_employee_lookup');
  if (error) { toast('Could not load the employee list: ' + error.message, true); return; }
  CL.emps = data || []; CL.byId = new Map(CL.emps.map(e => [e.id, e]));
}
async function clLoad(){
  const m = $('clMonth').value;
  if (!/^\d{4}-\d{2}$/.test(m)) { $('clStatus').textContent = 'Choose a billing month.'; return; }
  CL.month = m;
  await clLoadEmps();
  const [b, c, pv, nm, sb2] = await Promise.all([
    sb.from('fuel_bills').select('*').eq('billing_month', m).order('id'),
    sb.from('fuel_calc_v').select('*').eq('billing_month', m),
    sb.from('fuel_bills').select('employee_id,car_no,cost_center,bill_type').eq('billing_month', clPrevMonth(m)),
    sb.rpc('fuel_advice_rows', { p_month: m, p_ids: null }),            // names / employee ID / department of every bill (also for people who have left)
    sb.from('fuel_claim_submissions').select('*').eq('status', 'submitted').order('submitted_at'),   // waiting for review, every month
  ]);
  if (b.error) { toast('Could not load the bills: ' + b.error.message, true); return; }
  CL.bills = b.data || [];
  CL.calcs = new Map((c.data || []).map(x => [x.employee_id, x]));       // empty when 017 is not installed
  CL.prev = pv.data || [];
  CL.names = new Map((nm.data || []).map(r => [r.id, r]));
  CL.subs = sb2.error ? [] : (sb2.data || []);                            // empty when 021 is not installed
  clRender();
}

function clRender(){
  const q = $('clSearch').value.trim().toLowerCase();
  const num = v => Number(v) ? money(v) : '<span class="dash">—</span>';
  const rows = CL.bills.map(b => ({ b, n: CL.names.get(b.id) || {}, c: CL.calcs.get(b.employee_id) }))
    .filter(r => !q || `${r.n.fname} ${r.n.lname} ${r.n.employee_no} ${r.n.department} ${r.b.car_no}`.toLowerCase().includes(q));
  $('clBody').innerHTML = rows.length ? rows.map(({ b, n, c }) => {
    const other = Number(b.car_wash) + Number(b.parking_fee) + Number(b.car_rental) + Number(b.fnd) + Number(b.taxi) + Number(b.hotel_fee) + Number(b.misc) + Number(b.vat) + Number(b.wt);
    return `<tr>
      <td><strong>${esc(n.fname || '?')} ${esc(n.lname || '')}</strong><div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(n.employee_no || '')}${CL.byId.has(b.employee_id) ? '' : ' · not active'}</div></td>
      <td>${esc(n.department || '—')}</td><td>${esc(b.car_no || '—')}</td>
      <td class="num">${c ? cK(c.total_km) + ' km' : '<span class="dash">—</span>'}${c ? `<div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${cK(c.litres)} L</div>` : ''}</td>
      <td class="num">${num(b.gasoline)}</td><td class="num">${num(b.tollgate)}</td><td class="num">${num(other)}</td><td class="num">${num(b.adjustment)}</td>
      <td class="num total">${money(b.total)}</td>
      <td>${b.pay_status === 'paid' ? '<span class="fc-badge fc-badge--ok">Paid</span>' : '<span class="fc-badge fc-badge--warn">Pending</span>'}</td>
      <td><button type="button" class="bar-btn" data-edit="${b.id}">${b.pay_status === 'paid' ? 'View' : 'Edit'}</button></td></tr>`;
  }).join('') : `<tr><td colspan="11"><div class="fc-empty"><div class="fc-empty__title">${CL.bills.length ? 'No one matches' : 'No claims in this month yet'}</div>
      <p>${CL.bills.length ? '' : 'Use “New claim” or the list of people below.'}</p></div></td></tr>`;
  const tot = CL.bills.reduce((s, b) => s + Number(b.total || 0), 0);
  $('clStatus').textContent = CL.bills.length ? `${rows.length} of ${CL.bills.length} claims · total ${money(tot)} THB` : '';

  // claims the employees have submitted and are waiting for a decision (all months)
  $('clSubs').innerHTML = CL.subs.length ? `<div class="cl-subs"><div class="cl-subs__h">Waiting for review <span class="fc-badge fc-badge--warn">${CL.subs.length}</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Employee</th><th>Billing month</th><th class="num">Distance</th><th class="num">Gasoline</th><th class="num">Total</th><th>Submitted</th><th></th></tr></thead><tbody>` +
    CL.subs.map(s => { const e = CL.byId.get(s.employee_id) || {}, g = clGasoline(+s.total_km, +s.private_km, +s.litres, +s.fuel_amount);
      return `<tr><td><strong>${esc(e.fname || '?')} ${esc(e.lname || '')}</strong><div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(e.department || '')}</div></td><td>${esc(s.billing_month)}</td>
        <td class="num">${cK(s.total_km)} km<div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${cK(s.litres)} L</div></td><td class="num">${g ? money(g.claim) : '<span class="dash">—</span>'}</td>
        <td class="num total">${money(clSubTotal(s))}</td><td>${s.submitted_at ? dmy(s.submitted_at) : '—'}</td>
        <td><button type="button" class="fc-btn fc-btn--sm fc-btn--primary" data-review="${s.id}">Review</button></td></tr>`; }).join('') + '</tbody></table></div></div>' : '';

  // people who had a bill last month but none yet this month (quick add) + the picker for anyone else
  const have = new Set(CL.bills.map(b => b.employee_id));
  const missing = CL.prev.filter(p => !have.has(p.employee_id) && CL.byId.has(p.employee_id));
  $('clMissing').innerHTML = missing.length
    ? `<p class="fc-note" style="margin:var(--fc-s4) 0 var(--fc-s2)">Had a claim last month, none yet for ${esc(CL.month)} (${missing.length}):</p><div class="cl-chips">` +
      missing.map(p => { const e = CL.byId.get(p.employee_id); return `<button type="button" class="dept-chip" data-add="${p.employee_id}">+ ${esc(e.fname)} ${esc(e.lname)}</button>`; }).join('') + '</div>'
    : '';
  $('clAddEmp').innerHTML = '<option value="">Add a claim for…</option>' +
    CL.emps.filter(e => !have.has(e.id)).map(e => `<option value="${e.id}">${esc(e.fname)} ${esc(e.lname)} (${esc(e.department || '-')})</option>`).join('');
}

/* =====================================================================
   the form (all modes)
   ===================================================================== */
const CL_FIELDS = ['cl_month', 'cl_car', 'cl_cc', 'cl_type', 'cl_odo', 'cl_a', 'cl_b', 'cl_d', 'cl_e', 'cl_g', 'cl_toll', 'cl_wash', 'cl_park', 'cl_rent', 'cl_fnd', 'cl_taxi', 'cl_hotel', 'cl_misc', 'cl_vat', 'cl_adj', 'cl_wt', 'cl_tk', 'cl_tt', 'cl_remark'];
const clSet = (id, v) => { $(id).value = v == null || v === 0 || v === '0.00' ? '' : v; };
const clNz = v => Number(v) ? String(Number(v)) : '';

// o = { mode, empId, month, bill, calc, sub, prefill }  (prefill = a last-month bill row to take car plate / cost center / type from)
function clOpen(o){
  CL.cur = o;
  const { mode, bill, calc: c, sub: s } = o, pv = o.prefill || {}, e = CL.byId.get(o.empId);
  const src = s || bill;                                           // where the numbers come from
  const nm = bill ? (CL.names.get(bill.id) || {}) : {};
  const who = mode === 'self' ? 'You' : (e ? `${e.fname} ${e.lname}` : `${nm.fname || '?'} ${nm.lname || ''}`);
  $('clTitle').textContent = mode === 'self' ? 'My fuel claim' : mode === 'review' ? 'Review claim' : (bill ? 'Edit claim' : 'New claim');
  $('clWho').textContent = mode === 'self' ? '' : `${who} · billing month ${o.month}`;
  $('clMonthRow').classList.toggle('hidden', mode !== 'self');
  document.querySelectorAll('#clForm .cl-adm').forEach(x => x.classList.toggle('hidden', mode === 'self'));   // cost center, type, tax and adjustment: fuel admin only
  clSet('cl_month', o.month);
  clSet('cl_car', (src && src.car_no) || pv.car_no || (e && e.car_no) || (mode === 'self' ? CL.myCar || '' : ''));
  clSet('cl_cc', mode === 'review' ? pv.cost_center : bill ? bill.cost_center : pv.cost_center || '');
  $('cl_type').value = (mode === 'review' ? pv.bill_type : bill ? bill.bill_type : pv.bill_type) || '';
  const k = s || c;                                                 // fuel figures: the submission, or the saved calculation
  clSet('cl_odo', k ? k.odometer : ''); clSet('cl_a', k ? clNz(k.total_km) : ''); clSet('cl_b', k ? clNz(k.private_km) : '');
  clSet('cl_d', k ? clNz(k.litres) : ''); clSet('cl_e', k ? clNz(k.fuel_amount) : '');
  clSet('cl_tk', c && mode === 'admin' ? clNz(c.tax_km) : ''); clSet('cl_tt', c && mode === 'admin' ? clNz(c.tax_toll) : '');
  clSet('cl_g', mode === 'admin' && bill && !c ? clNz(bill.gasoline) : '');
  clSet('cl_toll', src ? clNz(src.tollgate) : ''); clSet('cl_wash', src ? clNz(src.car_wash) : ''); clSet('cl_park', src ? clNz(src.parking_fee) : '');
  clSet('cl_rent', src ? clNz(src.car_rental) : ''); clSet('cl_fnd', src ? clNz(src.fnd) : ''); clSet('cl_taxi', src ? clNz(src.taxi) : '');
  clSet('cl_hotel', src ? clNz(src.hotel_fee) : ''); clSet('cl_misc', src ? clNz(src.misc) : '');
  clSet('cl_vat', mode === 'admin' && bill ? clNz(bill.vat) : ''); clSet('cl_adj', mode === 'admin' && bill ? clNz(bill.adjustment) : ''); clSet('cl_wt', mode === 'admin' && bill ? clNz(bill.wt) : '');
  clSet('cl_remark', src ? src.remark : '');

  const paid = mode === 'admin' && !!bill && bill.pay_status === 'paid';
  CL_FIELDS.forEach(id => { $(id).disabled = paid; });
  $('cl_month').disabled = mode === 'self' && !!s;                  // an existing claim keeps its month
  const show1 = (id, on) => $(id).classList.toggle('hidden', !on);
  show1('clSave', !paid); show1('clDraft', mode === 'self'); show1('clReject', mode === 'review');
  show1('clDelete', (mode === 'admin' && !!bill && !paid) || (mode === 'self' && !!s));
  $('clSave').textContent = mode === 'self' ? 'Submit for approval' : mode === 'review' ? 'Approve and create bill' : 'Save';
  // note line: why it is read only, or what the fuel team said
  let note = '';
  if (paid) note = `This bill is paid${bill.paid_at ? ' on ' + dmy(bill.paid_at) : ''}. To change it, mark it as pending in Payment advice first.`;
  else if (mode === 'self' && s && s.status === 'rejected') note = `Sent back by the fuel team: ${s.reject_reason || '(no reason given)'} — fix it and submit again.`;
  else if (mode === 'self' && s && s.status === 'submitted') note = 'Submitted — waiting for the fuel team. You can still change it; saving it as a draft takes it back.';
  else if (mode === 'self') note = 'Enter your total km, private km, litres and the actual fuel bill — Gasoline is calculated for you. The fuel team checks it before it becomes a bill.';
  else if (mode === 'review') note = 'Submitted by the employee. Check the figures (you may change them), add the cost center, type and any Vat / WT / adjustment, then approve.';
  $('clNote').textContent = note; $('clNote').classList.toggle('hidden', !note);
  $('clNote').style.color = paid || (s && s.status === 'rejected') ? 'var(--fc-warn)' : '';
  $('clErr').textContent = '';
  clCalc();
  $('clModal').classList.remove('hidden');
  if (!paid) $(mode === 'self' && !s ? 'cl_month' : bill || s ? 'cl_a' : 'cl_car').focus();
}

// preview of what the database will calculate
function clCalc(){
  const a = clNum('cl_a'), b = clNum('cl_b'), d = clNum('cl_d'), e = clNum('cl_e');
  const self = CL.cur && CL.cur.mode === 'self', g0 = clGasoline(a, b, d, e);
  let g, html = '';
  if (g0) {
    g = g0.claim;
    html = [['Distance claimed (a − b)', cK(g0.claimKm) + ' km'], ['Average price per litre', cN(e / d) + ' THB'], ['Distance per litre', cN(a / d) + ' km'], ['Cost per km', cN(g0.h, 4) + ' THB'],
      ['Private use (not claimed)', cN(g0.priv) + ' THB'], ['Gasoline claim', `<b>${cN(g0.claim)} THB</b>`], ['Difference (should be 0.00)', cN(clR2(e - (g0.claim + g0.priv))) + ' THB']]
      .map(([k, v]) => `<div class="cl-res__k">${k}</div><div class="cl-res__v">${v}</div>`).join('');
    if (b > a) html = '<div class="cl-res__k" style="grid-column:1/-1;color:var(--fc-danger,#c0392b)">Private km is more than the total km</div>' + html;
  } else {
    g = self ? 0 : clNum('cl_g');
    html = `<div class="cl-res__k" style="grid-column:1/-1">${self ? 'Enter the total km, the litres and the actual fuel bill and Gasoline is calculated here.' : 'Enter the total km and the litres to calculate Gasoline automatically. Otherwise type the Gasoline amount below.'}</div>`;
  }
  $('clRes').innerHTML = html;
  $('clGasRow').classList.toggle('hidden', !!g0 || self);
  const ids = ['cl_toll', 'cl_wash', 'cl_park', 'cl_rent', 'cl_fnd', 'cl_taxi', 'cl_hotel', 'cl_misc'].concat(self ? [] : ['cl_vat', 'cl_adj', 'cl_wt']);
  $('clTotal').textContent = money(clR2(g + ids.reduce((s, id) => s + clNum(id), 0)));
}

function clPayload(){
  return {
    car_no: $('cl_car').value, cost_center: $('cl_cc').value, bill_type: $('cl_type').value,
    odometer: $('cl_odo').value.trim() === '' ? null : clNum('cl_odo'), total_km: clNum('cl_a'), private_km: clNum('cl_b'), litres: clNum('cl_d'), fuel_amount: clNum('cl_e'),
    tax_km: clNum('cl_tk'), tax_toll: clNum('cl_tt'), gasoline: clNum('cl_g'),
    tollgate: clNum('cl_toll'), car_wash: clNum('cl_wash'), parking_fee: clNum('cl_park'), car_rental: clNum('cl_rent'), fnd: clNum('cl_fnd'),
    taxi: clNum('cl_taxi'), hotel_fee: clNum('cl_hotel'), misc: clNum('cl_misc'), vat: clNum('cl_vat'), adjustment: clNum('cl_adj'), wt: clNum('cl_wt'), remark: $('cl_remark').value,
  };
}
const clFail = (e, sub) => { $('clErr').textContent = (sub ? clIsMissingSub(e) : clIsMissing(e)) ? (sub ? CL_MISSING_SUB : CL_MISSING) : e.message; };
const clClose = () => $('clModal').classList.add('hidden');

async function clSave(ev){
  ev.preventDefault();
  const cur = CL.cur, p = clPayload();
  if (p.private_km > p.total_km) { $('clErr').textContent = 'Private km cannot be more than the total km.'; return; }
  $('clSave').disabled = true; $('clErr').textContent = '';
  try {
    if (cur.mode === 'admin') {
      const { error } = await sb.rpc('fuel_save_claim', {
        p_employee: cur.empId, p_month: cur.month, p_car_no: p.car_no, p_cost_center: p.cost_center, p_bill_type: p.bill_type, p_odometer: p.odometer,
        p_total_km: p.total_km, p_private_km: p.private_km, p_litres: p.litres, p_fuel_amount: p.fuel_amount, p_tax_km: p.tax_km, p_tax_toll: p.tax_toll, p_gasoline: p.gasoline,
        p_tollgate: p.tollgate, p_car_wash: p.car_wash, p_parking_fee: p.parking_fee, p_car_rental: p.car_rental, p_fnd: p.fnd, p_taxi: p.taxi, p_hotel_fee: p.hotel_fee,
        p_misc: p.misc, p_vat: p.vat, p_adjustment: p.adjustment, p_wt: p.wt, p_remark: p.remark });
      if (error) return clFail(error);
      clClose(); toast('Claim saved'); await clLoad();
    } else if (cur.mode === 'review') {
      const { error } = await sb.rpc('fuel_submission_approve', { p_id: cur.sub.id, p });
      if (error) return clFail(error, true);
      clClose(); toast('Approved — the bill has been created'); await clLoad();
    } else {
      await selfSave(true);
    }
  } finally { $('clSave').disabled = false; }
}
async function clDraft(){ $('clDraft').disabled = true; try { await selfSave(false); } finally { $('clDraft').disabled = false; } }
async function clDelete(){
  const cur = CL.cur;
  if (cur.mode === 'admin') {
    if (!cur.bill || !confirm('Delete this claim (the bill and its calculation details)? This cannot be undone.')) return;
    const { error } = await sb.rpc('fuel_delete_claim', { p_bill: cur.bill.id });
    if (error) return clFail(error);
    clClose(); toast('Claim deleted'); await clLoad();
  } else if (cur.mode === 'self' && cur.sub) {
    if (!confirm('Delete this claim?')) return;
    const { error } = await sb.rpc('fuel_submission_delete', { p_id: cur.sub.id });
    if (error) return clFail(error, true);
    clClose(); toast('Claim deleted'); await selfLoad();
  }
}
async function clReject(){
  const cur = CL.cur; if (cur.mode !== 'review') return;
  const reason = prompt('Why is this claim sent back? The employee will see this message.');
  if (reason === null) return;
  if (!reason.trim()) { $('clErr').textContent = 'Please write a reason so the employee knows what to fix.'; return; }
  const { error } = await sb.rpc('fuel_submission_reject', { p_id: cur.sub.id, p_reason: reason });
  if (error) return clFail(error, true);
  clClose(); toast('Sent back to the employee'); await clLoad();
}

/* =====================================================================
   admin: open a claim from the page
   ===================================================================== */
async function clOpenReview(sub){
  const pv = await sb.from('fuel_bills').select('car_no,cost_center,bill_type').eq('employee_id', sub.employee_id).eq('billing_month', clPrevMonth(sub.billing_month)).limit(1);
  clOpen({ mode: 'review', empId: sub.employee_id, month: sub.billing_month, sub, prefill: (pv.data || [])[0] || {} });
}

/* =====================================================================
   employee: my claims (in My fuel bills)
   ===================================================================== */
const SELF_STATUS = {
  draft: '<span class="fc-badge fc-badge--neutral">Draft</span>', submitted: '<span class="fc-badge fc-badge--warn">Waiting for approval</span>',
  rejected: '<span class="fc-badge fc-badge--danger">Sent back</span>',
};
async function selfLoad(){
  const box = $('mySubs'); if (!box) return;
  const r = await sb.from('fuel_claim_submissions').select('*').neq('status', 'approved').order('billing_month', { ascending: false });
  CL.mine = r.error ? null : (r.data || []);                         // null = 021 is not installed -> the "New claim" button stays hidden
  $('btnMyClaim').classList.toggle('hidden', !CL.mine);
  box.innerHTML = CL.mine && CL.mine.length ? `<div class="cl-subs"><div class="cl-subs__h">My claims not yet approved</div><div class="tbl-wrap"><table class="tbl cards"><thead><tr>
      <th>Billing month</th><th>Status</th><th class="num">Gasoline</th><th class="num">Total</th><th>Note</th><th></th></tr></thead><tbody>` +
    CL.mine.map(s => { const g = clGasoline(+s.total_km, +s.private_km, +s.litres, +s.fuel_amount);
      return `<tr><td data-l="Billing month"><strong>${esc(s.billing_month)}</strong></td><td data-l="Status">${SELF_STATUS[s.status] || esc(s.status)}</td>
        <td class="num" data-l="Gasoline">${g ? money(g.claim) : '<span class="dash">—</span>'}</td><td class="num total" data-l="Total">${money(clSubTotal(s))}</td>
        <td data-l="Note" class="hide-empty" style="white-space:normal">${s.status === 'rejected' ? esc(s.reject_reason || '') : ''}</td>
        <td><button type="button" class="bar-btn" data-mysub="${s.id}">${s.status === 'submitted' ? 'View / change' : 'Edit'}</button></td></tr>`; }).join('') + '</tbody></table></div></div>' : '';
}
function selfOpen(sub){
  const month = sub ? sub.billing_month : clPrevMonth(clYm(new Date()));
  // my car plate: from my profile, else from my latest bill
  CL.myCar = (typeof ME_EMP !== 'undefined' && ME_EMP && ME_EMP.car_no) || (typeof BILLS !== 'undefined' && BILLS[0] && BILLS[0].car_no) || '';
  clOpen({ mode: 'self', empId: null, month, sub: sub || null, bill: null, calc: null, prefill: {} });
}
async function selfSave(submit){
  const p = clPayload(), month = $('cl_month').value;
  if (!/^\d{4}-\d{2}$/.test(month)) { $('clErr').textContent = 'Choose the billing month.'; return; }
  if (p.private_km > p.total_km) { $('clErr').textContent = 'Private km cannot be more than the total km.'; return; }
  $('clErr').textContent = '';
  const { error } = await sb.rpc('fuel_submission_save', {
    p_month: month, p_car_no: p.car_no, p_odometer: p.odometer, p_total_km: p.total_km, p_private_km: p.private_km, p_litres: p.litres, p_fuel_amount: p.fuel_amount,
    p_tollgate: p.tollgate, p_car_wash: p.car_wash, p_parking_fee: p.parking_fee, p_car_rental: p.car_rental, p_fnd: p.fnd, p_taxi: p.taxi, p_hotel_fee: p.hotel_fee,
    p_misc: p.misc, p_remark: p.remark, p_submit: !!submit });
  if (error) return clFail(error, true);
  clClose(); toast(submit ? 'Submitted — the fuel team will check it' : 'Draft saved');
  await selfLoad();
}

function wireClaims(){
  // admin page
  $('btnClaims').onclick = async () => { show('viewClaims'); if (!$('clMonth').value) $('clMonth').value = clPrevMonth(clYm(new Date())); await clLoad(); };
  $('btnClBack').onclick = () => show('viewMain');
  $('clMonth').onchange = clLoad;
  $('clSearch').oninput = clRender;
  $('clBody').addEventListener('click', ev => { const b = ev.target.closest('[data-edit]'); if (!b) return; const bill = CL.bills.find(x => x.id === +b.dataset.edit);
    if (bill) clOpen({ mode: 'admin', empId: bill.employee_id, month: CL.month, bill, calc: CL.calcs.get(bill.employee_id) || null, prefill: CL.prev.find(x => x.employee_id === bill.employee_id) }); });
  const addNew = id => clOpen({ mode: 'admin', empId: id, month: CL.month, bill: null, calc: null, prefill: CL.prev.find(x => x.employee_id === id) || {} });
  $('clMissing').addEventListener('click', ev => { const b = ev.target.closest('[data-add]'); if (b) addNew(b.dataset.add); });
  $('clAddEmp').onchange = () => { const v = $('clAddEmp').value; $('clAddEmp').value = ''; if (v) addNew(v); };
  $('clSubs').addEventListener('click', ev => { const b = ev.target.closest('[data-review]'); if (!b) return; const s = CL.subs.find(x => x.id === +b.dataset.review); if (s) clOpenReview(s); });
  // employee: my claims
  $('btnMyClaim').onclick = () => selfOpen(null);
  $('mySubs').addEventListener('click', ev => { const b = ev.target.closest('[data-mysub]'); if (!b) return; const s = (CL.mine || []).find(x => x.id === +b.dataset.mysub); if (s) selfOpen(s); });
  // the form
  CL_FIELDS.forEach(id => { $(id).addEventListener('input', clCalc); });
  $('cl_month').onchange = () => {      // picking a month that already has a claim of mine opens that claim
    if (!CL.cur || CL.cur.mode !== 'self' || CL.cur.sub) return;
    const m = $('cl_month').value, ex = (CL.mine || []).find(x => x.billing_month === m);
    if (ex) { selfOpen(ex); return; }
    const bill = typeof BILLS !== 'undefined' && BILLS.find(b => b.billing_month === m);
    $('clErr').textContent = bill ? 'You already have a bill for this month.' : '';
  };
  $('clForm').onsubmit = clSave;
  $('clDraft').onclick = clDraft; $('clDelete').onclick = clDelete; $('clReject').onclick = clReject;
  $('clCancel').onclick = clClose;
}
