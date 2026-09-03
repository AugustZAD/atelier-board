const MAX_FILES = 50;
const MAX_EDGE = matchMedia('(pointer: coarse)').matches ? 1280 : 1440;
const SHARE_API = 'https://atelier-board-share.s98081096.workers.dev';
const CUTOUT_BACKGROUND = '#f5f1ea';

const state = { items: [], processing: false, phase: '', batchTotal: 0, uploaded: 0, completed: 0, cloudStartedAt: 0, mode: 'cutout' };
const $ = (selector) => document.querySelector(selector);
const fileInput = $('#fileInput');
const dropZone = $('#dropZone');
const gallery = $('#gallery');
const previewSection = $('#previewSection');
const actionBar = $('#actionBar');
const exportButton = $('#exportButton');
const shareDialog = $('#shareDialog');

fileInput.addEventListener('change', (event) => addFiles([...event.target.files]));
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault(); dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault(); dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => addFiles([...event.dataTransfer.files]));
$('#clearButton').addEventListener('click', clearAll);
$('#closeShare').addEventListener('click', () => shareDialog.close());
$('#copyLink').addEventListener('click', copyShareLink);
$('#nativeShare').addEventListener('click', nativeShare);
exportButton.addEventListener('click', createShareLink);

async function addFiles(files) {
  if (state.processing) return toast('请等待当前一批图片处理完成');
  const images = files.filter((file) => file.type.startsWith('image/'));
  const remaining = MAX_FILES - state.items.length;
  if (!images.length) return toast('请选择图片文件');
  if (images.length > remaining) toast(`本次仅加入前 ${remaining} 张，图集最多 50 张`);
  const accepted = images.slice(0, remaining);
  if (!accepted.length) return toast('已经达到 50 张上限');

  const batchItems = accepted.map((file) => {
    const item = { id: crypto.randomUUID(), file, status: 'queued', jobId: '', index: -1, token: '', url: '', background: CUTOUT_BACKGROUND };
    state.items.push(item); createCard(item); return item;
  });
  previewSection.hidden = false;
  actionBar.hidden = false;
  fileInput.value = '';
  state.processing = true;
  state.phase = 'upload';
  state.batchTotal = accepted.length;
  state.uploaded = 0;
  state.completed = 0;
  updateUI();

  try {
    const job = await api('/api/jobs', { method: 'POST', json: { count: accepted.length, mode: state.mode } });
    batchItems.forEach((item, index) => { item.jobId = job.jobId; item.index = index; item.token = job.token; });
    await runPool(batchItems, 3, async (item) => {
      item.status = 'uploading'; updateCard(item, '正在上传');
      const prepared = await prepareProductImage(item.file);
      item.background = prepared.background;
      updateGallerySurface();
      item.file = null;
      await api(`/api/jobs/${job.jobId}/images/${item.index}`, {
        method: 'PUT', token: job.token, body: prepared.blob, contentType: prepared.blob.type
      });
      item.status = 'uploaded';
      state.uploaded += 1;
      updateCard(item, '等待云端抠图');
      updateProgress();
    });

    state.phase = 'cloud';
    state.cloudStartedAt = performance.now();
    await api(`/api/jobs/${job.jobId}/start`, { method: 'POST', token: job.token, json: {} });
    await pollJob(job, batchItems);
  } catch (error) {
    console.error(error);
    batchItems.filter((item) => item.status !== 'ready').forEach((item) => {
      item.status = 'error'; updateCard(item, '处理失败');
    });
    toast(error.message || '处理失败，请稍后重试');
  } finally {
    state.processing = false;
    state.phase = '';
    updateUI();
  }
}

async function pollJob(job, items) {
  let rendered = 0;
  while (true) {
    const result = await api(`/api/jobs/${job.jobId}`, { token: job.token });
    state.completed = result.completed;
    while (rendered < result.completed) {
      const item = items[rendered];
      item.url = `${SHARE_API}/media/${job.jobId}/${item.index}`;
      item.status = 'ready';
      const card = gallery.querySelector(`[data-id="${item.id}"]`);
      if (card) {
        const image = card.querySelector('img');
        image.src = item.url; image.alt = `服装单品 ${state.items.indexOf(item) + 1}`;
        card.classList.add('is-ready');
      }
      updateCard(item, '云端已抠图');
      rendered += 1;
    }
    updateUI();
    if (result.status === 'complete') return;
    if (result.status === 'error') throw new Error(result.error || '图片处理失败');
    await delay(document.hidden ? 5000 : 1500);
  }
}

async function prepareProductImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const sourceHeight = detectScreenshotCrop(bitmap);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, sourceHeight));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, width, height);
    return {
      background: CUTOUT_BACKGROUND,
      blob: await canvasToBlob(canvas, 'image/jpeg', .92)
    };
  } finally { bitmap.close(); }
}

function detectScreenshotCrop(bitmap) {
  if (bitmap.height <= bitmap.width * 1.04) return bitmap.height;
  const sample = document.createElement('canvas');
  sample.width = 96; sample.height = 96;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, 96, 96);
  const pixels = context.getImageData(0, 72, 96, 24).data;
  let dark = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
    if (luminance < 210) dark += 1;
  }
  const ratio = dark / (96 * 24);
  return ratio > .004 && ratio < .2 ? Math.round(bitmap.height * .62) : bitmap.height;
}

async function runPool(items, concurrency, handler) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor]; cursor += 1; await handler(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function createCard(item) {
  const fragment = $('#cardTemplate').content.cloneNode(true);
  const card = fragment.querySelector('.garment-card');
  card.dataset.id = item.id;
  card.style.setProperty('--item-background', item.background);
  card.querySelector('.remove-button').addEventListener('click', () => removeItem(item.id));
  gallery.appendChild(fragment);
}

function updateCard(item, label) {
  const card = gallery.querySelector(`[data-id="${item.id}"]`);
  if (!card) return;
  card.querySelector('.card-state').textContent = label;
  card.style.setProperty('--item-background', item.background);
  card.classList.toggle('is-error', item.status === 'error');
}

function removeItem(id) {
  if (state.processing) return toast('处理完成后即可移除图片');
  state.items = state.items.filter((item) => item.id !== id);
  gallery.querySelector(`[data-id="${id}"]`)?.remove();
  if (!state.items.length) { previewSection.hidden = true; actionBar.hidden = true; }
  updateUI();
}

function clearAll() {
  if (state.processing) return toast('处理完成后即可清除');
  state.items = []; gallery.replaceChildren(); previewSection.hidden = true; actionBar.hidden = true; updateUI();
}

function updateUI() {
  const ready = state.items.filter((item) => item.status === 'ready').length;
  $('#itemCount').textContent = `${state.items.length} / ${MAX_FILES}`;
  $('#readyCount').textContent = `${ready} 件单品`;
  $('#progress').hidden = !state.processing;
  fileInput.disabled = state.processing;
  exportButton.disabled = state.processing || ready === 0;
  [...gallery.children].forEach((card, index) => { card.querySelector('.card-index').textContent = `LOOK ${String(index + 1).padStart(2, '0')}`; });
  updateGallerySurface();
  updateProgress();
}

function updateGallerySurface() {
  previewSection.style.setProperty('--gallery-background', CUTOUT_BACKGROUND);
}

function updateProgress() {
  if (!state.processing) return;
  const progressBar = $('#progressBar');
  if (state.phase === 'upload') {
    const percent = Math.round(state.uploaded / Math.max(1, state.batchTotal) * 35);
    progressBar.style.width = `${Math.max(3, percent)}%`;
    $('#progressText').textContent = `安全上传 ${state.uploaded} / ${state.batchTotal}`;
    $('#progressDetail').textContent = '原图将在抠图完成后立即删除';
    $('#etaText').textContent = '';
    return;
  }
  const percent = 35 + Math.round(state.completed / Math.max(1, state.batchTotal) * 65);
  progressBar.style.width = `${percent}%`;
  $('#progressText').textContent = `L4 云端抠图 ${state.completed} / ${state.batchTotal}`;
  $('#progressDetail').textContent = '可以留在此页面查看实时结果';
  if (state.completed > 0 && state.completed < state.batchTotal) {
    const elapsed = performance.now() - state.cloudStartedAt;
    $('#etaText').textContent = `约剩 ${formatDuration(elapsed / state.completed * (state.batchTotal - state.completed))}`;
  } else $('#etaText').textContent = state.completed ? '即将完成' : '正在启动 GPU';
}

async function createShareLink() {
  const ready = state.items.filter((item) => item.status === 'ready');
  if (!ready.length) return;
  const buttonLabel = exportButton.querySelector('span');
  exportButton.disabled = true; buttonLabel.textContent = '正在生成网址…';
  try {
    const result = await api('/api/collections', {
      method: 'POST',
      json: {
        title: $('#collectionTitle').value.trim() || '精选系列',
        mode: state.mode,
        background: CUTOUT_BACKGROUND,
        items: ready.map(({ jobId, index, token }) => ({ jobId, index, token }))
      }
    });
    $('#shareUrl').value = result.url;
    shareDialog.showModal();
  } catch (error) {
    console.error(error); toast(error.message || '生成链接失败，请稍后重试');
  } finally {
    exportButton.disabled = false; buttonLabel.textContent = '生成分享链接';
  }
}

async function api(path, options = {}) {
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';
  if (options.contentType) headers['Content-Type'] = options.contentType;
  const response = await fetch(`${SHARE_API}${path}`, {
    method: options.method || 'GET', headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}

async function copyShareLink() { await navigator.clipboard.writeText($('#shareUrl').value); toast('分享网址已复制'); }
async function nativeShare() {
  const url = $('#shareUrl').value;
  const title = $('#collectionTitle').value.trim() || '精选系列';
  if (navigator.share) {
    try { await navigator.share({ title, text: `${title} · 在线图集`, url }); } catch (error) { if (error.name !== 'AbortError') throw error; }
  } else await copyShareLink();
}

function canvasToBlob(canvas, type, quality) { return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片编码失败')), type, quality)); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function formatDuration(milliseconds) { const seconds = Math.max(1, Math.round(milliseconds / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`; }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('is-visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('is-visible'), 3200); }

document.body.dataset.mode = 'cutout';
