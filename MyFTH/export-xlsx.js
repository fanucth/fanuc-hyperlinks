/* =====================================================================
   Export to Excel — the lists on screen as .xlsx (what you see after the filters is what you get)
     My fuel bills · Manage users · Payment advice · Monthly claim
   Headers and status words follow the language that is on screen. Numbers are real numbers (format #,##0.00), so Excel can sum them.
   Needs the SheetJS library (XLSX) that index.html already loads for the bill import. Uses globals: toast, dmy
   ===================================================================== */
const XL_T = s => (window.FTHLang ? FTHLang.tr(s) : s);
const xlToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const xlDate = v => (v ? dmy(String(v).slice(0, 10)) : '');

/* cols: [{ h: 'Header', v: row => value, n: true (a number), w: width }]  -> downloads the file */
function xlSave(file, sheet, cols, rows){
  if (!window.XLSX) { toast('The Excel library is not loaded yet — try again in a moment', true); return; }
  if (!rows.length) { toast('Nothing to export', true); return; }
  const aoa = [cols.map(c => XL_T(c.h))].concat(rows.map(r => cols.map(c => { const x = c.v(r); return x === undefined || x === null ? '' : x; })));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  cols.forEach((c, i) => {
    if (!c.n) return;
    for (let r = 1; r < aoa.length; r++) { const cell = ws[XLSX.utils.encode_cell({ r, c: i })]; if (cell && typeof cell.v === 'number') cell.z = c.z || '#,##0.00'; }
  });
  ws['!cols'] = cols.map((c, i) => ({ wch: c.w || Math.min(40, Math.max(10, String(aoa[0][i]).length + 3)) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  XLSX.writeFile(wb, file);
  toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel`);
}

/* ---------- bills (own list, Payment advice list, Monthly claim list) ----------
   item = { b: bill-like row, n: person (name, employee_no, department) or null, c: calculation row or null, paidAt: date or null } */
function xlBillCols(withPerson){
  const N = k => it => Number(it.b[k] || 0);
  const num = (h, k) => ({ h, v: N(k), n: true });
  const cols = [];
  if (withPerson) cols.push(
    { h: 'Employee ID', v: it => it.n.employee_no || '', w: 12 },
    { h: 'Name', v: it => `${it.n.fname || ''} ${it.n.lname || ''}`.trim(), w: 26 },
    { h: 'Department', v: it => it.n.department || '', w: 22 });
  cols.push({ h: 'Billing month', v: it => it.b.billing_month || '', w: 14 });
  if (withPerson) cols.push({ h: 'Document no.', v: it => (it.n.seq && /^(\d{4})-(\d{2})$/.test(it.b.billing_month || '')) ? `PC-${it.b.billing_month.slice(0, 4)}/ G${+it.b.billing_month.slice(5)}-${it.n.seq}` : '', w: 16 });
  cols.push(
    { h: 'Bill date', v: it => xlDate(it.b.bill_date), w: 12 },
    num('Gasoline', 'gasoline'), num('Tollgate', 'tollgate'), num('Car wash', 'car_wash'), num('Parking', 'parking_fee'),
    num('Car rental', 'car_rental'), num('F&D', 'fnd'), num('Taxi', 'taxi'), num('Hotel fee', 'hotel_fee'), num('Misc.', 'misc'),
    num('VAT', 'vat'), num('WT', 'wt'), num('Adjustment', 'adjustment'), num('Total', 'total'),
    { h: 'Status', v: it => XL_T(it.b.pay_status === 'paid' ? 'Paid' : 'Pending'), w: 10 },
    { h: 'Paid date', v: it => xlDate(it.paidAt), w: 12 },
    { h: 'Car plate', v: it => it.b.car_no || '', w: 12 },
    { h: 'Cost center', v: it => it.b.cost_center || '', w: 14 },
    { h: 'Type', v: it => it.b.bill_type || '', w: 8 },
    { h: 'Total km', v: it => it.c ? Number(it.c.total_km || 0) : '', n: true },
    { h: 'Private km', v: it => it.c ? Number(it.c.private_km || 0) : '', n: true },
    { h: 'Litres', v: it => it.c ? Number(it.c.litres || 0) : '', n: true },
    { h: 'Actual fuel bill', v: it => it.c ? Number(it.c.fuel_amount || 0) : '', n: true },
    { h: 'Private use (not claimed)', v: it => it.c ? Number(it.c.private_amount || 0) : '', n: true },
    { h: 'Remark', v: it => it.b.remark || '', w: 30 });
  return cols;
}

// My fuel bills: what is shown after the year / month filter
function exportMyBills(){
  const items = (window.FUEL_SHOWN || []).map(b => ({ b, n: null, c: CALCS.get(b.id) || null, paidAt: b.paid_at }));
  const tag = $('fMonth').value && $('fYear').value ? `${$('fYear').value}-${String($('fMonth').value).padStart(2, '0')}` : ($('fYear').value || 'all');
  xlSave(`MyFTH_fuel_bills_${tag}.xlsx`, 'Fuel bills', xlBillCols(false), items);
}
// Payment advice: the bills of the chosen month after the filters (ADV.shown is set by advRenderList)
function exportAdviceList(){
  const items = (ADV.shown || []).map(r => ({ b: r, n: r, c: CALCS.get(r.id) || null, paidAt: ADV.paid ? ADV.paid.get(r.id) : null }));
  xlSave(`MyFTH_payment_advice_${$('advMonth').value || 'all'}.xlsx`, 'Payment advice', xlBillCols(true), items);
}
// Monthly claim: the bills of the chosen month after the search box (CL.shown is set by clRender)
function exportClaimList(){
  const items = (CL.shown || []).map(r => ({ b: r.b, n: r.n, c: r.c || null, paidAt: r.b.paid_at }));
  xlSave(`MyFTH_monthly_claim_${CL.month || 'all'}.xlsx`, 'Monthly claim', xlBillCols(true), items);
}

// Manage users: the people shown after the filters
function exportUsers(){
  const role = u => [...(ROLES.get(u.email) || [])].map(r => XL_T(ROLE_LABEL[r] || r)).join(', ');
  const cols = [
    { h: 'Employee ID', v: u => u.employee_no || '', w: 12 },
    { h: 'First name', v: u => u.fname || '', w: 16 }, { h: 'Last name', v: u => u.lname || '', w: 18 },
    { h: 'Email', v: u => u.email || '', w: 30 }, { h: 'Department', v: u => u.department || '', w: 22 }, { h: 'Title', v: u => u.title || '', w: 20 },
    { h: 'Cost center', v: u => u.cost_center_id || '', w: 12 }, { h: 'Cost center name', v: u => u.cost_center_name || '', w: 22 },
    { h: 'Joined', v: u => xlDate(u.hire_date), w: 12 },
    { h: 'Status', v: u => XL_T(u.status === 'active' ? 'Active' : 'Resigned'), w: 10 },
    { h: 'Phone', v: u => u.tel || '', w: 14 }, { h: 'Extension', v: u => u.ext || '', w: 10 }, { h: 'Car plate', v: u => u.car_no || '', w: 12 },
    { h: 'Admin roles', v: role, w: 24 },
    { h: 'Email code (2FA)', v: u => (MFA_SET && MFA_SET.mode === 'all') || u.mfa_required === true || u.mfa_self === true ? XL_T('Required') : '', w: 16 },
  ];
  xlSave(`MyFTH_employees_${xlToday()}.xlsx`, 'Employees', cols, LAST_LIST || []);
}

function wireExport(){
  $('btnXlsFuel').onclick = exportMyBills;
  $('btnXlsUsers').onclick = exportUsers;
  $('btnXlsAdv').onclick = exportAdviceList;
  $('btnXlsClaims').onclick = exportClaimList;
}
