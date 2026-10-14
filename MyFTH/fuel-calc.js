/* =====================================================================
   Fuel calculation details ("Calculation" sheet): how the Gasoline amount of a bill was worked out
   - employees see the steps for their own bills (button "Details" on a bill row)
   - fuel admins also see it on the Payment advice list, plus the tax columns
   Needs 017_fuel_calc.sql (fuel_calc_for_bills). Everything here is silent when it is not installed yet.
   Uses globals from index.html: sb, $, esc, money
   ===================================================================== */
const CALCS = new Map();     

// expense types besides Gasoline / Tollgate / Car wash / Parking (columns of the Summarized sheet; amounts may be negative)
const FUEL_EXTRAS = [['car_rental', 'Car rental'], ['fnd', 'F&D'], ['taxi', 'Taxi'], ['hotel_fee', 'Hotel fee'], ['misc', 'Misc.'], ['vat', 'VAT'], ['wt', 'WT']];
const fuelExtraSum = b => FUEL_EXTRAS.reduce((s, [k]) => s + Number(b[k] || 0), 0);
const fuelExtraTip = b => FUEL_EXTRAS.filter(([k]) => Number(b[k] || 0)).map(([k, l]) => l + ' ' + money(b[k])).join(', ');     // bill id -> calculation row

async function loadCalcs(ids){
  if (!ids || !ids.length) return;
  try {
    const { data, error } = await sb.rpc('fuel_calc_for_bills', { p_ids: ids });
    if (!error) (data || []).forEach(c => CALCS.set(c.bill_id, c));
  } catch { /* 017 not installed yet — no details to show */ }
}

const cN = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const cK = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

// problems worth a look: the difference must be zero, and Gasoline on the bill should equal the calculated claim
function calcIssues(c){
  const out = [];
  if (Math.abs(Number(c.diff)) > 0.005) out.push(`Difference ${cN(c.diff)} (private + claim should equal the actual fuel bill)`);
  if (Math.abs(Number(c.gasoline) - Number(c.claim_amount)) > 0.005) out.push(`Gasoline on the bill (${cN(c.gasoline)}) differs from the calculation (${cN(c.claim_amount)})`);
  return out;
}

function openCalc(billId, who){
  const c = CALCS.get(billId); if (!c) return;
  const admin = c.tax_km != null || c.tax_total != null;      // tax columns are only returned to fuel admins
  const issues = calcIssues(c);
  const row = (k, l, v, u, cls) => `<tr class="${cls || ''}"><td class="k">${k}</td><td>${l}</td><td class="v">${v}</td><td class="u">${u || ''}</td></tr>`;
  $('calcTitle').textContent = `Gasoline calculation — ${c.billing_month}${who ? ' · ' + who : ''}`;
  $('calcBody').innerHTML = `
    ${c.car_no || c.odometer ? `<p class="fc-note" style="margin:0 0 var(--fc-s2)">${c.car_no ? 'Car ' + esc(c.car_no) : ''}${c.odometer ? ' · odometer at month end ' + cK(c.odometer) + ' km' : ''}</p>` : ''}
    <table class="calc-tbl">
      <tbody>
        <tr class="calc-grp"><td colspan="4">Distance</td></tr>
        ${row('a', 'Total use', cK(c.total_km), 'km')}
        ${row('b', 'Private use', cK(c.private_km), 'km')}
        ${row('c = a − b', 'Distance claimed', cK(c.claim_km), 'km', 'calc-strong')}
        <tr class="calc-grp"><td colspan="4">Fuel</td></tr>
        ${row('d', 'Fuel filled in', cK(c.litres), 'litres')}
        ${row('e', 'Actual fuel bill', cN(c.fuel_amount), 'THB')}
        ${row('f = e / d', 'Average price per litre', cN(c.price_per_litre), 'THB / litre')}
        ${row('g = a / d', 'Distance per litre', cN(c.km_per_litre), 'km / litre')}
        ${row('h = f / g', 'Cost per km', cN(c.cost_per_km, 4), 'THB / km', 'calc-strong')}
        <tr class="calc-grp"><td colspan="4">Result</td></tr>
        ${row('i = b × h', 'Private use (not claimed)', cN(c.private_amount), 'THB')}
        ${row('j = c × h', '<b>Gasoline claim</b> — the Gasoline amount of the bill', `<b>${cN(c.claim_amount)}</b>`, 'THB', 'calc-result')}
        ${row('i + j', 'Total of private and claim', cN(c.calc_total), 'THB')}
        ${row('e − (i + j)', 'Difference (should be 0.00)', cN(c.diff), 'THB', Math.abs(Number(c.diff)) > 0.005 ? 'calc-bad' : 'calc-good')}
        ${admin ? `<tr class="calc-grp"><td colspan="4">Tax calculation (fuel admins only)</td></tr>
        ${row('m', 'Transportation for tax', cK(c.tax_km), 'km')}
        ${row('n = m × h', 'Transportation for tax', cN(c.tax_km_amount), 'THB')}
        ${row('o', 'Toll gate for tax', cN(c.tax_toll), 'THB')}
        ${row('p = n + o', 'Total amount for tax', cN(c.tax_total), 'THB', 'calc-strong')}` : ''}
      </tbody>
    </table>
    ${issues.length ? `<div class="calc-warn">${issues.map(esc).join('<br>')}</div>` : ''}`;
  $('calcModal').classList.remove('hidden');
}

function wireCalc(){
  $('calcClose').onclick = () => $('calcModal').classList.add('hidden');
  $('fuelBody').addEventListener('click', e => { const b = e.target.closest('[data-calc]'); if (b) openCalc(+b.dataset.calc); });
  $('advBody').addEventListener('click', e => { const b = e.target.closest('[data-calc]'); if (b) openCalc(+b.dataset.calc, b.dataset.who); });
}
