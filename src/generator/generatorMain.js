import '../style.css';
import './generator.css';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadPhoto } from './segmentation.js';
import { analyzeFrontPhoto, analyzeTemplePhoto } from './photoAnalysis.js';
import { buildGlassesModel, disposeModel, suggestLensOpacity } from './photoGlassesBuilder.js';
import { GeneratorViewer } from './generatorViewer.js';
import { saveCustomModel } from './customModelStore.js';

const el = (id) => document.getElementById(id);
const frontInput = el('front-input');
const sideInput = el('side-input');
const frontPreview = el('front-preview');
const sidePreview = el('side-preview');
const buildBtn = el('build-btn');
const exportBtn = el('export-btn');
const tryOnBtn = el('tryon-btn');
const statusBox = el('gen-status');
const reportBox = el('gen-report');
const rimRow = el('rim-row');

const params = {
  frameWidth: el('frame-width'),
  templeLength: el('temple-length'),
  depth: el('depth'),
  lensOpacity: el('lens-opacity'),
  tolerance: el('tolerance'),
  rim: el('rim'),
};

const viewer = new GeneratorViewer(el('viewer-canvas'));
el('auto-rotate').addEventListener('change', (e) => viewer.setAutoRotate(e.target.checked));

const state = {
  frontPhoto: null,
  sidePhoto: null,
  frontAnalysis: null,
  sideAnalysis: null,
  model: null,
  lensOpacityAuto: true,
  depthAuto: true,
};

function showStatus(message, isError = false) {
  statusBox.hidden = !message;
  statusBox.textContent = message ?? '';
  statusBox.classList.toggle('error', isError);
}

const ERROR_FA = {
  'image-load-failed': 'خواندن فایل عکس ممکن نبود. لطفاً JPG یا PNG استفاده کنید.',
  'no-object': 'عینکی در عکس تشخیص داده نشد. پس‌زمینه باید سفید/یکدست باشد.',
  'object-too-small': 'عینک در عکس خیلی کوچک است — نزدیک‌تر عکس بگیرید تا عینک کادر را پر کند.',
  'contour-failed': 'استخراج خطوط فریم ناموفق بود — نور یکنواخت‌تر و پس‌زمینهٔ ساده‌تر امتحان کنید.',
  // Raised by the reconstruction when the measured shape is not a pair of
  // glasses. Refusing here is deliberate: a plausible-looking wrong model is
  // worse than a clear "this photo will not work".
  'need-two-lenses':
    'دو عدسی جدا تشخیص داده نشد. عکس باید کاملاً رو‌به‌رو باشد و هر دو عدسی دیده شوند.',
  'not-glasses-shaped':
    'شکل تشخیص‌داده‌شده نسبت عرض به ارتفاع یک عینک را ندارد. احتمالاً پس‌زمینه یا سایه هم جزو فریم شمرده شده.',
  'implausible-lens-size':
    'اندازهٔ عدسی با عرض فریمی که وارد کرده‌اید نمی‌خواند. عدد «عرض کل فریم» را بررسی کنید.',
  'implausible-bridge': 'فاصلهٔ بین دو عدسی غیرواقعی است — عکس رو‌به‌روتر و بدون زاویه بگیرید.',
};

function faError(err) {
  return ERROR_FA[err?.message] ?? 'خطای غیرمنتظره در پردازش عکس. عکس دیگری امتحان کنید.';
}

/** Draw the photo plus the detected contours, so the user sees what was understood. */
function drawDetectionPreview(canvas, photo, contours) {
  const maxW = 380;
  const scale = Math.min(1, maxW / photo.width);
  canvas.width = Math.round(photo.width * scale);
  canvas.height = Math.round(photo.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photo.canvas, 0, 0, canvas.width, canvas.height);
  const stroke = (pts, color) => {
    if (!pts?.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
    for (const [x, y] of pts) ctx.lineTo(x * scale, y * scale);
    ctx.closePath();
    ctx.stroke();
  };
  for (const { points, color } of contours) stroke(points, color);
  canvas.hidden = false;
}

const LENS_SOURCE_FA = {
  holes: 'عدسی شفاف — حفرهٔ واقعی فریم تشخیص داده شد',
  color: 'از تفاوت رنگ عدسی با فریم',
  inset: 'هندسی (فاصله از دور فریم) — با اسلایدر «ضخامت دور فریم» تنظیم کنید',
};

function swatch([r, g, b]) {
  return '<span class="swatch" style="background: rgb(' + [r, g, b].map(Math.round).join(',') + ')"></span>';
}

function renderReport() {
  const a = state.frontAnalysis;
  if (!a) {
    reportBox.hidden = true;
    return;
  }
  const mm = (cm) => Math.round(cm * 10);
  const spec = state.model?.spec;

  const lines = [
    '✔ فریم تشخیص داده شد — رنگ: ' + swatch(a.rimColor),
    '✔ عدسی: ' + (a.apertures.length || 'هیچ') + ' عدد — روش: ' +
      (LENS_SOURCE_FA[a.lensSource] ?? 'تشخیص نشد (فریم بدون عدسی ساخته می‌شود)') +
      (a.lensTint ? ' — رنگ عدسی: ' + swatch(a.lensTint) : ''),
    state.sideAnalysis
      ? '✔ دسته از روی پروفیل عکس بغل اندازه‌گیری شد' +
        (state.sideAnalysis.flipped ? ' (عکس خودکار آینه شد)' : '')
      : 'ℹ عکس بغل داده نشده — دسته با نسبت‌های استاندارد ساخته شد',
  ];

  // The measured spec is the actual output of the reconstruction: these are
  // the numbers a frame is specified by, printed inside every real temple.
  if (spec) {
    lines.push(
      '<b>مشخصات اندازه‌گیری‌شده</b>',
      'فرم عدسی: <b>' + spec.shape + '</b>',
      'کد سایز: <b>' + mm(spec.lensWidth) + '□' + mm(spec.bridgeGap) + '-' +
        params.templeLength.value + '</b>',
      'ارتفاع عدسی: ' + mm(spec.lensHeight) + 'mm · ضخامت دور فریم: ' + mm(spec.rim) +
        'mm · ضخامت ورق: ' + mm(spec.depth) + 'mm',
      'جنس تشخیص‌داده‌شده: ' + (spec.rim < 0.28 ? 'فلزی (وایر)' : 'کائوچو/استات')
    );
  }
  reportBox.innerHTML = lines.join('<br>');
  reportBox.hidden = false;
}

function analyzeFront() {
  if (!state.frontPhoto) return;
  state.frontAnalysis = analyzeFrontPhoto(state.frontPhoto.imageData, {
    tolerance: Number(params.tolerance.value),
    rimFraction: Number(params.rim.value),
  });
  const a = state.frontAnalysis;
  rimRow.hidden = a.lensSource !== 'inset';
  if (state.lensOpacityAuto) {
    params.lensOpacity.value = suggestLensOpacity(a).toFixed(2);
    el('lens-opacity-val').textContent = 'خودکار (' + params.lensOpacity.value + ')';
  }
  drawDetectionPreview(frontPreview, state.frontPhoto, [
    { points: a.outerContour, color: '#4fd1c5' },
    ...a.apertures.map((points) => ({ points, color: '#7c5cff' })),
  ]);
  el('front-card').classList.add('has-photo');
  el('front-hint').textContent = 'برای تعویض عکس کلیک کنید';
}

function analyzeSide() {
  if (!state.sidePhoto) {
    state.sideAnalysis = null;
    return;
  }
  state.sideAnalysis = analyzeTemplePhoto(state.sidePhoto, {
    tolerance: Number(params.tolerance.value),
  });
  drawDetectionPreview(sidePreview, state.sideAnalysis.photo, [
    { points: state.sideAnalysis.contour, color: '#ffb347' },
  ]);
  el('side-card').classList.add('has-photo');
  el('side-hint').textContent = 'برای تعویض عکس کلیک کنید';
}

function rebuildModel() {
  if (!state.frontAnalysis) return;
  if (state.model) {
    viewer.setModel(null);
    disposeModel(state.model.group);
  }
  state.model = buildGlassesModel({
    front: state.frontAnalysis,
    side: state.sideAnalysis,
    params: {
      frameWidthMM: Number(params.frameWidth.value) || 140,
      templeLengthMM: Number(params.templeLength.value) || 145,
      depthCM: state.depthAuto ? null : Number(params.depth.value) / 10,
      lensOpacity: state.lensOpacityAuto ? null : Number(params.lensOpacity.value),
    },
  });
  if (state.depthAuto) {
    params.depth.value = (state.model.spec.depth * 10).toFixed(0);
    el('depth-val').textContent = 'خودکار (' + params.depth.value + 'mm)';
  }
  viewer.setModel(state.model.group);
  exportBtn.disabled = false;
  tryOnBtn.disabled = false;
  buildBtn.disabled = false;
  renderReport();
}

/** Run (parts of) the pipeline off the click handler so the UI can paint first. */
function run({ front = false, side = false } = {}) {
  showStatus('در حال پردازش…');
  buildBtn.disabled = !state.frontPhoto;
  setTimeout(() => {
    try {
      if (front) analyzeFront();
      if (side) analyzeSide();
      rebuildModel();
      showStatus(null);
    } catch (err) {
      console.error(err);
      showStatus(faError(err), true);
    }
  }, 30);
}

async function onPhotoPicked(input, key) {
  const file = input.files?.[0];
  if (!file) return;
  showStatus('در حال خواندن عکس…');
  try {
    state[key] = await loadPhoto(file);
  } catch (err) {
    showStatus(faError(err), true);
    return;
  }
  run({ front: key === 'frontPhoto', side: key === 'sidePhoto' });
}

frontInput.addEventListener('change', () => onPhotoPicked(frontInput, 'frontPhoto'));
sideInput.addEventListener('change', () => onPhotoPicked(sideInput, 'sidePhoto'));

buildBtn.addEventListener('click', () => run({ front: true, side: true }));

// ---- Parameter wiring ------------------------------------------------------
let debounceTimer = null;
function debounced(fn) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, 220);
}

params.depth.addEventListener('input', () => {
  state.depthAuto = false;
  el('depth-val').textContent = params.depth.value + 'mm';
  if (state.frontAnalysis) debounced(() => run());
});
params.lensOpacity.addEventListener('input', () => {
  state.lensOpacityAuto = false;
  el('lens-opacity-val').textContent = params.lensOpacity.value;
  if (state.model) state.model.lensMaterial.opacity = Number(params.lensOpacity.value);
});
params.tolerance.addEventListener('input', () => {
  el('tolerance-val').textContent = params.tolerance.value;
  if (state.frontPhoto) debounced(() => run({ front: true, side: !!state.sidePhoto }));
});
params.rim.addEventListener('input', () => {
  el('rim-val').textContent = (Number(params.rim.value) * 100).toFixed(1) + '٪';
  if (state.frontPhoto) debounced(() => run({ front: true }));
});
for (const input of [params.frameWidth, params.templeLength]) {
  input.addEventListener('change', () => state.frontAnalysis && run());
}

// ---- GLB export & hand-off to the try-on page ------------------------------
/** Serialise the current model to a binary glTF ArrayBuffer. */
function toGLB() {
  return new Promise((resolve, reject) => {
    if (!state.model) {
      reject(new Error('no-model'));
      return;
    }
    new GLTFExporter().parse(state.model.group, resolve, reject, { binary: true });
  });
}

exportBtn.addEventListener('click', async () => {
  try {
    const blob = new Blob([await toGLB()], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vitra-glasses.glb';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    console.error(err);
    showStatus('خروجی GLB ناموفق بود.', true);
  }
});

tryOnBtn.addEventListener('click', async () => {
  tryOnBtn.disabled = true;
  showStatus('در حال ذخیرهٔ مدل…');
  try {
    await saveCustomModel(await toGLB(), {
      frameWidthMM: Number(params.frameWidth.value),
      templeLengthMM: Number(params.templeLength.value),
      lensOpacity: Number(params.lensOpacity.value),
    });
    location.href = 'index.html?style=custom';
  } catch (err) {
    console.error(err);
    showStatus('ذخیرهٔ مدل ناموفق بود. مرورگر ممکن است حالت ناشناس باشد.', true);
    tryOnBtn.disabled = false;
  }
});

showStatus('برای شروع، عکس روبه‌روی عینک را انتخاب کنید.');
