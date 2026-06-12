require('./env').loadEnv();

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const adb = require('./adb');
const db = require('./db');
const { getErrorInfo, listErrors } = require('./errors');
const { requireApiKey, isAuthEnabled, authStatus } = require('./middleware/auth');
const { apiReadLimiter, apiWriteLimiter } = require('./middleware/rate-limit');
const { backupDatabase, startBackupScheduler, listBackups } = require('./ops/backup');
const { runMaintenance, startMaintenanceScheduler } = require('./ops/cleanup');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || process.env.BIND_HOST || '127.0.0.1';
const NODE_ENV = process.env.NODE_ENV || 'development';
const VIDEOS_DIR = path.join(__dirname, 'videos');

app.set('trust proxy', process.env.TRUST_PROXY === '1');

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: VIDEOS_DIR,
    filename: (req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận video: mp4, mov, webm, mkv, m4v'));
    }
  },
});

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const api = express.Router();
api.use(apiReadLimiter);

function safeArtifactPath(filename) {
  const base = path.basename(filename);
  const file = path.join(adb.SCREENSHOTS_DIR, base);
  if (!file.startsWith(adb.SCREENSHOTS_DIR)) return null;
  return fs.existsSync(file) ? file : null;
}

api.get('/auth/status', (req, res) => {
  res.json(authStatus());
});

api.get('/health', (req, res) => {
  let adbOk = false;
  let deviceCount = 0;
  try {
    deviceCount = adb.getDevices().length;
    adbOk = true;
  } catch (_) {}

  const workerStatus = require('./worker-instance').getWorkerStatus();

  res.json({
    ok: true,
    version: require('./package.json').version,
    adb: adbOk,
    devices_online: deviceCount,
    worker: workerStatus,
    config: {
      poll_interval_ms: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
      job_cooldown_ms: parseInt(process.env.JOB_COOLDOWN_MS || '30000', 10),
      device_stale_ms: parseInt(process.env.DEVICE_STALE_MS || '900000', 10),
    },
    post_modes: db.POST_MODES,
    flow_steps: {
      auto: require('./tiktok-flow').FLOW_STEPS_AUTO,
      manual: require('./tiktok-flow').FLOW_STEPS_MANUAL,
      engage: require('./engagement-flow').FLOW_STEPS_ENGAGE,
    },
    engage_defaults: require('./engagement-flow').DEFAULT_CONFIG,
    auth: authStatus(),
    environment: NODE_ENV,
    time: new Date().toISOString(),
  });
});

api.get('/ready', (req, res) => {
  const workerStatus = require('./worker-instance').getWorkerStatus();
  let adbOk = false;
  let deviceCount = 0;
  try {
    deviceCount = adb.getDevices().length;
    adbOk = true;
  } catch (_) {}

  const ready = adbOk && workerStatus.running;
  res.status(ready ? 200 : 503).json({
    ready,
    adb: adbOk,
    devices_online: deviceCount,
    worker: workerStatus,
    auth: authStatus(),
  });
});

api.use(requireApiKey);

api.get('/errors', (req, res) => {
  res.json(listErrors());
});

api.get('/devices', (req, res) => {
  try {
    const online = adb.getDevices();
    const result = online.map(({ id }) => {
      const record = db.upsertDevice(id, {});
      const currentJob = record.current_job_id ? db.getJob(record.current_job_id) : null;
      return { ...record, online: true, current_job: currentJob };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.patch('/devices/:id', apiWriteLimiter, (req, res) => {
  const { label, tiktok_account } = req.body;
  const fields = {};
  if (label !== undefined) fields.label = String(label);
  if (tiktok_account !== undefined) {
    fields.tiktok_account = tiktok_account ? String(tiktok_account).trim() : null;
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const updated = db.upsertDevice(req.params.id, fields);
  res.json(updated);
});

api.get('/devices/:id/logs', (req, res) => {
  const lines = parseInt(req.query.lines || '300', 10);
  res.json({
    device_id: req.params.id,
    lines: adb.readDeviceLog(req.params.id, lines),
  });
});

api.post('/devices/:id/live-screenshot', apiWriteLimiter, async (req, res) => {
  const deviceId = req.params.id;
  if (!adb.isDeviceOnline(deviceId)) {
    return res.status(400).json({ error: 'Device offline' });
  }
  try {
    const shot = await adb.screenshot(deviceId, 'live');
    if (!shot) return res.status(500).json({ error: 'Screenshot failed' });
    res.json({ path: shot, url: adb.artifactUrl(shot) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post('/devices/:id/live-dump', apiWriteLimiter, async (req, res) => {
  const deviceId = req.params.id;
  if (!adb.isDeviceOnline(deviceId)) {
    return res.status(400).json({ error: 'Device offline' });
  }
  try {
    const { content, path: uiPath } = await adb.dumpUi(deviceId, 'live');
    res.json({
      path: uiPath,
      url: uiPath ? adb.artifactUrl(uiPath) : null,
      node_count: content ? (content.match(/<node/g) || []).length : 0,
      preview: content ? content.slice(0, 2000) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.get('/jobs', (req, res) => {
  const { status, device_id, post_mode, error_code, search, limit, offset } = req.query;
  const result = db.listJobsFiltered({
    status,
    device_id,
    post_mode,
    error_code,
    search,
    limit: parseInt(limit || '100', 10),
    offset: parseInt(offset || '0', 10),
  });
  res.json(result);
});

api.get('/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

api.get('/jobs/:id/detail', (req, res) => {
  const detail = db.getJobDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Job not found' });

  const errorInfo = detail.job.error_code ? getErrorInfo(detail.job.error_code) : null;
  const deviceLogs = detail.job.device_id
    ? adb.readDeviceLog(detail.job.device_id, 150)
    : [];

  res.json({
    ...detail,
    error_info: errorInfo,
    device_logs: deviceLogs,
  });
});

function resolveVideoPath(video_path) {
  if (!video_path) return null;
  const fullPath = path.isAbsolute(video_path)
    ? video_path
    : path.join(__dirname, video_path);
  if (!fullPath.startsWith(VIDEOS_DIR) && !path.isAbsolute(video_path)) {
    return path.join(__dirname, video_path);
  }
  return fullPath;
}

function normalizePostMode(mode) {
  return db.normalizePostMode(mode);
}

function createJobFromVideo({
  device_id, video_path, caption, post_mode, tiktok_account, source = 'path',
}) {
  const fullPath = resolveVideoPath(video_path);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { error: `Video file not found: ${video_path}`, status: 400 };
  }
  const mode = normalizePostMode(post_mode);
  if (mode === db.POST_MODES.AUTO && (!caption || !String(caption).trim())) {
    return { error: 'caption is required for auto post mode', status: 400 };
  }

  const storedPath = path.isAbsolute(video_path)
    ? `videos/${path.basename(video_path)}`
    : video_path;

  const job = db.createJob({
    device_id: device_id || null,
    video_path: storedPath,
    caption: String(caption || '').trim() || '(đăng thủ công)',
    post_mode: mode,
    tiktok_account: tiktok_account ? String(tiktok_account).trim() : null,
  });
  const modeLabel = mode === db.POST_MODES.MANUAL ? 'chuẩn bị đăng thủ công' : 'tự động đăng';
  db.addJobEvent(job.id, {
    step: 'queue',
    level: 'info',
    message: source === 'upload'
      ? `Upload + queue [${modeLabel}]: ${path.basename(fullPath)}`
      : `Job queue [${modeLabel}]`,
  });
  return { job, fullPath };
}

api.get('/videos', (req, res) => {
  const files = fs.readdirSync(VIDEOS_DIR)
    .filter((f) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(VIDEOS_DIR, f));
      return {
        name: f,
        path: `videos/${f}`,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(files);
});

api.post('/videos/upload', apiWriteLimiter, upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Chưa chọn file video từ máy tính' });
  }
  res.status(201).json({
    video_path: `videos/${req.file.filename}`,
    filename: req.file.filename,
    size: req.file.size,
    message: 'Đã lưu video trên server — sẵn sàng đăng',
  });
});

api.post('/jobs/upload', apiWriteLimiter, upload.single('video'), (req, res) => {
  const { caption, device_id, post_mode, tiktok_account } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: 'Chưa chọn file video từ máy tính' });
  }
  const video_path = `videos/${req.file.filename}`;
  const result = createJobFromVideo({
    device_id: device_id || null,
    video_path,
    caption,
    post_mode,
    tiktok_account,
    source: 'upload',
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(201).json(result.job);
});

api.post('/jobs', apiWriteLimiter, (req, res) => {
  const { device_id, video_path, caption, post_mode, tiktok_account } = req.body;
  if (!video_path) {
    return res.status(400).json({ error: 'video_path is required' });
  }
  const result = createJobFromVideo({
    device_id, video_path, caption, post_mode, tiktok_account, source: 'path',
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(201).json(result.job);
});

api.post('/jobs/engage', apiWriteLimiter, (req, res) => {
  const {
    device_id,
    tiktok_account,
    duration_minutes,
    like_ratio,
    watch_min_sec,
    watch_max_sec,
    max_videos,
    profile_ratio,
    comment_view_ratio,
    comment_post_ratio,
    comment_like_ratio,
    pause_ratio,
  } = req.body;

  const config = {};
  if (duration_minutes !== undefined) config.duration_minutes = Number(duration_minutes);
  if (like_ratio !== undefined) config.like_ratio = Number(like_ratio);
  if (watch_min_sec !== undefined) config.watch_min_sec = Number(watch_min_sec);
  if (watch_max_sec !== undefined) config.watch_max_sec = Number(watch_max_sec);
  if (max_videos !== undefined) config.max_videos = Number(max_videos);
  if (profile_ratio !== undefined) config.profile_ratio = Number(profile_ratio);
  if (comment_view_ratio !== undefined) config.comment_view_ratio = Number(comment_view_ratio);
  if (comment_post_ratio !== undefined) config.comment_post_ratio = Number(comment_post_ratio);
  if (comment_like_ratio !== undefined) config.comment_like_ratio = Number(comment_like_ratio);
  if (pause_ratio !== undefined) config.pause_ratio = Number(pause_ratio);

  const job = db.createEngageJob({
    device_id: device_id || null,
    config,
    tiktok_account: tiktok_account ? String(tiktok_account).trim() : null,
  });
  db.addJobEvent(job.id, {
    step: 'queue',
    level: 'info',
    message: `Job treo kiểu người thật — ${config.duration_minutes || 'mặc định'} phút · tim ${config.like_ratio != null ? Math.round(config.like_ratio * 100) + '%' : 'mặc định'} · profile ${config.profile_ratio != null ? Math.round(config.profile_ratio * 100) + '%' : 'mặc định'}`,
  });
  res.status(201).json(job);
});

api.patch('/jobs/:id', apiWriteLimiter, (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { status, post_mode: postMode } = req.body;

  if (isAuthEnabled() && status !== undefined) {
    return res.status(403).json({
      error: 'Production: không cho phép đổi status thủ công — dùng retry/cancel',
    });
  }

  if (status && !db.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Valid: ${db.VALID_STATUSES.join(', ')}` });
  }

  if (db.NON_TERMINAL_ACTIVE.includes(job.status) && status && status !== job.status) {
    return res.status(400).json({
      error: `Không đổi status job đang chạy (${job.status}) — cancel hoặc chờ worker xong`,
    });
  }

  if (postMode !== undefined && job.status !== 'pending') {
    return res.status(400).json({ error: 'Chỉ đổi post_mode khi job còn pending' });
  }

  const allowed = {};
  if (status !== undefined) allowed.status = status;
  if (req.body.device_id !== undefined) allowed.device_id = req.body.device_id;
  if (postMode !== undefined) allowed.post_mode = postMode;

  const updated = db.updateJob(req.params.id, allowed);
  res.json(updated);
});

api.post('/jobs/:id/retry', apiWriteLimiter, (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (!['failed', 'need_manual_check'].includes(job.status)) {
    return res.status(400).json({ error: 'Only failed or need_manual_check jobs can be retried' });
  }

  if (job.device_id && db.isDeviceBusy(job.device_id)) {
    return res.status(409).json({
      error: `Thiết bị ${job.device_id} đang busy — chờ worker xong hoặc kiểm tra TikTok trước khi retry`,
    });
  }

  const updated = db.updateJob(req.params.id, {
    status: 'pending',
    error: null,
    error_code: null,
    screenshot: null,
    started_at: null,
    finished_at: null,
    cancel_requested: 0,
  });
  db.addJobEvent(job.id, { step: 'queue', level: 'info', message: 'Job được retry — quay lại pending' });
  res.json(updated);
});

api.post('/jobs/:id/cancel', apiWriteLimiter, (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const updated = db.requestJobCancel(req.params.id);
  if (!updated) {
    return res.status(400).json({
      error: `Không thể cancel job ở trạng thái "${job.status}"`,
      cancellable: db.CANCELLABLE_STATUSES,
    });
  }

  const msg = updated.cancel_requested && updated.status !== 'failed'
    ? 'Đã gửi yêu cầu hủy — worker dừng ở bước kế tiếp'
    : 'Job bị hủy từ dashboard';
  db.addJobEvent(job.id, { step: 'operator', level: 'warn', message: msg });
  res.json(updated);
});

api.get('/stats', (req, res) => {
  res.json(db.getStats());
});

api.post('/ops/backup', apiWriteLimiter, (req, res) => {
  const result = backupDatabase('manual');
  if (!result.ok) return res.status(500).json(result);
  res.json({ ...result, backups: listBackups().slice(0, 5) });
});

api.post('/ops/cleanup', apiWriteLimiter, (req, res) => {
  res.json(runMaintenance());
});

api.get('/ops/backups', (req, res) => {
  res.json({ backups: listBackups() });
});

api.get('/artifacts/:filename', (req, res) => {
  const file = safeArtifactPath(req.params.filename);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

api.get('/screenshots/:filename', (req, res) => {
  const file = safeArtifactPath(req.params.filename);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

app.use('/api', api);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Video quá lớn (tối đa 500MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

let backupTimer = null;
let cleanupTimer = null;
let server = null;

function shutdown(signal) {
  console.log(`\n[server] ${signal} — shutting down...`);
  if (backupTimer) clearInterval(backupTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}

function startServer() {
  server = app.listen(PORT, HOST, () => {
    const auth = authStatus();
    console.log(`TikTok ADB Auto server [${NODE_ENV}]`);
    console.log(`  → http://${HOST}:${PORT}`);
    console.log(`  → Auth: ${auth.enabled ? 'ENABLED (API_KEY set)' : 'disabled — set API_KEY trong .env cho production'}`);
    if (NODE_ENV === 'production' && !auth.enabled) {
      console.warn('[WARN] NODE_ENV=production nhưng API_KEY chưa cấu hình (≥8 ký tự)');
    }

    try {
      const bootBackup = backupDatabase('startup');
      if (bootBackup.ok) {
        console.log(`  → DB backup: ${path.basename(bootBackup.path)}`);
      }
    } catch (err) {
      console.warn(`  → DB backup skipped: ${err.message}`);
    }

    backupTimer = startBackupScheduler();
    cleanupTimer = startMaintenanceScheduler();
  });
  return server;
}

if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  startServer();
}

module.exports = { app, startServer };
