const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 50;
const INPUT_TTL = 24 * 60 * 60;
const OUTPUT_TTL = 31 * 24 * 60 * 60;
const COLLECTION_TTL = 30 * 24 * 60 * 60;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const JOB_ID = '[0-9a-f]{32}';
const COLLECTION_PATH = new RegExp(`^/c/(${JOB_ID})$`);
const MEDIA_PATH = new RegExp(`^/media/(${JOB_ID})/(\\d{1,2})$`);
const JOB_PATH = new RegExp(`^/api/jobs/(${JOB_ID})$`);
const JOB_START_PATH = new RegExp(`^/api/jobs/(${JOB_ID})/start$`);
const JOB_IMAGE_PATH = new RegExp(`^/api/jobs/(${JOB_ID})/images/(\\d{1,2})$`);
const INTERNAL_IMAGE_PATH = new RegExp(`^/api/internal/jobs/(${JOB_ID})/images/(\\d{1,2})$`);
const INTERNAL_STATUS_PATH = new RegExp(`^/api/internal/jobs/(${JOB_ID})/status$`);

type ProcessingMode = 'original' | 'cutout';
type JobStatus = 'uploading' | 'queued' | 'processing' | 'complete' | 'error';
type JobRecord = { count: number; completed: number; createdAt: string; error?: string; mode?: ProcessingMode; status: JobStatus; tokenHash: string };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return handleOptions(request, env);
      const internalImage = url.pathname.match(INTERNAL_IMAGE_PATH);
      if (internalImage) {
        if (request.method === 'GET') return await getInput(request, env, internalImage[1], Number(internalImage[2]));
        if (request.method === 'PUT') return await putResult(request, env, internalImage[1], Number(internalImage[2]));
      }
      const internalStatus = url.pathname.match(INTERNAL_STATUS_PATH);
      if (request.method === 'PATCH' && internalStatus) return await updateJobStatus(request, env, internalStatus[1]);
      if (request.method === 'POST' && url.pathname === '/api/jobs') return await createJob(request, env);
      const jobImage = url.pathname.match(JOB_IMAGE_PATH);
      if (request.method === 'PUT' && jobImage) return await uploadImage(request, env, jobImage[1], Number(jobImage[2]));
      const jobStart = url.pathname.match(JOB_START_PATH);
      if (request.method === 'POST' && jobStart) return await startJob(request, env, jobStart[1], url.origin);
      const job = url.pathname.match(JOB_PATH);
      if (request.method === 'GET' && job) return await getJob(request, env, job[1], url.origin);
      if (request.method === 'POST' && url.pathname === '/api/collections') return await createCollection(request, env, url.origin);
      const collection = url.pathname.match(COLLECTION_PATH);
      if (request.method === 'GET' && collection) return await getCollection(collection[1], env, url.origin);
      const media = url.pathname.match(MEDIA_PATH);
      if (request.method === 'GET' && media) return await getMedia(env, media[1], Number(media[2]));
      if (request.method === 'GET' && url.pathname === '/') return Response.json({ service: 'atelier-board-share', status: 'ok' });
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: 'request_failed', path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: '服务暂时不可用，请稍后重试' }, 500, corsFor(request, env));
    }
  }
} satisfies ExportedHandler<Env>;

async function createJob(request: Request, env: Env): Promise<Response> {
  const cors = corsFor(request, env);
  if (!cors) return json({ error: 'Origin not allowed' }, 403);
  const body = await readJson<{ count?: number; mode?: ProcessingMode }>(request);
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) return json({ error: '图片数量必须在 1–50 之间' }, 400, cors);
  const mode: ProcessingMode = body.mode === 'cutout' ? 'cutout' : 'original';
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = await makeRateKey(clientIp);
  const used = Number(await env.COLLECTIONS.get(rateKey) || 0);
  if (used >= 10) return json({ error: '创建任务过于频繁，请稍后再试' }, 429, cors);
  await env.COLLECTIONS.put(rateKey, String(used + 1), { expirationTtl: 3600 });
  const id = randomId();
  const token = `${randomId()}${randomId()}`;
  const record: JobRecord = { count, completed: 0, createdAt: new Date().toISOString(), mode, status: 'uploading', tokenHash: await sha256(token) };
  await putJob(env, id, record);
  return json({ jobId: id, token }, 201, cors);
}

async function uploadImage(request: Request, env: Env, jobId: string, index: number): Promise<Response> {
  const cors = corsFor(request, env);
  if (!cors) return json({ error: 'Origin not allowed' }, 403);
  const job = await authorizedJob(request, env, jobId);
  if (!job) return json({ error: '任务无效或已失效' }, 401, cors);
  if (job.status !== 'uploading' || index < 0 || index >= job.count) return json({ error: '图片序号无效' }, 409, cors);
  const contentType = request.headers.get('Content-Type') || '';
  const length = Number(request.headers.get('Content-Length'));
  if (!contentType.startsWith('image/') || !Number.isFinite(length) || length < 1 || length > MAX_IMAGE_BYTES || !request.body) return json({ error: '单张图片必须小于 6 MB' }, 413, cors);
  const key = job.mode === 'original' ? outputKey(jobId, index) : inputKey(jobId, index);
  await env.COLLECTIONS.put(key, request.body, { expirationTtl: job.mode === 'original' ? OUTPUT_TTL : INPUT_TTL, metadata: { contentType, bytes: length } });
  return new Response(null, { status: 204, headers: cors });
}

async function startJob(request: Request, env: Env, jobId: string, serviceOrigin: string): Promise<Response> {
  const cors = corsFor(request, env);
  if (!cors) return json({ error: 'Origin not allowed' }, 403);
  const job = await authorizedJob(request, env, jobId);
  if (!job) return json({ error: '任务无效或已失效' }, 401, cors);
  // Starting is idempotent. A mobile browser can lose the response after the
  // server has accepted the task, then safely retry when it returns foreground.
  if (job.status === 'queued' || job.status === 'processing' || job.status === 'complete') {
    return json({ status: job.status }, 202, cors);
  }
  if (job.status === 'error') return json({ error: job.error || '任务处理失败' }, 409, cors);
  if (job.mode === 'original') {
    job.status = 'complete'; job.completed = job.count; await putJob(env, jobId, job);
    return json({ status: job.status }, 202, cors);
  }
  for (let index = 0; index < job.count; index += 1) {
    if (!await env.COLLECTIONS.get(inputKey(jobId, index), { type: 'stream' })) return json({ error: `缺少第 ${index + 1} 张图片` }, 409, cors);
  }
  const modalSecret = (env as Env & { MODAL_SHARED_SECRET?: string }).MODAL_SHARED_SECRET;
  if (!env.MODAL_ENDPOINT || !modalSecret) return json({ error: '云端抠图服务尚未配置' }, 503, cors);
  job.status = 'queued';
  await putJob(env, jobId, job);
  const response = await fetch(env.MODAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${modalSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_base: serviceOrigin, count: job.count, job_id: jobId, job_token: bearer(request) })
  });
  if (!response.ok) {
    job.status = 'error'; job.error = '云端任务启动失败'; await putJob(env, jobId, job);
    return json({ error: job.error }, 502, cors);
  }
  return json({ status: job.status }, 202, cors);
}

async function getJob(request: Request, env: Env, jobId: string, serviceOrigin: string): Promise<Response> {
  const cors = corsFor(request, env);
  if (!cors) return json({ error: 'Origin not allowed' }, 403);
  const job = await authorizedJob(request, env, jobId);
  if (!job) return json({ error: '任务无效或已失效' }, 401, cors);
  const results = job.status === 'complete' ? Array.from({ length: job.count }, (_, index) => `${serviceOrigin}/media/${jobId}/${index}`) : [];
  return json({ completed: job.completed, count: job.count, error: job.error || '', results, status: job.status }, 200, cors);
}

async function getInput(request: Request, env: Env, jobId: string, index: number): Promise<Response> {
  const job = await authorizedJob(request, env, jobId);
  if (!job || index < 0 || index >= job.count) return json({ error: 'Unauthorized' }, 401);
  const object = await env.COLLECTIONS.getWithMetadata<{ contentType?: string }>(inputKey(jobId, index), { type: 'stream' });
  if (!object.value) return json({ error: 'Image not found' }, 404);
  return new Response(object.value, { headers: { 'Content-Type': object.metadata?.contentType || 'image/jpeg' } });
}

async function putResult(request: Request, env: Env, jobId: string, index: number): Promise<Response> {
  const job = await authorizedJob(request, env, jobId);
  if (!job || index < 0 || index >= job.count || !request.body) return json({ error: 'Unauthorized' }, 401);
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return json({ error: 'Result too large' }, 413);
  await env.COLLECTIONS.put(outputKey(jobId, index), request.body, { expirationTtl: OUTPUT_TTL, metadata: { contentType: 'image/webp' } });
  await env.COLLECTIONS.delete(inputKey(jobId, index));
  job.completed = Math.max(job.completed, index + 1); job.status = 'processing'; await putJob(env, jobId, job);
  return new Response(null, { status: 204 });
}

async function updateJobStatus(request: Request, env: Env, jobId: string): Promise<Response> {
  const job = await authorizedJob(request, env, jobId);
  if (!job) return json({ error: 'Unauthorized' }, 401);
  const body = await readJson<{ completed?: number; error?: string; status?: JobStatus }>(request);
  if (body.status && ['processing', 'complete', 'error'].includes(body.status)) job.status = body.status;
  if (Number.isInteger(body.completed)) job.completed = Math.max(0, Math.min(job.count, Number(body.completed)));
  if (body.error) job.error = String(body.error).slice(0, 180);
  await putJob(env, jobId, job);
  return new Response(null, { status: 204 });
}

async function createCollection(request: Request, env: Env, serviceOrigin: string): Promise<Response> {
  const cors = corsFor(request, env);
  if (!cors) return json({ error: 'Origin not allowed' }, 403);
  const body = await readJson<{ background?: string; items?: Array<{ index: number; jobId: string; token: string }>; mode?: ProcessingMode; title?: string }>(request);
  const items = body.items || [];
  if (!items.length || items.length > MAX_IMAGES) return json({ error: '图集需要 1–50 张图片' }, 400, cors);
  const authorizedJobs = new Set<string>();
  for (const item of items) {
    const job = await getJobRecord(env, item.jobId);
    if (!job || (!authorizedJobs.has(item.jobId) && job.tokenHash !== await sha256(item.token)) || !Number.isInteger(item.index) || item.index < 0 || item.index >= job.count) return json({ error: '图集包含无效图片' }, 401, cors);
    authorizedJobs.add(item.jobId);
    if (!await env.COLLECTIONS.get(outputKey(item.jobId, item.index), { type: 'stream' })) return json({ error: '图片尚未处理完成' }, 409, cors);
  }
  const id = randomId();
  const background = /^#[0-9a-f]{6}$/i.test(body.background || '') ? body.background! : '#f3efe8';
  const manifest = { background, createdAt: new Date().toISOString(), items: items.map(({ jobId, index }) => ({ jobId, index })), mode: body.mode === 'original' ? 'original' : 'cutout', title: String(body.title || '精选系列').slice(0, 40) };
  await env.COLLECTIONS.put(`collection:${id}`, JSON.stringify(manifest), { expirationTtl: COLLECTION_TTL });
  return json({ expiresAt: new Date(Date.now() + COLLECTION_TTL * 1000).toISOString(), url: `${serviceOrigin}/c/${id}` }, 201, cors);
}

async function getCollection(id: string, env: Env, serviceOrigin: string): Promise<Response> {
  const manifest = await env.COLLECTIONS.get<{ background?: string; createdAt: string; items: Array<{ index: number; jobId: string }>; mode?: ProcessingMode; title: string }>(`collection:${id}`, 'json');
  if (!manifest) return new Response(notFoundPage(), { status: 404, headers: htmlHeaders('no-store') });
  return new Response(collectionPage(manifest, serviceOrigin), { headers: htmlHeaders('public, max-age=60') });
}

async function getMedia(env: Env, jobId: string, index: number): Promise<Response> {
  const object = await env.COLLECTIONS.getWithMetadata<{ contentType?: string }>(outputKey(jobId, index), { type: 'stream', cacheTtl: 3600 });
  if (!object.value) return new Response(null, { status: 404 });
  return new Response(object.value, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400', 'Content-Type': object.metadata?.contentType || 'image/webp', 'X-Content-Type-Options': 'nosniff' } });
}

async function authorizedJob(request: Request, env: Env, jobId: string): Promise<JobRecord | null> {
  const token = bearer(request); const job = await getJobRecord(env, jobId);
  return token && job && await sha256(token) === job.tokenHash ? job : null;
}

function bearer(request: Request): string { return (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''); }
function corsFor(request: Request, env: Env): Headers | null {
  const origin = request.headers.get('Origin');
  const allowed = origin === env.ALLOWED_ORIGIN || (origin !== null && LOCAL_ORIGIN_PATTERN.test(origin));
  if (!allowed || !origin) return null;
  return new Headers({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' });
}
function handleOptions(request: Request, env: Env): Response { const cors = corsFor(request, env); return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 }); }
async function readJson<T>(request: Request): Promise<T> { if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new Error('Expected JSON'); return await request.json<T>(); }
async function getJobRecord(env: Env, id: string): Promise<JobRecord | null> { return await env.COLLECTIONS.get<JobRecord>(`job:${id}`, 'json'); }
async function putJob(env: Env, id: string, job: JobRecord): Promise<void> { await env.COLLECTIONS.put(`job:${id}`, JSON.stringify(job), { expirationTtl: OUTPUT_TTL }); }
function inputKey(jobId: string, index: number): string { return `input:${jobId}:${index}`; }
function outputKey(jobId: string, index: number): string { return `output:${jobId}:${index}`; }
function randomId(): string { return crypto.randomUUID().replaceAll('-', ''); }
async function makeRateKey(ip: string): Promise<string> { return `rate:${await sha256(`${ip}:${Math.floor(Date.now() / 3_600_000)}`)}`; }
async function sha256(value: string): Promise<string> { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''); }

function collectionPage(manifest: { background?: string; createdAt: string; items: Array<{ index: number; jobId: string }>; mode?: ProcessingMode; title: string }, origin: string): string {
  const columns = ['', ''];
  manifest.items.forEach((item, index) => {
    columns[index % 2] += `<figure><img src="${origin}/media/${item.jobId}/${item.index}" alt="服装单品 ${index + 1}" loading="lazy"><figcaption>LOOK ${String(index + 1).padStart(2, '0')}</figcaption></figure>`;
  });
  const cards = columns.map((items) => `<div class="gallery-column">${items}</div>`).join('');
  const background = /^#[0-9a-f]{6}$/i.test(manifest.background || '') ? manifest.background! : '#f5f1ea';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${background}"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(manifest.title)}</title><style>*{box-sizing:border-box}body{margin:0;color:#181512;background:${background};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}header{padding:36px 12px 22px;border-bottom:1px solid rgba(24,21,18,.14)}small{display:block;margin-bottom:10px;color:#6f675f;font-size:8px;letter-spacing:.22em}h1{max-width:650px;margin:0;font-family:Helvetica,Arial,sans-serif;font-size:clamp(34px,10vw,62px);font-weight:300;line-height:.96;letter-spacing:-.04em}.summary{margin:14px 0 0;color:#6b645d;font-size:10px}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:4px;max-width:900px;margin:auto;padding:4px}.gallery-column{display:flex;min-width:0;flex-direction:column;gap:7px}figure{width:100%;margin:0}img{display:block;width:100%;height:auto;background:${background}}figcaption{padding:4px 2px 0;color:#716960;font-family:Georgia,serif;font-size:8px;letter-spacing:.12em}footer{padding:28px 12px 36px;border-top:1px solid rgba(24,21,18,.14);color:#726a62;font-family:Georgia,serif;font-size:9px;text-align:center;letter-spacing:.14em}@media(min-width:700px){header{padding:56px max(12px,calc((100vw - 876px)/2)) 32px}.gallery{gap:6px;padding-top:6px}.gallery-column{gap:9px}}</style></head><body><header><small>PRIVATE COLLECTION</small><h1>${escapeHtml(manifest.title)}</h1><p class="summary">${manifest.items.length} 件单品 · ${new Date(manifest.createdAt).toLocaleDateString('zh-CN')}</p></header><main class="gallery">${cards}</main><footer>CURATED COLLECTION</footer></body></html>`;
}
function htmlHeaders(cacheControl: string): Headers { return new Headers({ 'Cache-Control': cacheControl, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Content-Type': 'text/html;charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' }); }
function json(body: Record<string, unknown>, status: number, extraHeaders?: Headers | null): Response { const headers = new Headers(extraHeaders || undefined); headers.set('Content-Type', 'application/json;charset=utf-8'); headers.set('X-Content-Type-Options', 'nosniff'); return Response.json(body, { status, headers }); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] || char); }
function notFoundPage(): string { return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>图集已失效</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;color:#181512;background:#f5f1ea;font-family:system-ui}main{text-align:center}h1{font-family:Georgia,serif;font-size:42px;font-weight:400}p{color:#6c645d}</style><main><h1>这份图集已失效</h1><p>分享链接可能已超过 30 天。</p></main></html>'; }
