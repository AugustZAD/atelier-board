const MAX_FILES = 30;
const MAX_EDGE = 1400;
const state = { items: [], processing: 0 };

const $ = (selector) => document.querySelector(selector);
const fileInput = $('#fileInput');
const dropZone = $('#dropZone');
const gallery = $('#gallery');
const previewSection = $('#previewSection');
const actionBar = $('#actionBar');
const exportButton = $('#exportButton');

fileInput.addEventListener('change', (event) => addFiles([...event.target.files]));
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => addFiles([...event.dataTransfer.files]));
$('#clearButton').addEventListener('click', clearAll);
exportButton.addEventListener('click', exportCollection);

async function addFiles(files) {
  const images = files.filter((file) => file.type.startsWith('image/'));
  const remaining = MAX_FILES - state.items.length;
  if (!images.length) return toast('请选择 JPG、PNG 或 WebP 图片');
  if (images.length > remaining) toast(`本次仅加入前 ${remaining} 张，图集最多 30 张`);

  const accepted = images.slice(0, remaining);
  if (!accepted.length) return toast('已经达到 30 张上限');
  previewSection.hidden = false;
  actionBar.hidden = false;

  accepted.forEach((file) => {
    const item = { id: crypto.randomUUID(), file, status: 'processing', dataUrl: '' };
    state.items.push(item);
    createCard(item);
  });
  updateUI();
  fileInput.value = '';

  // Small batches keep mobile browsers responsive and avoid memory spikes.
  for (let index = 0; index < accepted.length; index += 2) {
    const batch = accepted.slice(index, index + 2);
    await Promise.all(batch.map((file) => {
      const item = state.items.find((entry) => entry.file === file);
      return processItem(item);
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

function createCard(item) {
  const fragment = $('#cardTemplate').content.cloneNode(true);
  const card = fragment.querySelector('.garment-card');
  card.dataset.id = item.id;
  card.querySelector('.remove-button').addEventListener('click', () => removeItem(item.id));
  gallery.appendChild(fragment);
}

async function processItem(item) {
  state.processing += 1;
  updateUI();
  try {
    const bitmap = await createImageBitmap(item.file);
    item.dataUrl = isolateGarment(bitmap);
    bitmap.close();
    item.status = 'ready';
    const card = gallery.querySelector(`[data-id="${item.id}"]`);
    card.querySelector('img').src = item.dataUrl;
    card.querySelector('img').alt = `服装单品 ${state.items.indexOf(item) + 1}`;
    card.classList.add('is-ready');
    card.querySelector('.card-state').textContent = '已抠图';
  } catch (error) {
    console.error(error);
    item.status = 'error';
    const card = gallery.querySelector(`[data-id="${item.id}"]`);
    card.classList.add('is-error');
    card.querySelector('.card-state').textContent = '处理失败';
  } finally {
    state.processing -= 1;
    updateUI();
  }
}

function isolateGarment(bitmap) {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(bitmap, 0, 0, width, height);

  const analysisScale = Math.min(1, 480 / Math.max(width, height));
  const aw = Math.max(1, Math.round(width * analysisScale));
  const ah = Math.max(1, Math.round(height * analysisScale));
  const analysis = document.createElement('canvas');
  analysis.width = aw;
  analysis.height = ah;
  const context = analysis.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, aw, ah);
  const imageData = context.getImageData(0, 0, aw, ah);
  const background = inferBackground(imageData, aw, ah);
  const foreground = new Uint8Array(aw * ah);

  for (let y = 0; y < ah; y += 1) {
    for (let x = 0; x < aw; x += 1) {
      const offset = (y * aw + x) * 4;
      const distance = colorDistance(imageData.data, offset, background);
      if (distance > 30) foreground[y * aw + x] = 1;
    }
  }

  const component = largestCentralComponent(foreground, aw, ah);
  if (!component || component.area < aw * ah * 0.012) {
    throw new Error('No central garment found');
  }

  const padding = Math.max(3, Math.round(Math.max(aw, ah) * 0.018));
  const bounds = {
    x: Math.max(0, component.minX - padding),
    y: Math.max(0, component.minY - padding),
    right: Math.min(aw - 1, component.maxX + padding),
    bottom: Math.min(ah - 1, component.maxY + padding)
  };
  const bw = bounds.right - bounds.x + 1;
  const bh = bounds.bottom - bounds.y + 1;
  const mask = buildFilledMask(component.pixels, aw, ah, bounds);

  const sx = Math.max(0, Math.floor(bounds.x / analysisScale));
  const sy = Math.max(0, Math.floor(bounds.y / analysisScale));
  const sw = Math.min(width - sx, Math.ceil(bw / analysisScale));
  const sh = Math.min(height - sy, Math.ceil(bh / analysisScale));
  const output = document.createElement('canvas');
  output.width = sw;
  output.height = sh;
  const outputContext = output.getContext('2d');
  outputContext.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);

  const smallMask = document.createElement('canvas');
  smallMask.width = bw;
  smallMask.height = bh;
  const maskContext = smallMask.getContext('2d');
  const maskData = maskContext.createImageData(bw, bh);
  for (let index = 0; index < mask.length; index += 1) {
    const alpha = mask[index] ? 255 : 0;
    maskData.data[index * 4] = 255;
    maskData.data[index * 4 + 1] = 255;
    maskData.data[index * 4 + 2] = 255;
    maskData.data[index * 4 + 3] = alpha;
  }
  maskContext.putImageData(maskData, 0, 0);
  outputContext.globalCompositeOperation = 'destination-in';
  outputContext.imageSmoothingEnabled = true;
  outputContext.drawImage(smallMask, 0, 0, bw, bh, 0, 0, sw, sh);
  outputContext.globalCompositeOperation = 'source-over';
  return output.toDataURL('image/webp', 0.9);
}

function inferBackground(imageData, width, height) {
  const samples = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 45));
  const sideLimit = Math.floor(height * 0.62);
  for (let x = 0; x < width; x += step) {
    samples.push(pixelAt(imageData.data, width, x, 0));
  }
  for (let y = 0; y < sideLimit; y += step) {
    samples.push(pixelAt(imageData.data, width, 0, y));
    samples.push(pixelAt(imageData.data, width, width - 1, y));
  }
  return [0, 1, 2].map((channel) => median(samples.map((sample) => sample[channel])));
}

function largestCentralComponent(binary, width, height) {
  const visited = new Uint8Array(binary.length);
  let best = null;
  const queue = new Int32Array(binary.length);

  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const pixels = [];
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let sumX = 0, sumY = 0;

    while (head < tail) {
      const index = queue[head++];
      pixels.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      sumX += x; sumY += y;
      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= binary.length || visited[next] || !binary[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    const area = pixels.length;
    const cx = sumX / area;
    const cy = sumY / area;
    const centrality = 1 - Math.min(1, Math.abs(cx - width / 2) / (width / 2));
    const bottomPenalty = cy > height * .78 ? .16 : 1;
    const score = area * (.75 + centrality * .5) * bottomPenalty;
    if (!best || score > best.score) best = { pixels, area, minX, minY, maxX, maxY, score };
  }
  return best;
}

function buildFilledMask(componentPixels, width, height, bounds) {
  const bw = bounds.right - bounds.x + 1;
  const bh = bounds.bottom - bounds.y + 1;
  const solid = new Uint8Array(bw * bh);
  for (const index of componentPixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x >= bounds.x && x <= bounds.right && y >= bounds.y && y <= bounds.bottom) {
      solid[(y - bounds.y) * bw + (x - bounds.x)] = 1;
    }
  }

  // Close tiny gaps, then mark only background connected to the crop edge.
  const expanded = solid.slice();
  for (let y = 1; y < bh - 1; y += 1) {
    for (let x = 1; x < bw - 1; x += 1) {
      const index = y * bw + x;
      if (solid[index]) continue;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) neighbors += solid[(y + oy) * bw + x + ox];
      if (neighbors >= 5) expanded[index] = 1;
    }
  }
  const outside = new Uint8Array(bw * bh);
  const queue = new Int32Array(bw * bh);
  let head = 0, tail = 0;
  const seed = (index) => { if (!expanded[index] && !outside[index]) { outside[index] = 1; queue[tail++] = index; } };
  for (let x = 0; x < bw; x += 1) { seed(x); seed((bh - 1) * bw + x); }
  for (let y = 0; y < bh; y += 1) { seed(y * bw); seed(y * bw + bw - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % bw;
    for (const next of [index - 1, index + 1, index - bw, index + bw]) {
      if (next < 0 || next >= outside.length || outside[next] || expanded[next]) continue;
      if (Math.abs((next % bw) - x) > 1) continue;
      outside[next] = 1;
      queue[tail++] = next;
    }
  }
  return Uint8Array.from(outside, (value) => value ? 0 : 1);
}

function removeItem(id) {
  state.items = state.items.filter((item) => item.id !== id);
  gallery.querySelector(`[data-id="${id}"]`)?.remove();
  if (!state.items.length) {
    previewSection.hidden = true;
    actionBar.hidden = true;
  }
  updateUI();
}

function clearAll() {
  state.items = [];
  gallery.replaceChildren();
  previewSection.hidden = true;
  actionBar.hidden = true;
  updateUI();
}

function updateUI() {
  const ready = state.items.filter((item) => item.status === 'ready').length;
  $('#itemCount').textContent = `${state.items.length} / ${MAX_FILES}`;
  $('#readyCount').textContent = `${ready} 件单品`;
  const progress = $('#progress');
  progress.hidden = state.processing === 0;
  if (state.items.length) {
    const settled = state.items.filter((item) => item.status !== 'processing').length;
    $('#progressBar').style.width = `${Math.round(settled / state.items.length * 100)}%`;
    $('#progressText').textContent = `正在处理 ${state.processing} 张`;
  }
  exportButton.disabled = state.processing > 0 || ready === 0;
  [...gallery.children].forEach((card, index) => { card.querySelector('.card-index').textContent = `LOOK ${String(index + 1).padStart(2, '0')}`; });
}

async function exportCollection() {
  const ready = state.items.filter((item) => item.status === 'ready');
  if (!ready.length) return;
  const title = $('#collectionTitle').value.trim() || '精选系列';
  const html = buildShareHtml(title, ready);
  const fileName = `${safeFileName(title)}.html`;
  const file = new File([html], fileName, { type: 'text/html' });

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, text: `${title} · ${ready.length} 件单品`, files: [file] });
      toast('已打开系统分享面板');
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('HTML 已下载，可以作为文件直接分享');
}

function buildShareHtml(title, items) {
  const cards = items.map((item, index) => `<figure><img src="${item.dataUrl}" alt="服装单品 ${index + 1}" loading="lazy"><figcaption>LOOK ${String(index + 1).padStart(2, '0')}</figcaption></figure>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f3efe8"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}body{margin:0;color:#181512;background:#f3efe8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}header{padding:48px 18px 28px;border-bottom:1px solid rgba(24,21,18,.16)}small{display:block;margin-bottom:12px;color:#7a5b3a;font-size:9px;letter-spacing:.2em}h1{max-width:650px;margin:0;font-family:Georgia,serif;font-size:clamp(42px,12vw,72px);font-weight:400;line-height:.94;letter-spacing:-.04em}.summary{margin:18px 0 0;color:#6b645d;font-size:11px}.gallery{max-width:760px;margin:auto;padding:12px;columns:2;column-gap:8px}figure{display:inline-block;width:100%;margin:0 0 18px;break-inside:avoid}img{display:block;width:100%;height:auto;background:#e8e1d7}figcaption{padding-top:7px;color:#716960;font-family:Georgia,serif;font-size:9px;letter-spacing:.12em}footer{padding:36px 18px 48px;border-top:1px solid rgba(24,21,18,.16);color:#726a62;font-family:Georgia,serif;font-size:11px;text-align:center;letter-spacing:.14em}@media(min-width:700px){header{padding:72px max(24px,calc((100vw - 720px)/2)) 42px}.gallery{column-gap:14px;padding-top:18px}}
</style></head><body><header><small>PRIVATE COLLECTION</small><h1>${escapeHtml(title)}</h1><p class="summary">${items.length} 件单品 · ${new Date().toLocaleDateString('zh-CN')}</p></header><main class="gallery">${cards}</main><footer>CURATED COLLECTION</footer></body></html>`;
}

function pixelAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2]];
}
function colorDistance(data, offset, color) {
  const dr = data[offset] - color[0];
  const dg = data[offset + 1] - color[1];
  const db = data[offset + 2] - color[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
function median(values) { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; }
function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function safeFileName(value) { return value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || 'collection'; }
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('is-visible'), 2600);
}
