/* =====================================================================
   Manage users (platform admin only) — uses globals from index.html: sb, $, esc, dmy, toast, show, SUPABASE_CONFIG
   - list / search / edit employees : direct table access (RLS policy emp_admin_all)
   - create account, resign / reactivate, reset password : Edge Function "manage-employee"
   - admin roles (platform admin / fuel admin)           : RPC admin_list_roles / admin_set_role  (005_user_management.sql)
   ===================================================================== */
let USERS = [];                 // employees rows
let ROLES = new Map();          // email -> Set("platform:admin", "fuel:admin", ...)
let MY_EMAIL = '';
let EDITING = null;             // employee row being edited (null = adding)
let LAST_LIST = [];            // rows currently shown (used by the bulk 2FA buttons)
let MFA_OV = new Map();          // email -> { has_totp, backup_remaining } (admin_mfa_overview)
let MFA_SET = null;             // { mode, trust_days } from admin_get_mfa (null = 011_email_2fa.sql not installed)
let ORG = [];                   // org_units (id = cost center code, name)

const ROLE_LABEL = { 'platform:admin': 'Platform admin', 'fuel:admin': 'Fuel admin', 'homemap:viewer': 'Home map viewer' };

async function callFn(action, payload){
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_CONFIG.url}/functions/v1/manage-employee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_CONFIG.anonKey, Authorization: 'Bearer ' + (session?.access_token || '') },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

async function loadUsers(){
  $('usersBody').innerHTML = '<tr><td colspan="8"><div class="fc-skeleton" style="height:120px"></div></td></tr>';
  const { data: { user } } = await sb.auth.getUser();
  MY_EMAIL = (user?.email || '').toLowerCase();
  const [emps, roles, org] = await Promise.all([
    // newest joiners first (no join date goes last), then by name
    sb.from('employees').select('*').order('hire_date', { ascending: false, nullsFirst: false }).order('fname', { ascending: true }).limit(2000),
    sb.rpc('admin_list_roles'),
    sb.from('org_units').select('id,name').order('sort_order', { ascending: true }),
  ]);
  if (org.error) { ORG = []; toast('Could not load cost centers (did you run 006_org_units.sql?): ' + org.error.message, true); }
  else ORG = (org.data || []).filter(o => o.id !== 'FTH' && o.id !== 'FTH1');   // company-level units are not cost centers for people
  if (emps.error) { toast('Could not load employees: ' + emps.error.message, true); USERS = []; }
  else USERS = emps.data || [];
  CAR_COL = USERS.length ? ("car_no" in USERS[0]) : CAR_COL;   // false until 014_car_no.sql has been run
  ROLES = new Map();
  if (roles.error) toast('Could not load roles (did you run 005_user_management.sql?): ' + roles.error.message, true);
  else (roles.data || []).forEach(r => {
    if (!ROLES.has(r.email)) ROLES.set(r.email, new Set());
    ROLES.get(r.email).add(`${r.app}:${r.role}`);
  });
  const mf = await sb.rpc('admin_get_mfa');
  MFA_SET = (!mf.error && mf.data && mf.data[0]) || null;
  MFA_OV = new Map();
  const ov = await sb.rpc('admin_mfa_overview');          // exists after 012_mfa_totp_backup.sql
  if (!ov.error) (ov.data || []).forEach(o => MFA_OV.set(o.email, o));
  renderMfaCard();
  renderUsers();
}

/* ---------- email code (2FA) switches ---------- */
const mfaOn = u => MFA_SET && (MFA_SET.mode === 'all' || (MFA_SET.mode === 'pilot' && u.mfa_required === true));
function renderMfaCard(){
  const card = $('mfaCard');
  if (!MFA_SET) {
    $('mfaMode').disabled = $('mfaDays').disabled = $('mfaSave').disabled = true;
    $('mfaBulk').classList.add('hidden');
    $('mfaCardNote').textContent = 'Not installed yet: run 011_email_2fa.sql in Supabase and deploy the mfa-login function.';
    return;
  }
  $('mfaMode').disabled = $('mfaDays').disabled = $('mfaSave').disabled = false;
  $('mfaMode').value = MFA_SET.mode; $('mfaDays').value = String(MFA_SET.trust_days);
  $('mfaBulk').classList.toggle('hidden', MFA_SET.mode !== 'pilot');
  $('mfaCardNote').textContent = {
    off: 'Currently OFF — nobody is asked for a code. Choose “Selected people only” to start with a pilot group.',
    pilot: 'Only the people marked “Required” in the table (or ticked in Edit) are asked for a code at sign-in.',
    all: 'Everyone is asked for a code at sign-in.',
  }[MFA_SET.mode];
}
async function saveMfa(){
  $('mfaSave').disabled = true;
  const r = await sb.rpc('admin_set_mfa', { p_mode: $('mfaMode').value, p_trust_days: +$('mfaDays').value });
  $('mfaSave').disabled = false;
  if (r.error) return toast('Could not save: ' + r.error.message, true);
  toast('Sign-in security saved');
  await loadUsers();
}
async function bulkMfa(on){
  const ids = LAST_LIST.filter(x => x.status === 'active').map(x => x.id);
  if (!ids.length) return toast('No employees in the list', true);
  if (!confirm(`${on ? 'Require' : 'Stop requiring'} the email code for ${ids.length} employee${ids.length === 1 ? '' : 's'} in the list?`)) return;
  const { error } = await sb.from('employees').update({ mfa_required: on }).in('id', ids);
  if (error) return toast('Could not update: ' + error.message, true);
  toast('Updated ' + ids.length); await loadUsers();
}

function mfaCell(u){
  if (!MFA_SET) return '<span class="dash">—</span>';
  if (MFA_SET.mode === 'all') return '<span class="fc-badge fc-badge--info">Everyone</span>';
  const sel = u.mfa_required === true;
  const selfOn = u.mfa_self === true;
  const selfBadge = selfOn ? ` <span class="fc-badge fc-badge--neutral" title="Turned on by the person">Self</span>` : '';
  const badge = sel ? `<span class="fc-badge ${MFA_SET.mode === 'pilot' ? 'fc-badge--ok' : 'fc-badge--neutral'}">${MFA_SET.mode === 'pilot' ? 'Required' : 'Selected (off)'}</span>` : '<span class="dash">—</span>';
  const o = MFA_OV.get(u.email);
  const extra = o ? ` ${o.has_totp ? '<span class="fc-badge fc-badge--neutral" title="Authenticator app set up">App</span>' : ''}${o.backup_remaining > 0 ? `<span class="fc-badge fc-badge--neutral" title="Unused backup codes">${o.backup_remaining} codes</span>` : ''}` : '';
  return badge + selfBadge + extra + ` <button class="bar-btn" data-act="mfa" data-id="${u.id}">${sel ? 'Remove' : 'Require'}</button>`;
}

function renderUsers(){
  // separate filters, all applied together (AND); each box matches part of the text, case-insensitive
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm($('uSearch').value), qd = norm($('uDept').value), qc = norm($('uCc').value);
  const st = $('uStatus').value, qr = $('uRole').value;
  const dl = [...new Set(USERS.map(u => normDept(u.department)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('uDeptList').innerHTML = dl.map(d => `<option value="${esc(d)}"></option>`).join('');
  $('uCcList').innerHTML = ORG.map(o => `<option value="${esc(ccLabel(o))}"></option>`).join('');
  const list = USERS.filter(u => {
    if (st && u.status !== st) return false;
    if (q && !norm([u.fname, u.lname, u.fname + ' ' + u.lname, u.email, u.employee_no, u.title].join(' ')).includes(q)) return false;
    if (qr) { const rs = ROLES.get(u.email) || new Set(); if (qr === 'none' ? rs.size > 0 : qr === 'any' ? rs.size === 0 : !rs.has(qr)) return false; }
    if (qd && !norm(u.department).includes(qd)) return false;
    if (qc && !norm([u.cost_center_id, u.cost_center_name, ccLabel({ id: u.cost_center_id || '', name: u.cost_center_name || '' })].join(' ')).includes(qc)) return false;
    return true;
  });
  LAST_LIST = list;
  const active = USERS.filter(u => u.status === 'active').length;
  $('usersSummary').innerHTML =
    `<span class="fc-badge fc-badge--neutral">${USERS.length} employees</span>` +
    `<span class="fc-badge fc-badge--ok">${active} active</span>` +
    `<span class="fc-badge fc-badge--neutral">${USERS.length - active} resigned</span>` +
    (list.length !== USERS.length ? `<span class="fc-badge fc-badge--info">${list.length} shown</span>` : '');

  if (!list.length) {
    $('usersBody').innerHTML = `<tr><td colspan="8"><div class="fc-empty"><div class="fc-empty__title">No employees match</div>
      <p>Clear one of the filters (or press Clear), or add a new employee.</p></div></td></tr>`;
    return;
  }
  $('usersBody').innerHTML = list.map(u => {
    const roles = [...(ROLES.get(u.email) || [])].map(r => `<span class="chip">${esc(ROLE_LABEL[r] || r)}</span>`).join('');
    const resigned = u.status !== 'active';
    return `<tr>
      <td><div class="who"><span class="thumb">${thumbInner(u, true)}</span>
        <div><strong>${esc(u.fname)} ${esc(u.lname)}</strong><div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(u.email)}</div></div></div></td>
      <td>${esc(u.department || '—')}<div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(u.title || '')}</div></td>
      <td style="white-space:nowrap">${u.hire_date ? dmy(u.hire_date) : '<span class="dash">—</span>'}</td>
      <td>${esc(u.cost_center_name || '—')}${u.cost_center_id ? `<div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(u.cost_center_id)}</div>` : ''}</td>
      <td>${resigned ? '<span class="fc-badge fc-badge--neutral">Resigned</span>' : '<span class="fc-badge fc-badge--ok">Active</span>'}
        ${u.auth_user_id ? '' : '<span class="fc-badge fc-badge--warn">No login</span>'}</td>
      <td style="white-space:nowrap">${mfaCell(u)}</td>
      <td><div class="chips" style="margin:0">${roles || '<span class="dash">—</span>'}</div></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="bar-btn" data-act="edit" data-id="${u.id}">Edit</button>
        <button class="bar-btn" data-act="resetmfa" data-id="${u.id}" ${u.auth_user_id && MFA_SET ? '' : 'disabled'} title="Clear email-code sessions, remembered browsers, authenticator app and backup codes">Reset 2FA</button>
        <button class="bar-btn" data-act="reset" data-id="${u.id}" ${u.auth_user_id ? '' : 'disabled'}>Reset password</button>
        <button class="bar-btn" data-act="maillogin" data-id="${u.id}" ${u.auth_user_id && !resigned ? '' : 'disabled'} title="Email this person their username and password (first use)">Email login</button>
        <button class="bar-btn" data-act="toggle" data-id="${u.id}">${resigned ? 'Reactivate' : 'Mark resigned'}</button>
      </td></tr>`;
  }).join('');
}

/* ---------- add / edit dialog ---------- */
let CAR_COL = true;                // does employees.car_no exist yet?
const F = ['fname', 'lname', 'email', 'employee_no', 'department', 'title', 'tel', 'ext', 'car_no', 'hire_date'];
const fid = k => 'ue_' + k;

function openEdit(u){
  EDITING = u || null;
  $('ueTitle').textContent = u ? 'Edit employee' : 'Add employee';
  F.forEach(k => { $(fid(k)).value = u ? (u[k] ?? '') : ''; });
  $('ue_car_no').closest('label').classList.toggle('hidden', !CAR_COL);
  $(fid('email')).readOnly = !!u;
  // cost center: type freely; matching entries from the Organizational Unit sheet (org_units) are suggested to pick
  $('ccList').innerHTML = ORG.map(o => `<option value="${esc(ccLabel(o))}"></option>`).join('');
  const own = u && u.cost_center_id ? ORG.find(o => o.id === u.cost_center_id) : null;
  $('ue_cost_center').value = own ? ccLabel(own) : (u?.cost_center_name || '');
  updateCcHint();
  renderDeptPicker();
  $('ueErr').textContent = '';
  // photo: existing employees are saved at once; for a new employee the picture is kept here and uploaded after the account is created
  clearNewPhoto(); $('uePhotoRemove').classList.add('hidden');
  $('uePhotoRow').classList.remove('hidden');
  $('uePhotoBtn').textContent = u ? 'Change photo' : 'Add photo';
  if (u) setEditThumb(u); else $('uePhotoThumb').textContent = '+';
  const mine = ROLES.get(u?.email) || new Set();
  $('ue_r_platform').checked = mine.has('platform:admin');
  $('ue_r_fuel').checked = mine.has('fuel:admin');
  $('ue_r_homemap').checked = mine.has('homemap:viewer');
  $('ueMfaRow').classList.toggle('hidden', !MFA_SET);
  $('ue_mfa').checked = !!(u && u.mfa_required === true);
  $('ueMfaNote').textContent = !MFA_SET ? '' : MFA_SET.mode === 'all' ? '— everyone is required right now' : MFA_SET.mode === 'off' ? '— takes effect when the setting above is not “Nobody”' : '';
  $('ueRoles').classList.toggle('hidden', !u);   // roles can be granted after the account exists
  $('ueHint').textContent = u ? '' : 'A login account is created with a password (first name + last 4 digits of phone, or Employee ID). At first sign-in the employee is advised (not forced) to choose their own.';
  $('ueSave').textContent = u ? 'Save changes' : 'Create employee';
  $('userModal').classList.remove('hidden');
  $(fid('fname')).focus();
}
/* ---------- department: pick from departments already in the system (or type a new one) ---------- */
const normDept = s => String(s || '').trim().replace(/\s+/g, ' ');
function deptCounts(){
  const m = new Map();
  USERS.forEach(x => { const d = normDept(x.department); if (d) m.set(d, (m.get(d) || 0) + 1); });
  return m;
}
function resolveDept(text){            // existing spelling wins (case-insensitive), so "service - robot" never creates a duplicate
  const t = normDept(text);
  if (!t) return { name: null, existing: false };
  for (const d of deptCounts().keys()) if (d.toLowerCase() === t.toLowerCase()) return { name: d, existing: true };
  return { name: t, existing: false };
}
function renderDeptPicker(){
  const counts = deptCounts();
  const list = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  $('deptList').innerHTML = list.map(d => `<option value="${esc(d)}"></option>`).join('');
  const cur = resolveDept($('ue_department').value);
  $('deptChips').innerHTML = list.map(d =>
    `<button type="button" class="dept-chip${cur.existing && cur.name === d ? ' is-on' : ''}" data-d="${esc(d)}" title="${counts.get(d)} employee(s)">${esc(d)}</button>`).join('');
  const h = $('deptHint');
  if (!$('ue_department').value.trim()) { h.textContent = ''; h.style.color = 'var(--fc-text-mute)'; }
  else if (cur.existing) { h.textContent = `Existing department (${counts.get(cur.name)} employee${counts.get(cur.name) === 1 ? '' : 's'}).`; h.style.color = 'var(--fc-ok)'; }
  else { h.textContent = 'New department — saved as typed.'; h.style.color = 'var(--fc-warn)'; }
}

/* ---------- cost center: free text that links to org_units when it matches ---------- */
const ccLabel = o => `${o.id} — ${o.name}`;
function resolveCc(text){
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (!t) return { id: null, name: null, linked: false };
  const k = t.toLowerCase();
  let o = ORG.find(x => ccLabel(x).toLowerCase() === k) || ORG.find(x => x.id.toLowerCase() === k);
  if (!o) { const byName = ORG.filter(x => x.name.toLowerCase().replace(/\s+/g, ' ') === k); if (byName.length === 1) o = byName[0]; }
  return o ? { id: o.id, name: o.name, linked: true } : { id: null, name: t, linked: false };
}
function updateCcHint(){
  const r = resolveCc($('ue_cost_center').value);
  const h = $('ccHint');
  if (!$('ue_cost_center').value.trim()) { h.textContent = ''; return; }
  h.textContent = r.linked ? `Linked: ${r.id} — ${r.name}` : 'Not in the list — saved as typed.';
  h.style.color = r.linked ? 'var(--fc-ok)' : 'var(--fc-text-mute)';
}

function setEditThumb(u){
  const t = $('uePhotoThumb');
  t.innerHTML = thumbInner(u, false);
}
// Photo fills the whole square; the initial letter is shown only when there is no photo (or it fails to load)
function thumbInner(u, lazy){
  const ini = esc((u.fname || '?').charAt(0).toUpperCase());
  if (!u.photo_path) return ini;
  return `<img ${lazy ? 'loading="lazy" ' : ''}alt="" data-i="${ini}" src="${photoUrl(u.photo_path)}" onerror="this.replaceWith(document.createTextNode(this.dataset.i))">`;
}
let NEW_PHOTO = null, NEW_PHOTO_URL = null;    // picture chosen in "Add employee" (cropped JPEG blob)
function clearNewPhoto(){
  if (NEW_PHOTO_URL) URL.revokeObjectURL(NEW_PHOTO_URL);
  NEW_PHOTO = NEW_PHOTO_URL = null;
}
function editPhoto(){
  const u = EDITING;
  if (!u) {                                   // adding a new employee
    const nm = `${$(fid('fname')).value} ${$(fid('lname')).value}`.trim();
    openPhoto({ id: null, name: nm || 'new employee', path: null, self: false, deferred: true, onBlob: b => {
      clearNewPhoto(); NEW_PHOTO = b; NEW_PHOTO_URL = URL.createObjectURL(b);
      $('uePhotoThumb').innerHTML = `<img alt="" src="${NEW_PHOTO_URL}">`;
      $('uePhotoBtn').textContent = 'Change photo'; $('uePhotoRemove').classList.remove('hidden');
    } });
    return;
  }
  openPhoto({ id: u.id, name: u.fname + ' ' + u.lname, path: u.photo_path || null, self: false,
    onSaved: p => { u.photo_path = p; setEditThumb(u); loadUsers(); } });
}

function suggestEmail(){
  if (EDITING || $(fid('email')).value) return;
  const f = $(fid('fname')).value.trim().split(/\s+/)[0], l = $(fid('lname')).value.trim();
  if (f && l) $(fid('email')).value = `${f}.${l[0]}@fth.fanuc.com`.toLowerCase();
}

async function saveEdit(e){
  e.preventDefault();
  const v = Object.fromEntries(F.map(k => [k, $(fid(k)).value.trim()]));
  v.department = resolveDept(v.department).name || '';
  if (!v.fname || !v.lname) { $('ueErr').textContent = 'First name and last name are required.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) { $('ueErr').textContent = 'Enter a valid email, e.g. name.s@fth.fanuc.com'; return; }
  $('ueSave').disabled = true; $('ueErr').textContent = '';
  try {
    if (EDITING) {
      const patch = {};
      F.filter(k => k !== 'email').forEach(k => { patch[k] = v[k] === '' ? null : v[k]; });
      if (!CAR_COL) delete patch.car_no;
      const cc = resolveCc($('ue_cost_center').value);
      patch.cost_center_id = cc.id; patch.cost_center_name = cc.name;
      if (MFA_SET) patch.mfa_required = $('ue_mfa').checked;
      const { error } = await sb.from('employees').update(patch).eq('id', EDITING.id);
      if (error) throw error;
      // admin roles (changes only)
      const had = ROLES.get(EDITING.email) || new Set();
      for (const [key, el] of [['platform:admin', 'ue_r_platform'], ['fuel:admin', 'ue_r_fuel'], ['homemap:viewer', 'ue_r_homemap']]) {
        const want = $(el).checked;
        if (want !== had.has(key)) {
          const [app, role] = key.split(':');
          const r = await sb.rpc('admin_set_role', { p_email: EDITING.email, p_app: app, p_role: role, p_grant: want });
          if (r.error) throw r.error;
        }
      }
      $('userModal').classList.add('hidden');
      toast('Saved');
    } else {
      const cc = resolveCc($('ue_cost_center').value);
      const out = await callFn('create', { ...v, email: v.email.toLowerCase(), cost_center_id: cc.id, cost_center_name: cc.name });
      $('userModal').classList.add('hidden');
      // photo chosen in the dialog: needs the new employee's id, so upload it now
      let photoNote = '';
      if (NEW_PHOTO) {
        try {
          const { data: row, error: qe } = await sb.from('employees').select('id').eq('email', v.email.toLowerCase()).maybeSingle();
          if (qe || !row) throw qe || new Error('employee not found');
          await phUploadFor(row.id, NEW_PHOTO, false);
        } catch (pe) { photoNote = `The photo could not be saved (${pe.message || pe}) — open Edit to add it.`; }
        clearNewPhoto();
      }
      showResult('Employee created', v.email.toLowerCase(), out.tempPassword,
        out.created ? null : 'This email already had a login account, so its password was not changed.', photoNote);
    }
    await loadUsers();
  } catch (err) {
    $('ueErr').textContent = err.message || String(err);
  } finally {
    $('ueSave').disabled = false;
  }
}

/* ---------- result dialog (password shown once) ---------- */
let RESULT_EMAIL = '';
function showResult(title, email, pw, note, extra){
  RESULT_EMAIL = email;
  $('urTitle').textContent = title;
  $('urEmail').textContent = email;
  $('urMailRow').classList.toggle('hidden', !pw);   // offer to email the details only when a password was just issued
  $('urTo').value = email;
  $('urPwRow').classList.toggle('hidden', !pw);
  $('urPw').textContent = pw || '';
  $('urNote').textContent = (note || (pw ? 'Share this password with the employee. It is shown only once; at first sign-in they are advised (not forced) to choose their own.' : '')) + (extra ? ' ' + extra : '');
  $('resultModal').classList.remove('hidden');
}

/* ---------- row actions ---------- */
async function onRowAction(ev){
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const u = USERS.find(x => x.id === b.dataset.id); if (!u) return;
  if (b.dataset.act === 'edit') return openEdit(u);
  if (b.dataset.act === 'maillogin') return openMail([u]);
  if (b.dataset.act === 'mfa') {
    b.disabled = true;
    const { error } = await sb.from('employees').update({ mfa_required: u.mfa_required !== true }).eq('id', u.id);
    if (error) { b.disabled = false; return toast('Could not update: ' + error.message, true); }
    return loadUsers();
  }

  b.disabled = true;
  try {
    if (b.dataset.act === 'reset') {
      if (!confirm(`Reset the password for ${u.fname} ${u.lname}?\nTheir current password stops working immediately.`)) return;
      const out = await callFn('reset_password', { email: u.email });
      showResult('Password reset', u.email, out.tempPassword);
    } else if (b.dataset.act === 'resetmfa') {
      if (!confirm(`Reset sign-in verification for ${u.fname} ${u.lname}?\n\nAll their sessions must verify again, remembered browsers are forgotten, and their authenticator app and backup codes are removed so they can set them up again.`)) return;
      await callFn('reset_mfa', { email: u.email });
      toast('Verification reset — they will be asked again at the next sign-in');
      await loadUsers();
    } else if (b.dataset.act === 'toggle') {
      const resign = u.status === 'active';
      if (!confirm(resign
        ? `Mark ${u.fname} ${u.lname} as resigned?\nThey will be signed out and blocked from signing in.`
        : `Reactivate ${u.fname} ${u.lname}?\nThey will be able to sign in again.`)) return;
      await callFn('set_active', { email: u.email, active: !resign });
      toast(resign ? 'Marked as resigned — sign-in blocked' : 'Reactivated');
      await loadUsers();
    }
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    b.disabled = false;
  }
}

/* ---------- email sign-in details (username + password), each person their own ---------- */
let MAIL_LIST = [];
let MAIL_INIT = new Set();            // ids shown in the Manage users list when the dialog was opened (its filters)
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const mailOk = u => u.auth_user_id && u.status === 'active';
function mailRows(){ return [...$('mlBody').querySelectorAll('tr')]; }
function mailShown(){ return mailRows().filter(r => r.style.display !== 'none'); }
function mailCount(){
  const sh = mailShown(), n = sh.filter(r => r.querySelector('.ml-ck').checked).length, can = sh.filter(r => !r.dataset.cant).length;
  $('mlCount').textContent = `Selected: ${n} of ${can}`;
  $('mlAll').checked = can > 0 && n === can;
}
// choose who is listed (and ticked): the list as filtered on the page, every department, or one department
function mailPick(){
  const v = $('mlDept').value;
  mailRows().forEach(r => {
    const u = MAIL_LIST[+r.dataset.i];
    const show = v === '__list' ? MAIL_INIT.has(u.id) : v === '__none' ? !normDept(u.department) : (v === '' || normDept(u.department) === v);
    r.style.display = show ? '' : 'none';
    r.querySelector('.ml-ck').checked = show && !r.dataset.cant;
  });
  mailCount();
}
// who already signed in / was emailed before (warning only — they can still be sent)
let MAIL_STATUS = Promise.resolve(), MAIL_STATUS_OK = false;
async function loadMailStatus(){
  MAIL_STATUS_OK = false;
  try {
    const out = await callFn('login_status', { emails: MAIL_LIST.map(u => u.email) });
    mailRows().forEach(r => {
      const u = MAIL_LIST[+r.dataset.i], st = out.status?.[u.email.toLowerCase()];
      if (!st) return;
      r.dataset.signed = st.signed_in || ''; r.dataset.sent = st.mail_sent || '';
      const chips = [];
      const cant = st.own_password ? 'Chose own password — cannot be sent' : st.no_formula ? 'Password unknown — cannot be sent' : '';
      if (cant) {   // the password is stored one-way: it can only be sent while the person still has the initial one
        r.dataset.cant = '1';
        const ck = r.querySelector('.ml-ck'); ck.checked = false; ck.disabled = true;
        chips.push(`<span class="fc-badge fc-badge--neutral" title="Their password cannot be read back. Use Reset password if they need a new one.">${cant}</span>`);
      }
      if (st.signed_in && !cant) chips.push(`<span class="fc-badge fc-badge--warn" title="This person has already signed in with the password they were given but has not chosen their own yet.">Signed in before ${dmy(st.signed_in)}</span>`);
      if (st.mail_sent) chips.push(`<span class="fc-badge fc-badge--info" title="Sign-in details were already emailed to this person.">Email sent ${dmy(st.mail_sent)}</span>`);
      const c = r.querySelector('.ml-res');
      if (chips.length && c.textContent === '—') c.innerHTML = chips.join(' ');
    });
    MAIL_STATUS_OK = true;
    mailCount();
  } catch (err) { /* status is only a hint — sending still works */ }
}
function openMail(list, pickDept){
  MAIL_INIT = new Set(list.filter(mailOk).map(u => u.id));
  MAIL_LIST = (pickDept ? USERS : list).filter(mailOk);
  if (!MAIL_LIST.length) return toast('No one in the list can be emailed (needs an active employee with a login account).', true);
  $('mlSummary').textContent = '';
  $('mlBody').innerHTML = MAIL_LIST.map((u, i) => `<tr data-i="${i}">
      <td><input type="checkbox" class="ml-ck" checked></td>
      <td><strong>${esc(u.fname)} ${esc(u.lname)}</strong><div class="fc-mut" style="font-size:calc(12px * var(--ts,1))">${esc(u.department || '—')}</div></td>
      <td><input type="email" class="fc-input ml-to" value="${esc(u.email)}" autocomplete="off"></td>
      <td class="ml-res fc-mut">—</td></tr>`).join('');
  MAIL_STATUS = loadMailStatus();
  // department picker (only when opened from the toolbar)
  $('mlDeptRow').classList.toggle('hidden', !pickDept);
  if (pickDept) {
    const m = new Map();
    MAIL_LIST.forEach(u => { const d = normDept(u.department); if (d) m.set(d, (m.get(d) || 0) + 1); });
    const noDept = MAIL_LIST.filter(u => !normDept(u.department)).length;
    $('mlDept').innerHTML = `<option value="__list">As filtered in the list (${MAIL_INIT.size})</option>` +
      `<option value="">All departments (${MAIL_LIST.length})</option>` +
      [...m.keys()].sort((a, b) => a.localeCompare(b)).map(d => `<option value="${esc(d)}">${esc(d)} (${m.get(d)})</option>`).join('') +
      (noDept ? `<option value="__none">No department (${noDept})</option>` : '');
    const cur = resolveDept($('uDept').value);   // a department typed in the page filter starts selected
    $('mlDept').value = cur.existing ? cur.name : '__list';
  }
  mailPick();
  $('mlSend').disabled = false;
  $('mailModal').classList.remove('hidden');
}
async function sendMails(){
  const rows = mailShown().filter(r => r.querySelector('.ml-ck').checked);
  if (!rows.length) return toast('Tick at least one person.', true);
  for (const r of rows) {
    const to = r.querySelector('.ml-to').value.trim();
    if (!MAIL_RE.test(to)) { const c = r.querySelector('.ml-res'); c.textContent = 'Invalid email'; c.style.color = 'var(--fc-danger, #b91c1c)'; return toast('Fix the email address first.', true); }
  }
  const nSigned = rows.filter(r => r.dataset.signed).length, nSent = rows.filter(r => r.dataset.sent).length;
  let warn = '';
  if (nSigned) warn += `\n⚠ ${nSigned} of them have already signed in with the password they were given.`;
  if (nSent) warn += `\n⚠ ${nSent} of them were already emailed their sign-in details before.`;
  if (!confirm(`Email each of the ${rows.length} selected person${rows.length === 1 ? '' : 's'} their username and password?\n\nPasswords are NOT changed — the email contains the password they already have.${warn}`)) return;
  $('mlSend').disabled = true;
  let ok = 0, skip = 0, bad = 0;
  for (const r of rows) {
    const u = MAIL_LIST[+r.dataset.i], c = r.querySelector('.ml-res');
    c.style.color = ''; c.textContent = 'Sending…';
    try {
      const out = await callFn('send_login', { email: u.email, to: r.querySelector('.ml-to').value.trim().toLowerCase() });
      if (out.ok) {
        ok++; c.textContent = '✔ Sent to ' + out.to + (out.sentBefore ? ' · sent again (first sent ' + dmy(out.sentBefore) + ')' : '');
        c.style.color = 'var(--fc-ok, #15803d)'; r.querySelector('.ml-ck').checked = false; r.dataset.sent = new Date().toISOString();
      }
      else {
        skip++;
        c.textContent = { own_password: 'Skipped — chose own password', no_formula: 'Skipped — password unknown', resigned: 'Skipped — resigned', no_login: 'Skipped — no login account' }[out.skipped] || 'Skipped';
        c.style.color = 'var(--fc-warn, #b45309)';
      }
    } catch (err) { bad++; c.textContent = '✖ ' + (err.message || err); c.style.color = 'var(--fc-danger, #b91c1c)'; }
  }
  mailCount();
  $('mlSummary').textContent = `Sent ${ok}${skip ? ', skipped ' + skip : ''}${bad ? ', failed ' + bad : ''}.`;
  $('mlSend').disabled = false;
}

function wireUsers(){
  $('btnUsers').onclick = async () => { show('viewUsers'); await loadUsers(); };
  $('btnUsersBack').onclick = () => show('viewMain');
  $('btnAddUser').onclick = () => openEdit(null);
  $('uSearch').oninput = renderUsers; $('uDept').oninput = renderUsers; $('uCc').oninput = renderUsers;
  $('uClear').onclick = () => { $('uSearch').value = $('uDept').value = $('uCc').value = ''; $('uStatus').value = 'active'; $('uRole').value = ''; renderUsers(); };
  $('uStatus').onchange = renderUsers; $('uRole').onchange = renderUsers;
  $('usersBody').onclick = onRowAction;
  $('userForm').onsubmit = saveEdit;
  $('ueCancel').onclick = () => $('userModal').classList.add('hidden');
  $(fid('lname')).onblur = suggestEmail;
  $('ue_cost_center').oninput = updateCcHint;
  $('mfaSave').onclick = saveMfa;
  $('mfaAllShown').onclick = () => bulkMfa(true);
  $('mfaNoneShown').onclick = () => bulkMfa(false);
  $('ue_department').oninput = renderDeptPicker;
  $('ue_department').onfocus = e => e.target.select();
  $('deptChips').onclick = e => { const b = e.target.closest('[data-d]'); if (b) { $('ue_department').value = b.dataset.d; renderDeptPicker(); } };
  $('uePhotoBtn').onclick = editPhoto;
  $('uePhotoRemove').onclick = () => { clearNewPhoto(); $('uePhotoThumb').textContent = '+'; $('uePhotoBtn').textContent = 'Add photo'; $('uePhotoRemove').classList.add('hidden'); };
  $('urClose').onclick = () => $('resultModal').classList.add('hidden');
  $('btnMailLogins').onclick = () => openMail(LAST_LIST, true);
  $('mlDept').onchange = mailPick;
  // tick only the people (in the department shown) who have never signed in
  $('mlNew').onclick = async () => {
    $('mlNew').disabled = true;
    await MAIL_STATUS;
    $('mlNew').disabled = false;
    if (!MAIL_STATUS_OK) return toast('Could not check who has signed in yet — try again in a moment.', true);
    mailShown().forEach(r => { r.querySelector('.ml-ck').checked = !r.dataset.signed && !r.dataset.cant; });
    mailCount();
  };
  $('mlBody').onchange = e => { if (e.target.classList.contains('ml-ck')) mailCount(); };
  $('mlClose').onclick = () => $('mailModal').classList.add('hidden');
  $('mlSend').onclick = sendMails;
  $('mlAll').onchange = e => { mailShown().forEach(r => { r.querySelector('.ml-ck').checked = e.target.checked && !r.dataset.cant; }); mailCount(); };
  $('urMail').onclick = async () => {
    const to = $('urTo').value.trim();
    if (!MAIL_RE.test(to)) return toast('Enter a valid email address.', true);
    $('urMail').disabled = true;
    try {
      const out = await callFn('send_login', { email: RESULT_EMAIL, to, reveal: true });
      if (out.tempPassword) $('urPw').textContent = out.tempPassword;
      toast('Email sent to ' + out.to);
    } catch (err) {
      if (err.message && /could not be sent/.test(err.message)) toast(err.message, true); else toast(err.message || String(err), true);
    } finally { $('urMail').disabled = false; }
  };
  $('urCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('urPw').textContent); toast('Copied'); } catch { toast('Copy failed — select the text and copy manually', true); }
  };
}
