/* =====================================================================
   Profile photo: add / change / remove, with a small crop editor (drag to move, slider to zoom, rotate)
   - employees change their own photo; platform admins can change anyone's (Manage users -> Edit)
   - result is a 512x512 JPEG uploaded to bucket "engineer-photos" at u/<employee_id>/<time>.jpg
   - then RPC set_my_photo / admin_set_photo store the path (and keep engineers.photo_path in sync for Survey)
   Uses globals from index.html: sb, $, esc, toast, SUPABASE_CONFIG, photoUrl
   ===================================================================== */
const PH_BUCKET = 'engineer-photos';
const PH_VIEW = 320, PH_OUT = 512;
let PH = null;    // { id, name, path, self, onSaved }
const phs = { src: null, rot: 0, zoom: 1, ox: 0, oy: 0, dirty: false, drag: null };

function phCtx(){ return $('phCanvas').getContext('2d'); }

function phSetImage(img){            // img: HTMLImageElement (already loaded)
  phs.img = img; phs.rot = 0; phs.zoom = 1; phs.ox = 0; phs.oy = 0;
  phBuildSrc();
}
function phBuildSrc(){               // apply rotation into an offscreen canvas
  const img = phs.img; if (!img) { phs.src = null; return phDraw(); }
  const w = img.naturalWidth, h = img.naturalHeight, swap = phs.rot % 180 !== 0;
  const c = document.createElement('canvas'); c.width = swap ? h : w; c.height = swap ? w : h;
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(phs.rot * Math.PI / 180); x.drawImage(img, -w / 2, -h / 2);
  phs.src = c; phs.ox = 0; phs.oy = 0; phDraw();
}
function phLayout(size){             // cover-fit + zoom; returns draw rect for a canvas of `size`
  const s = phs.src, base = Math.max(size / s.width, size / s.height), k = base * phs.zoom;
  const dw = s.width * k, dh = s.height * k, f = size / PH_VIEW;
  const maxX = Math.max(0, (dw - size) / 2), maxY = Math.max(0, (dh - size) / 2);
  const ox = Math.max(-maxX, Math.min(maxX, phs.ox * f)), oy = Math.max(-maxY, Math.min(maxY, phs.oy * f));
  return { x: (size - dw) / 2 + ox, y: (size - dh) / 2 + oy, w: dw, h: dh, maxX: maxX / f, maxY: maxY / f };
}
function phDraw(){
  const c = $('phCanvas'), x = phCtx();
  x.fillStyle = '#d7dbe3'; x.fillRect(0, 0, PH_VIEW, PH_VIEW);
  $('phEmpty').classList.toggle('hidden', !!phs.src);
  $('phTools').classList.toggle('hidden', !phs.src);
  if (!phs.src) return;
  const r = phLayout(PH_VIEW);
  phs.ox = Math.max(-r.maxX, Math.min(r.maxX, phs.ox)); phs.oy = Math.max(-r.maxY, Math.min(r.maxY, phs.oy));
  const r2 = phLayout(PH_VIEW);
  x.drawImage(phs.src, r2.x, r2.y, r2.w, r2.h);
}

function phLoadFile(file){
  if (!file) return;
  if (!/^image\//.test(file.type)) { $('phErr').textContent = 'Please choose an image file (JPG, PNG or WebP).'; return; }
  if (file.size > 20 * 1024 * 1024) { $('phErr').textContent = 'That file is larger than 20 MB — choose a smaller photo.'; return; }
  $('phErr').textContent = '';
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); phSetImage(img); phs.dirty = true; $('phZoom').value = 1; phUpdateButtons(); };
  img.onerror = () => { URL.revokeObjectURL(url); $('phErr').textContent = 'This image could not be read. Try another file.'; };
  img.src = url;
}

function phUpdateButtons(){
  $('phSave').disabled = !(phs.dirty && phs.src);
  $('phChoose').textContent = PH.path || phs.src ? 'Choose another photo' : 'Choose a photo';
}

function openPhoto(target){
  PH = target;
  phs.src = null; phs.img = null; phs.dirty = false; phs.zoom = 1; phs.ox = phs.oy = 0; phs.rot = 0;
  $('phZoom').value = 1; $('phErr').textContent = '';
  $('phTitle').textContent = target.self ? 'My profile photo' : `Photo — ${target.name}`;
  $('phHint').textContent = 'Use a clear, front-facing photo. Choose a file (or take a picture on your phone), drag to reposition and use the slider to zoom.';
  $('phModal').classList.remove('hidden');
  phDraw(); phUpdateButtons();
  if (target.path) {                 // show the current photo so it can be re-cropped
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { if (PH === target) { phSetImage(img); phs.dirty = false; phUpdateButtons(); } };
    img.onerror = () => { if (PH === target) $('phEmpty').textContent = 'The current photo cannot be edited here — choose a new one.'; };
    img.src = photoUrl(target.path);
  }
}

async function phSave(){
  if (!PH || !phs.src) return;
  $('phSave').disabled = true; $('phErr').textContent = '';
  try {
    const out = document.createElement('canvas'); out.width = out.height = PH_OUT;
    const x = out.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, PH_OUT, PH_OUT);
    const r = phLayout(PH_OUT); x.drawImage(phs.src, r.x, r.y, r.w, r.h);
    const blob = await new Promise((res, rej) => out.toBlob(b => b ? res(b) : rej(new Error('Could not process the image (it may be protected by the browser). Choose the file again.')), 'image/jpeg', 0.88));

    const path = `u/${PH.id}/${Date.now()}.jpg`;
    const up = await sb.storage.from(PH_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (up.error) throw up.error;
    const rpc = PH.self ? await sb.rpc('set_my_photo', { p_path: path }) : await sb.rpc('admin_set_photo', { p_employee_id: PH.id, p_path: path });
    if (rpc.error) { await sb.storage.from(PH_BUCKET).remove([path]); throw rpc.error; }
    phCleanup(PH.path);
    const done = PH.onSaved; $('phModal').classList.add('hidden'); toast('Photo saved');
    if (done) done(path);
  } catch (e) {
    $('phErr').textContent = 'Could not save the photo: ' + (e.message || e);
    phUpdateButtons();
  }
}

function phCleanup(oldPath){          // delete the previous file only if it is one uploaded from this page
  if (oldPath && oldPath.startsWith('u/')) sb.storage.from(PH_BUCKET).remove([oldPath]).catch(() => {});
}

function wirePhoto(){
  const cv = $('phCanvas');
  $('phChoose').onclick = () => $('phFile').click();
  $('phFile').onchange = e => { phLoadFile(e.target.files[0]); e.target.value = ''; };
  $('phZoom').oninput = e => { phs.zoom = +e.target.value; phs.dirty = true; phDraw(); phUpdateButtons(); };
  $('phRotate').onclick = () => { phs.rot = (phs.rot + 90) % 360; phs.dirty = true; phBuildSrc(); phUpdateButtons(); };
  $('phCancel').onclick = () => $('phModal').classList.add('hidden');
  $('phSave').onclick = phSave;
  cv.addEventListener('pointerdown', e => { if (!phs.src) return; cv.setPointerCapture(e.pointerId); phs.drag = { x: e.clientX, y: e.clientY, ox: phs.ox, oy: phs.oy }; });
  cv.addEventListener('pointermove', e => {
    if (!phs.drag) return; const k = PH_VIEW / cv.getBoundingClientRect().width;
    phs.ox = phs.drag.ox + (e.clientX - phs.drag.x) * k; phs.oy = phs.drag.oy + (e.clientY - phs.drag.y) * k;
    phs.dirty = true; phDraw(); phUpdateButtons();
  });
  const end = () => { phs.drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
