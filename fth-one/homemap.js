/* =====================================================================
   Home map — uses globals from index.html: sb, $, esc, dmy, toast, show, MY_EMP_ID, IS_PLATFORM_ADMIN, L (Leaflet)
   1) Employees pin their own home (exact point, explicit consent, can change/remove any time)  -> table homemap_locations
   2) People with the homemap/viewer role see an anonymous overview of all of Thailand            -> RPC homemap_overview / homemap_stats
      Opening a person's name is logged on the server (RPC homemap_person -> homemap_access_log)
   Province is worked out in the browser from th-provinces.json (open data, 77 provinces) — home coordinates are never
   sent to any third-party geocoder. Map tiles come from OpenStreetMap (they only learn which area is being viewed).
   ===================================================================== */
const CONSENT_VERSION = 'v1-2026-10';
const TH_BOUNDS = [[5.6, 97.3], [20.5, 105.7]];
const OSM = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors' };

let IS_HOMEMAP_VIEWER = false;
let PROV = null;

/* ---------- province lookup (point in polygon) ---------- */
async function loadProvinces(){
  if (PROV) return PROV;
  const r = await fetch('th-provinces.json');
  if (!r.ok) throw new Error('Could not load the province boundary file');
  PROV = await r.json();
  PROV.features.forEach(f => {
    let a = 999, b = 999, c = -999, d = -999;
    f.geometry.coordinates.forEach(p => p[0].forEach(([x, y]) => { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); d = Math.max(d, y); }));
    f._bb = [a, b, c, d];
  });
  return PROV;
}
function inRing(x, y, r){
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function findProvince(lat, lng){
  if (!PROV) return null;
  for (const f of PROV.features) {
    const bb = f._bb; if (lng < bb[0] || lng > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    for (const poly of f.geometry.coordinates) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some(h => inRing(lng, lat, h))) return f.properties;
    }
  }
  // coastline / simplified-border tolerance: nearest boundary vertex within ~5 km
  let best = null, bd = 0.05 * 0.05;
  for (const f of PROV.features) for (const poly of f.geometry.coordinates) for (const [x, y] of poly[0]) {
    const d = (x - lng) * (x - lng) + (y - lat) * (y - lat);
    if (d < bd) { bd = d; best = f.properties; }
  }
  return best;
}

const pinIcon = () => L.divIcon({
  className: '',
  html: '<svg width="32" height="42" viewBox="0 0 32 42" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1Z" fill="#C32C30" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15" r="5.5" fill="#fff"/></svg>',
  iconSize: [32, 42], iconAnchor: [16, 41],
});

/* =====================================================================
   1) My home location (all employees)
   ===================================================================== */
let MY_LOC = null;
let pinMap = null, pinMarker = null, pinProv = null;

async function renderMyLocation(){
  const box = $('homeBody');
  const { data, error } = await sb.from('homemap_locations').select('*').eq('employee_id', MY_EMP_ID).maybeSingle();
  if (error) { box.innerHTML = `<p class="fc-note">Could not load your location: ${esc(error.message)}</p>`; return; }
  MY_LOC = data;
  if (!MY_LOC) {
    box.innerHTML = `<p class="fc-note" style="margin-top:0">You have not shared a home location. It is voluntary, and helps the company reach and assist employees during floods or other disasters.</p>
      <button class="fc-btn fc-btn--primary full" id="btnPin">Pin my home location</button>`;
  } else {
    box.innerHTML = `<div class="kv__row" style="padding-top:0"><span class="kv__ico"><svg class="ico"><use href="#i-pin"/></svg></span>
        <div><span class="kv__label">Shared on ${dmy(MY_LOC.consent_at)}</span><span class="kv__val">${esc(MY_LOC.province || 'Thailand')}${MY_LOC.region ? ' · ' + esc(MY_LOC.region) + ' region' : ''}</span></div></div>
      <div style="display:flex;gap:var(--fc-s2);flex-wrap:wrap"><button class="fc-btn" id="btnPin">Change</button>
      <button class="fc-btn" id="btnUnpin">Remove my location</button></div>`;
  }
  $('btnPin').onclick = openPin;
  if ($('btnUnpin')) $('btnUnpin').onclick = removeMyLocation;
}

async function removeMyLocation(){
  if (!confirm('Remove your home location? Your consent is withdrawn and the data is deleted.')) return;
  const { error } = await sb.from('homemap_locations').delete().eq('employee_id', MY_EMP_ID);
  if (error) return toast('Could not remove: ' + error.message, true);
  toast('Your location was removed');
  renderMyLocation();
}

function setPin(lat, lng, fly){
  lat = Math.round(lat * 1e6) / 1e6; lng = Math.round(lng * 1e6) / 1e6;
  if (!pinMarker) {
    pinMarker = L.marker([lat, lng], { draggable: true, icon: pinIcon() }).addTo(pinMap);
    pinMarker.on('dragend', () => { const p = pinMarker.getLatLng(); setPin(p.lat, p.lng, false); });
  } else pinMarker.setLatLng([lat, lng]);
  if (fly) pinMap.setView([lat, lng], Math.max(pinMap.getZoom(), 15));
  pinProv = findProvince(lat, lng);
  $('pinInfo').innerHTML = pinProv
    ? `<span class="fc-badge fc-badge--ok">${esc(pinProv.e)} · ${esc(pinProv.r)} region</span>`
    : '<span class="fc-badge fc-badge--danger">Outside Thailand — move the pin onto Thai territory</span>';
  updatePinSave();
}
function updatePinSave(){ $('pinSave').disabled = !(pinMarker && pinProv && $('pinConsent').checked); }

async function openPin(){
  $('pinErr').textContent = '';
  $('pinConsent').checked = false;
  $('pinModal').classList.remove('hidden');
  try { await loadProvinces(); } catch (e) { $('pinErr').textContent = e.message; }
  if (!pinMap) {
    pinMap = L.map('pinMap', { zoomControl: true }).fitBounds(TH_BOUNDS);
    L.tileLayer(OSM.url, { maxZoom: 19, attribution: OSM.attr }).addTo(pinMap);
    pinMap.on('click', e => setPin(e.latlng.lat, e.latlng.lng, false));
  }
  setTimeout(() => {
    pinMap.invalidateSize();
    if (pinMarker) { pinMap.removeLayer(pinMarker); pinMarker = null; }
    pinProv = null; $('pinInfo').innerHTML = '<span class="fc-mut">Click the map to drop the pin, or drag it to fine-tune.</span>';
    if (MY_LOC) { setPin(+MY_LOC.lat, +MY_LOC.lng, true); } else pinMap.fitBounds(TH_BOUNDS);
    updatePinSave();
  }, 60);
}

function useMyGps(){
  if (!navigator.geolocation) return ($('pinErr').textContent = 'This browser cannot share your current location — click the map instead.');
  $('pinErr').textContent = '';
  $('pinGps').disabled = true;
  navigator.geolocation.getCurrentPosition(
    p => { $('pinGps').disabled = false; setPin(p.coords.latitude, p.coords.longitude, true); },
    err => { $('pinGps').disabled = false; $('pinErr').textContent = 'Could not get your location (' + err.message + '). Allow location access, or click the map instead.'; },
    { enableHighAccuracy: true, timeout: 15000 });
}

async function savePin(e){
  e.preventDefault();
  if (!pinMarker || !pinProv) return;
  const p = pinMarker.getLatLng();
  $('pinSave').disabled = true; $('pinErr').textContent = '';
  const now = new Date().toISOString();
  const { error } = await sb.from('homemap_locations').upsert({
    employee_id: MY_EMP_ID, lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6,
    province: pinProv.e, province_code: pinProv.c, region: pinProv.r,
    consent_at: now, consent_version: CONSENT_VERSION, updated_at: now,
  }, { onConflict: 'employee_id' });
  if (error) { $('pinErr').textContent = 'Could not save: ' + error.message; updatePinSave(); return; }
  $('pinModal').classList.add('hidden');
  toast('Home location saved');
  renderMyLocation();
}

/* =====================================================================
   2) Overview map (homemap/viewer only)
   ===================================================================== */
let ovMap = null, ovProvLayer = null, ovDots = null, OV_ROWS = [], OV_STATS = null;

function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#C32C30'; }

async function openOverview(){
  show('viewMap');
  $('mapSummary').innerHTML = '<div class="fc-skeleton" style="height:72px"></div>';
  try { await loadProvinces(); } catch (e) { toast(e.message, true); return; }
  const [ov, st] = await Promise.all([sb.rpc('homemap_overview'), sb.rpc('homemap_stats')]);
  if (ov.error) return toast('Could not load the map: ' + ov.error.message, true);
  OV_ROWS = ov.data || [];
  OV_STATS = (st.data && st.data[0]) || { active_employees: 0, pinned: OV_ROWS.length };

  if (!ovMap) {
    ovMap = L.map('ovMap', { zoomControl: true }).fitBounds(TH_BOUNDS);
    L.tileLayer(OSM.url, { maxZoom: 19, attribution: OSM.attr }).addTo(ovMap);
  }
  setTimeout(() => { ovMap.invalidateSize(); ovMap.fitBounds(TH_BOUNDS); drawOverview(); }, 60);
}

function drawOverview(){
  const counts = {};
  OV_ROWS.forEach(r => { counts[r.province_code] = (counts[r.province_code] || 0) + 1; });
  const max = Math.max(1, ...Object.values(counts));
  const primary = css('--fc-primary');

  if (ovProvLayer) ovMap.removeLayer(ovProvLayer);
  ovProvLayer = L.geoJSON(PROV, {
    style: f => {
      const n = counts[f.properties.c] || 0;
      return { color: css('--fc-border-strong'), weight: 1, fillColor: primary, fillOpacity: n ? 0.12 + 0.5 * (n / max) : 0.02 };
    },
    onEachFeature: (f, layer) => {
      const n = counts[f.properties.c] || 0;
      layer.bindTooltip(`${f.properties.e}: ${n} ${n === 1 ? 'employee' : 'employees'}`, { sticky: true });
    },
  });
  if ($('lyProv').checked) ovProvLayer.addTo(ovMap);

  if (ovDots) ovMap.removeLayer(ovDots);
  ovDots = L.layerGroup();
  OV_ROWS.forEach(r => {
    const m = L.circleMarker([+r.lat, +r.lng], { radius: 6, color: '#fff', weight: 2, fillColor: primary, fillOpacity: 0.95 });
    m.bindPopup(() => popupFor(r));
    ovDots.addLayer(m);
  });
  if ($('lyDots').checked) ovDots.addTo(ovMap);

  // side panel
  const total = OV_STATS.active_employees || 0, pinned = OV_ROWS.length;
  const pct = total ? Math.round(pinned * 100 / total) : 0;
  $('mapSummary').innerHTML = `
    <div class="kpi kpi--main"><div class="kpi__label">Pinned</div><div class="kpi__value">${pinned}<span class="kpi__unit">of ${total} employees</span></div>
      <div class="kpi__sub">${pct}% have shared a home location</div></div>
    <div class="kpi"><div class="kpi__label">Not shared yet</div><div class="kpi__value">${Math.max(total - pinned, 0)}</div>
      <div class="kpi__sub">Sharing is voluntary</div></div>`;

  const byProv = {};
  OV_ROWS.forEach(r => { const k = r.province_code; (byProv[k] = byProv[k] || { c: k, e: r.province || 'Unknown', n: 0, region: r.region }).n++; });
  const list = Object.values(byProv).sort((a, b) => b.n - a.n || a.e.localeCompare(b.e));
  const regions = {};
  list.forEach(p => { regions[p.region || 'Unknown'] = (regions[p.region || 'Unknown'] || 0) + p.n; });
  $('mapRegions').innerHTML = Object.entries(regions).sort((a, b) => b[1] - a[1]).map(([r, n]) =>
    `<div class="bar"><span>${esc(r)}</span><div class="bar__track"><i style="width:${Math.round(n * 100 / Math.max(pinned, 1))}%"></i></div><b>${n}</b></div>`).join('')
    || '<p class="fc-note">No locations yet.</p>';
  $('mapProvinces').innerHTML = list.length ? list.map(p =>
    `<button class="plist__row" data-c="${esc(p.c)}"><span>${esc(p.e)}</span><b>${p.n}</b></button>`).join('')
    : '<p class="fc-note">No one has pinned a location yet. Ask employees to open their profile and choose "Pin my home location".</p>';
}

function popupFor(r){
  const el = document.createElement('div');
  el.innerHTML = `<strong>${esc(r.province || 'Thailand')}</strong><div class="fc-mut" style="font-size:12px;margin:4px 0 8px">${esc(r.region || '')} region</div>
    <button class="fc-btn fc-btn--sm" type="button">Show who</button>
    <div class="fc-mut" style="font-size:12px;margin-top:6px">Opening a name is recorded in the access log.</div>`;
  el.querySelector('button').onclick = async ev => {
    ev.target.disabled = true;
    const { data, error } = await sb.rpc('homemap_person', { p_id: r.id });
    if (error || !data || !data[0]) { toast(error ? error.message : 'Not available', true); ev.target.disabled = false; return; }
    const p = data[0];
    el.innerHTML = `<strong>${esc(p.fname)} ${esc(p.lname)}</strong>
      <div class="fc-mut" style="font-size:12px;margin-top:4px">${esc(p.department || '')}<br>${esc(p.province || '')}</div>
      <div class="fc-mut" style="font-size:12px;margin-top:6px">Logged: you opened this record.</div>`;
  };
  return el;
}

function zoomToProvince(code){
  const f = PROV.features.find(x => x.properties.c === code); if (!f) return;
  const b = f._bb; ovMap.fitBounds([[b[1], b[0]], [b[3], b[2]]], { maxZoom: 11 });
}

async function openAccessLog(){
  $('logBody').innerHTML = '<tr><td colspan="4"><div class="fc-skeleton" style="height:80px"></div></td></tr>';
  $('logModal').classList.remove('hidden');
  const { data, error } = await sb.rpc('homemap_access_history', { p_limit: 200 });
  if (error) { $('logBody').innerHTML = `<tr><td colspan="4">${esc(error.message)}</td></tr>`; return; }
  $('logBody').innerHTML = (data || []).map(a => `<tr><td>${dmy(a.viewed_at)} ${esc(String(a.viewed_at).slice(11, 16))}</td><td>${esc(a.viewer_email)}</td>
    <td>${a.scope === 'person' ? '<span class="fc-badge fc-badge--warn">Opened a person</span>' : '<span class="fc-badge fc-badge--neutral">Opened overview</span>'}</td>
    <td>${esc(a.person || '—')}</td></tr>`).join('') || '<tr><td colspan="4"><div class="fc-empty"><div class="fc-empty__title">No access recorded yet</div></div></td></tr>';
}

function wireHomemap(){
  $('pinConsent').onchange = updatePinSave;
  $('pinForm').onsubmit = savePin;
  $('pinCancel').onclick = () => $('pinModal').classList.add('hidden');
  $('pinGps').onclick = useMyGps;
  $('btnMap').onclick = openOverview;
  $('btnMapBack').onclick = () => show('viewMain');
  $('lyProv').onchange = () => { if (!ovMap) return; $('lyProv').checked ? ovProvLayer && ovProvLayer.addTo(ovMap) : ovProvLayer && ovMap.removeLayer(ovProvLayer); };
  $('lyDots').onchange = () => { if (!ovMap) return; $('lyDots').checked ? ovDots && ovDots.addTo(ovMap) : ovDots && ovMap.removeLayer(ovDots); };
  $('mapProvinces').onclick = e => { const b = e.target.closest('[data-c]'); if (b) zoomToProvince(b.dataset.c); };
  $('btnMapFit').onclick = () => ovMap && ovMap.fitBounds(TH_BOUNDS);
  $('btnMapLog').onclick = openAccessLog;
  $('logClose').onclick = () => $('logModal').classList.add('hidden');
}
