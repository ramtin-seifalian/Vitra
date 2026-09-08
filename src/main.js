import './style.css';
import { IdlePreview } from './scene/idlePreview.js';
import { ArTryOn } from './scene/arTryOn.js';
import {
  hasCustomModel,
  hasCustomModelFlag,
  saveCustomModel,
} from './generator/customModelStore.js';
import { invalidateCustomModel } from './glasses/loadGlassesModel.js';

const idleCanvas = document.getElementById('idle-canvas');
const arLayer = document.getElementById('ar-layer');
const arVideo = document.getElementById('ar-video');
const arCanvas = document.getElementById('ar-canvas');
const statusEl = document.getElementById('status');
const tryOnBtn = document.getElementById('try-on-btn');
const exitBtn = document.getElementById('exit-ar-btn');
const stylePicker = document.getElementById('style-picker');
const fitPanel = document.getElementById('fit-panel');
const fitY = document.getElementById('fit-y');
const fitZ = document.getElementById('fit-z');
const fitScale = document.getElementById('fit-scale');

const customStyleBtn = document.getElementById('custom-style-btn');
const glbInput = document.getElementById('glb-input');
const glbStatus = document.getElementById('glb-status');

let currentStyle = 'square-oversized';
let arSession = null;
let arActive = false;

const idlePreview = new IdlePreview(idleCanvas);
idlePreview.setStyle(currentStyle);

// A frame generated on generator.html is offered as its own style, and is
// what the user most likely came back to try on — so select it right away.
// The synchronous flag is checked first so the chip is present on the very
// first paint; the IndexedDB read then confirms (or retracts) it.
function offerCustomStyle(exists) {
  customStyleBtn.hidden = !exists;
  if (
    exists &&
    !customStyleBtn.classList.contains('active') &&
    new URLSearchParams(location.search).get('style') === 'custom'
  ) {
    customStyleBtn.click();
  }
}

offerCustomStyle(hasCustomModelFlag());
hasCustomModel().then(offerCustomStyle);

// ---- Wearing a model the user supplies themselves --------------------------

const MAX_GLB_BYTES = 60 * 1024 * 1024;

function showGlbStatus(message, isError = false) {
  glbStatus.hidden = !message;
  glbStatus.textContent = message ?? '';
  glbStatus.classList.toggle('error', isError);
}

glbInput.addEventListener('change', async () => {
  const file = glbInput.files?.[0];
  glbInput.value = ''; // so re-picking the same file fires again
  if (!file) return;

  if (!/\.glb$/i.test(file.name)) {
    showGlbStatus('فقط فایل .glb پشتیبانی می‌شود. (فایل .gltf به فایل‌های جانبی نیاز دارد.)', true);
    return;
  }
  if (file.size > MAX_GLB_BYTES) {
    showGlbStatus('فایل خیلی بزرگ است (بیشتر از ۶۰ مگابایت).', true);
    return;
  }

  showGlbStatus('در حال خواندن مدل…');
  try {
    const glb = await file.arrayBuffer();

    // Parse and fit before storing, so a file that cannot be worn is rejected
    // now with a clear reason rather than becoming a broken style chip.
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { fitUploadedFrame } = await import('./glasses/fitUploadedFrame.js');
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const { info } = fitUploadedFrame(gltf.scene, 140);

    await saveCustomModel(glb, { source: 'upload', name: file.name, frameWidthMM: 140 });
    invalidateCustomModel();
    offerCustomStyle(true);
    customStyleBtn.click();

    const mm = (cm) => Math.round(cm * 10);
    showGlbStatus(
      `مدل «${file.name}» بارگذاری شد — تراز خودکار شد به ` +
        `${mm(info.sizeCM.width)}×${mm(info.sizeCM.height)}×${mm(info.sizeCM.depth)} میلی‌متر. ` +
        'اگر جای عینک روی صورت دقیق نبود، از «تنظیم دقیق» استفاده کنید.'
    );
  } catch (err) {
    console.error(err);
    showGlbStatus('این فایل GLB خوانده نشد. مطمئن شوید یک مدل سه‌بعدی سالم است.', true);
  }
});

function showStatus(message, isError = false) {
  if (!message) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

stylePicker.addEventListener('click', (e) => {
  const btn = e.target.closest('.style-btn');
  if (!btn) return;
  currentStyle = btn.dataset.style;
  [...stylePicker.children].forEach((b) => b.classList.toggle('active', b === btn));
  idlePreview.setStyle(currentStyle);
  arSession?.setStyle(currentStyle);
});

function readFitOffset() {
  return { y: Number(fitY.value), z: Number(fitZ.value), scale: Number(fitScale.value) };
}
[fitY, fitZ, fitScale].forEach((input) =>
  input.addEventListener('input', () => arSession?.setFitOffset(readFitOffset()))
);

async function enterAr() {
  tryOnBtn.disabled = true;
  arLayer.hidden = false;
  idlePreview.pause();

  arSession = new ArTryOn(arVideo, arCanvas);
  arSession.onStatus = showStatus;

  try {
    await arSession.start(currentStyle);
    arSession.setFitOffset(readFitOffset());
    arActive = true;
    tryOnBtn.hidden = true;
    exitBtn.hidden = false;
    fitPanel.hidden = false;
  } catch (err) {
    console.error(err);
    const message =
      err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
        ? 'دسترسی به دوربین رد شد. لطفاً مجوز دوربین را فعال کنید.'
        : 'خطا در راه‌اندازی دوربین یا مدل ردیابی چهره. لطفاً دوباره تلاش کنید.';
    showStatus(message, true);
    exitAr();
  } finally {
    tryOnBtn.disabled = false;
  }
}

function exitAr() {
  arSession?.stop();
  arSession = null;
  arActive = false;
  arLayer.hidden = true;
  tryOnBtn.hidden = false;
  exitBtn.hidden = true;
  fitPanel.hidden = true;
  fitPanel.open = false;
  showStatus(null);
  idlePreview.resume();
}

tryOnBtn.addEventListener('click', () => {
  if (!arActive) enterAr();
});
exitBtn.addEventListener('click', exitAr);
