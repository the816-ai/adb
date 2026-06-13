/**
 * Live E2E post test — launch campaign job and monitor until terminal.
 * Usage: node scripts/test-live-post.js [campaignId]
 */
const fs = require('fs');
const path = require('path');

const API = process.env.API_BASE || 'http://127.0.0.1:3001';
const CAMPAIGN_ID = process.argv[2] || '93d0673c-367f-47fd-875e-75f2bc5b5db4';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'ready_manual', 'need_manual_check']);

async function api(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${urlPath}`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLogTimings(logLines, jobShort) {
  const rows = logLines.filter((l) => l.includes(`[${jobShort}]`) || l.includes('Starting job'));
  const steps = [];
  let start = null;
  let end = null;
  for (const line of rows) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    if (!m) continue;
    const ts = new Date(m[1]).getTime();
    if (line.includes('Starting job') && line.includes(jobShort)) start = ts;
    if (line.includes('flow: Chế độ: Tự động đăng')) steps.push({ t: m[1], step: 'start_flow' });
    if (line.includes('open_tiktok: TikTok sẵn sàng')) steps.push({ t: m[1], step: 'tiktok_ready' });
    if (line.includes('deliver_video: OK')) steps.push({ t: m[1], step: 'deliver_ok' });
    if (line.includes('input_caption:')) steps.push({ t: m[1], step: line.split('input_caption: ')[1]?.slice(0, 40) });
    if (line.includes('click_post: Post đã khởi chạy')) steps.push({ t: m[1], step: 'post_started' });
    if (line.includes('wait_result: Đăng thành công')) steps.push({ t: m[1], step: 'success' });
    if (line.includes('Job ') && line.includes('completed successfully')) end = ts;
    if (line.includes('failed') && line.includes(jobShort)) end = ts;
  }
  return { start, end, steps, totalSec: start && end ? Math.round((end - start) / 1000) : null };
}

async function main() {
  const health = await api('GET', '/api/health');
  console.log(`Health: adb=${health.adb} devices=${health.devices_online} worker=${health.worker?.running ? health.worker.pid : 'OFF'}`);
  if (!health.worker?.running) throw new Error('Worker không chạy — npm run worker');

  const detail = await api('GET', `/api/campaigns/${CAMPAIGN_ID}`);
  console.log(`Campaign: ${detail.campaign.name} (${detail.campaign.status}) · ${detail.videos?.length || 0} video`);

  const launch = await api('POST', `/api/campaigns/${CAMPAIGN_ID}/launch`, {
    immediate: true,
    skip_posted: false,
    post_mode: 'auto',
  });
  console.log(`Launch OK: ${launch.count} job(s) batch=${launch.batch_id}`);
  let job = launch.jobs?.[0];
  if (!job) throw new Error('Launch không trả về job');
  const short = job.id.slice(0, 8);
  console.log(`Job: ${job.id} status=${job.status} video=${job.video_path}`);

  const t0 = Date.now();
  let lastStatus = '';
  while (Date.now() - t0 < 360000) {
    const list = await api('GET', `/api/jobs?limit=20`);
    const cur = (list.jobs || []).find((j) => j.id === job.id) || job;
    if (cur.status !== lastStatus) {
      console.log(`[${new Date().toLocaleTimeString('vi-VN')}] status → ${cur.status}${cur.error ? ' | ' + cur.error : ''}`);
      lastStatus = cur.status;
    }
    if (TERMINAL.has(cur.status)) {
      job = cur;
      break;
    }
    await sleep(5000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`Status: ${job.status}`);
  console.log(`Thời gian theo dõi: ${elapsed}s`);
  if (job.error) console.log(`Lỗi: ${job.error} (${job.error_code || '-'})`);

  const deviceId = job.device_id || 'R94Y60BCW2T';
  const logFile = path.join(LOG_DIR, `${deviceId}.log`);
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-120);
    const timing = parseLogTimings(lines, short);
    if (timing.totalSec != null) console.log(`Thời gian pipeline (log): ${timing.totalSec}s`);
    console.log('\n--- Các mốc log ---');
    for (const s of timing.steps.slice(-12)) console.log(`  ${s.t}  ${s.step}`);
    const retries = lines.filter((l) => l.includes(short) && l.includes('Chưa thấy posting')).length;
    const fastPath = lines.some((l) => l.includes(short) && (l.includes('post_button_gone') || l.includes('fast_complete')));
    const pasteFast = lines.some((l) => l.includes(short) && l.includes('Paste nhanh'));
    console.log(`\nRetry đăng: ${retries} · fast_complete: ${fastPath} · paste nhanh: ${pasteFast}`);
  }

  process.exit(job.status === 'done' ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
