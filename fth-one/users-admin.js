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
  $('usersBody').innerHTML = '<tr><td colspan="7"><div class="fc-skeleton" style="height:120px"></div></td></tr>';
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
  ROLES = new Map();
  if (roles.error) toast('Could not load roles (did you run 005_user_management.sql?): ' + roles.error.message, true);
  else (roles.data || []).forEach(r => {
    if (!ROLES.has(r.email)) ROLES.set(r.email, new Set());
    ROLES.get(r.email).add(`${r.app}:${r.role}`);
  });
  renderUsers();
}

function renderUsers(){
  const q = $('uSearch').value.trim().toLowerCase();
  const st = $('uStatus').value;
  const list = USERS.filter(u => {
    if (st && u.status !== st) return false;
    if (!q) return true;
    return [u.fname, u.lname, u.email, u.department, u.title, u.employee_no, u.cost_center_name].join(' ').toLowerCase().includes(q);
  });
  const active = USERS.filter(u => u.status === 'active').length;
  $('usersSummary').innerHTML =
    `<span class="fc-badge fc-badge--neutral">${USERS.length} employees</span>` +
    `<span class="fc-badge fc-badge--ok">${active} active</span>` +
    `<span class="fc-badge fc-badge--neutral">${USERS.length - active} resigned</span>` +
    (list.length !== USERS.length ? `<span class="fc-badge fc-badge--info">${list.length} shown</span>` : '');

  if (!list.length) {
    $('usersBody').innerHTML = `<tr><td colspan="7"><div class="fc-empty"><div class="fc-empty__title">No employees match</div>
      <p>Clear the search box or status filter, or add a new employee.</p></div></td></tr>`;
    return;
  }
  $('usersBody').innerHTML = list.map(u => {
    const roles = [...(ROLES.get(u.email) || [])].map(r => `<span class="chip">${esc(ROLE_LABEL[r] || r)}</span>`).join('');
    const resigned = u.status !== 'active';
    return `<tr>
      <td><div class="who"><span class="thumb">${thumbInner(u, true)}</span>
        <div><strong>${esc(u.fname)} ${esc(u.lname)}</strong><div class="fc-mut" style="font-size:12px">${esc(u.email)}</div></div></div></td>
      <td>${esc(u.department || '—')}<div class="fc-mut" style="font-size:12px">${esc(u.title || '')}</div></td>
      <td style="white-space:nowrap">${u.hire_date ? dmy(u.hire_date) : '<span class="dash">—</span>'}</td>
      <td>${esc(u.cost_center_name || '—')}${u.cost_center_id ? `<div class="fc-mut" style="font-size:12px">${esc(u.cost_center_id)}</div>` : ''}</td>
      <td>${resigned ? '<span class="fc-badge fc-badge--neutral">Resigned</span>' : '<span class="fc-badge fc-badge--ok">Active</span>'}
        ${u.auth_user_id ? '' : '<span class="fc-badge fc-badge--warn">No login</span>'}</td>
      <td><div class="chips" style="margin:0">${roles || '<span class="dash">—</span>'}</div></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="bar-btn" data-act="edit" data-id="${u.id}">Edit</button>
        <button class="bar-btn" data-act="reset" data-id="${u.id}" ${u.auth_user_id ? '' : 'disabled'}>Reset password</button>
        <button class="bar-btn" data-act="toggle" data-id="${u.id}">${resigned ? 'Reactivate' : 'Mark resigned'}</button>
      </td></tr>`;
  }).join('');
}

/* ---------- add / edit dialog ---------- */
const F = ['fname', 'lname', 'email', 'employee_no', 'department', 'title', 'tel', 'ext', 'hire_date'];
const fid = k => 'ue_' + k;

function openEdit(u){
  EDITING = u || null;
  $('ueTitle').textContent = u ? 'Edit employee' : 'Add employee';
  F.forEach(k => { $(fid(k)).value = u ? (u[k] ?? '') : ''; });
  $(fid('email')).readOnly = !!u;
  // cost center: type freely; matching entries from the Organizational Unit sheet (org_units) are suggested to pick
  $('ccList').innerHTML = ORG.map(o => `<option value="${esc(ccLabel(o))}"></option>`).join('');
  const own = u && u.cost_center_id ? ORG.find(o => o.id === u.cost_center_id) : null;
  $('ue_cost_center').value = own ? ccLabel(own) : (u?.cost_center_name || '');
  updateCcHint();
  renderDeptPicker();
  $('ueErr').textContent = '';
  // photo (existing employees only)
  $('uePhotoRow').classList.toggle('hidden', !u);
  if (u) setEditThumb(u);
  const mine = ROLES.get(u?.email) || new Set();
  $('ue_r_platform').checked = mine.has('platform:admin');
  $('ue_r_fuel').checked = mine.has('fuel:admin');
  $('ue_r_homemap').checked = mine.has('homemap:viewer');
  $('ueRoles').classList.toggle('hidden', !u);   // roles can be granted after the account exists
  $('ueHint').textContent = u ? '' : 'A login account is created with a temporary password (first name + last 4 digits of phone, or Employee ID). The employee must choose a new password at first sign-in.';
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
  if (!$('ue_department').value.trim()) { h.textContent = 'Click a department below, or start typing.'; h.style.color = 'var(--fc-text-mute)'; }
  else if (cur.existing) { h.textContent = `Existing department (${counts.get(cur.name)} employee${counts.get(cur.name) === 1 ? '' : 's'}).`; h.style.color = 'var(--fc-ok)'; }
  else { h.textContent = 'New department — it will be created exactly as typed. Check the spelling first.'; h.style.color = 'var(--fc-warn)'; }
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
  if (!$('ue_cost_center').value.trim()) { h.textContent = 'Start typing a code or name (e.g. FTH1SA2 or Sales - Robot) to see matching cost centers.'; return; }
  h.textContent = r.linked ? `Linked to ${r.id} — ${r.name}` : 'Not in the cost center list — it will be saved exactly as typed.';
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
function editPhoto(){
  const u = EDITING; if (!u) return;
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
      const cc = resolveCc($('ue_cost_center').value);
      patch.cost_center_id = cc.id; patch.cost_center_name = cc.name;
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
      showResult('Employee created', v.email.toLowerCase(), out.tempPassword,
        out.created ? null : 'This email already had a login account, so its password was not changed.');
    }
    await loadUsers();
  } catch (err) {
    $('ueErr').textContent = err.message || String(err);
  } finally {
    $('ueSave').disabled = false;
  }
}

/* ---------- result dialog (temporary password shown once) ---------- */
function showResult(title, email, pw, note){
  $('urTitle').textContent = title;
  $('urEmail').textContent = email;
  $('urPwRow').classList.toggle('hidden', !pw);
  $('urPw').textContent = pw || '';
  $('urNote').textContent = note || (pw ? 'Share this temporary password with the employee. It is shown only once; they must choose their own at first sign-in.' : '');
  $('resultModal').classList.remove('hidden');
}

/* ---------- row actions ---------- */
async function onRowAction(ev){
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const u = USERS.find(x => x.id === b.dataset.id); if (!u) return;
  if (b.dataset.act === 'edit') return openEdit(u);

  b.disabled = true;
  try {
    if (b.dataset.act === 'reset') {
      if (!confirm(`Reset the password for ${u.fname} ${u.lname}?\nTheir current password stops working immediately.`)) return;
      const out = await callFn('reset_password', { email: u.email });
      showResult('Password reset', u.email, out.tempPassword);
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

function wireUsers(){
  $('btnUsers').onclick = async () => { show('viewUsers'); await loadUsers(); };
  $('btnUsersBack').onclick = () => show('viewMain');
  $('btnAddUser').onclick = () => openEdit(null);
  $('uSearch').oninput = renderUsers;
  $('uStatus').onchange = renderUsers;
  $('usersBody').onclick = onRowAction;
  $('userForm').onsubmit = saveEdit;
  $('ueCancel').onclick = () => $('userModal').classList.add('hidden');
  $(fid('lname')).onblur = suggestEmail;
  $('ue_cost_center').oninput = updateCcHint;
  $('ue_department').oninput = renderDeptPicker;
  $('ue_department').onfocus = e => e.target.select();
  $('deptChips').onclick = e => { const b = e.target.closest('[data-d]'); if (b) { $('ue_department').value = b.dataset.d; renderDeptPicker(); } };
  $('uePhotoBtn').onclick = editPhoto;
  $('urClose').onclick = () => $('resultModal').classList.add('hidden');
  $('urCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('urPw').textContent); toast('Copied'); } catch { toast('Copy failed — select the text and copy manually', true); }
  };
}
