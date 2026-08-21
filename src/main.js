import './style.css';
import { IdlePreview } from './scene/idlePreview.js';
import { ArTryOn } from './scene/arTryOn.js';
import { hasCustomModel } from './generator/customModelStore.js';

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

let currentStyle = 'square-oversized';
let arSession = null;
let arActive = false;

const idlePreview = new IdlePreview(idleCanvas);
idlePreview.setStyle(currentStyle);

// A frame generated on generator.html is offered as its own style, and is
// what the user most likely came back to try on — so select it right away.
hasCustomModel().then((exists) => {
  if (!exists) return;
  customStyleBtn.hidden = false;
  if (new URLSearchParams(location.search).get('style') === 'custom') {
    customStyleBtn.click();
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
