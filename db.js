const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'jobs', 'jobs.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    video_path TEXT NOT NULL,
    caption TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    error_code TEXT,
    screenshot TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT,
    busy INTEGER NOT NULL DEFAULT 0,
    current_job_id TEXT,
    last_seen TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    step TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT,
    artifact_path TEXT,
    artifact_type TEXT,
    meta TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_device ON jobs(device_id);
  CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
`);

try {
  db.exec('ALTER TABLE devices ADD COLUMN heartbeat_at TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
} catch (_) { /* column exists */ }

try {
  db.exec("ALTER TABLE jobs ADD COLUMN post_mode TEXT NOT NULL DEFAULT 'auto'");
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN tiktok_account TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE devices ADD COLUMN tiktok_account TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN scheduled_at TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN batch_id TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN sequence_index INTEGER');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN interval_after_sec INTEGER');
} catch (_) { /* column exists */ }

try {
  db.exec('ALTER TABLE devices ADD COLUMN last_post_finished_at TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_pending_schedule ON jobs(status, scheduled_at, created_at)');
} catch (_) { /* index exists */ }

try {
  db.exec('ALTER TABLE jobs ADD COLUMN campaign_id TEXT');
} catch (_) { /* column exists */ }

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_campaign ON jobs(campaign_id)');
} catch (_) { /* index exists */ }

const POST_MODES = {
  AUTO: 'auto',
  MANUAL: 'manual',
  ENGAGE: 'engage',
};

const CANCELLABLE_STATUSES = [
  'pending',
  'assigned',
  'running',
  'pushing_video',
  'opening_app',
  'selecting_video',
  'input_caption',
  'posting',
  'ready_manual',
  'engaging',
];

const TERMINAL_STATUSES = ['done', 'failed', 'need_manual_check', 'ready_manual'];

const CAMPAIGN_JOB_TERMINAL = TERMINAL_STATUSES;

const NON_TERMINAL_ACTIVE = [
  'assigned',
  'running',
  'pushing_video',
  'opening_app',
  'selecting_video',
  'input_caption',
  'posting',
  'engaging',
];

const VALID_STATUSES = [
  'pending',
  'assigned',
  'running',
  'pushing_video',
  'opening_app',
  'selecting_video',
  'input_caption',
  'posting',
  'engaging',
  'done',
  'ready_manual',
  'failed',
  'need_manual_check',
];

function now() {
  return new Date().toISOString();
}

function normalizePostMode(post_mode) {
  if (post_mode === POST_MODES.MANUAL) return POST_MODES.MANUAL;
  if (post_mode === POST_MODES.ENGAGE) return POST_MODES.ENGAGE;
  return POST_MODES.AUTO;
}

function createJob({
  device_id = null,
  video_path,
  caption,
  post_mode = POST_MODES.AUTO,
  tiktok_account = null,
  scheduled_at = null,
  batch_id = null,
  sequence_index = null,
  interval_after_sec = null,
  campaign_id = null,
}) {
  const id = uuidv4();
  const ts = now();
  const mode = normalizePostMode(post_mode);
  const account = tiktok_account ? String(tiktok_account).trim() : null;
  db.prepare(`
    INSERT INTO jobs (
      id, device_id, video_path, caption, status, post_mode, tiktok_account,
      scheduled_at, batch_id, sequence_index, interval_after_sec, campaign_id,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    device_id,
    video_path,
    caption,
    mode,
    account,
    scheduled_at,
    batch_id,
    sequence_index,
    interval_after_sec,
    campaign_id || null,
    ts,
    ts
  );
  return getJob(id);
}

function deletePendingJobsByIds(jobIds = []) {
  if (!jobIds.length) return 0;
  const placeholders = jobIds.map(() => '?').join(', ');
  db.prepare(`DELETE FROM job_events WHERE job_id IN (${placeholders})`).run(...jobIds);
  const result = db.prepare(`
    DELETE FROM jobs WHERE id IN (${placeholders}) AND status = 'pending'
  `).run(...jobIds);
  return result.changes;
}

const createJobsInTransaction = db.transaction((records) => {
  const jobs = [];
  for (const record of records) {
    jobs.push(createJob(record));
  }
  return jobs;
});

function transaction(fn) {
  return db.transaction(fn);
}

function createEngageJob({ device_id = null, config = {}, tiktok_account = null }) {
  const { ENGAGE_VIDEO_PATH } = require('./engagement-flow');
  const caption = JSON.stringify({
    duration_minutes: config.duration_minutes,
    like_ratio: config.like_ratio,
    watch_min_sec: config.watch_min_sec,
    watch_max_sec: config.watch_max_sec,
    max_videos: config.max_videos,
    profile_ratio: config.profile_ratio,
    comment_view_ratio: config.comment_view_ratio,
    comment_post_ratio: config.comment_post_ratio,
    comment_like_ratio: config.comment_like_ratio,
    pause_ratio: config.pause_ratio,
    passive_ratio: config.passive_ratio,
    max_actions_per_video: config.max_actions_per_video,
    min_action_gap_sec: config.min_action_gap_sec,
    min_like_gap_sec: config.min_like_gap_sec,
  });
  return createJob({
    device_id,
    video_path: ENGAGE_VIDEO_PATH,
    caption,
    post_mode: POST_MODES.ENGAGE,
    tiktok_account,
  });
}

function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function listJobs({ status, limit = 100 } = {}) {
  if (status) {
    return db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function updateJob(id, fields) {
  const allowed = [
    'device_id', 'status', 'error', 'error_code', 'screenshot',
    'started_at', 'finished_at', 'cancel_requested', 'post_mode', 'tiktok_account',
    'scheduled_at', 'batch_id', 'sequence_index', 'interval_after_sec',
  ];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (sets.length === 0) return getJob(id);

  sets.push('updated_at = ?');
  values.push(now());
  values.push(id);

  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getJob(id);
}

function updateJobIfActive(id, fields) {
  const job = getJob(id);
  if (!job) return null;
  if (TERMINAL_STATUSES.includes(job.status)) return null;

  const allowed = [
    'device_id', 'status', 'error', 'error_code', 'screenshot',
    'started_at', 'finished_at', 'cancel_requested', 'post_mode', 'tiktok_account',
    'scheduled_at', 'batch_id', 'sequence_index', 'interval_after_sec',
  ];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return job;

  sets.push('updated_at = ?');
  values.push(now());
  values.push(id);

  const placeholders = NON_TERMINAL_ACTIVE.map(() => '?').join(', ');
  values.push(...NON_TERMINAL_ACTIVE);

  const result = db.prepare(`
    UPDATE jobs SET ${sets.join(', ')}
    WHERE id = ? AND status IN (${placeholders})
  `).run(...values);

  if (result.changes === 0) return null;
  return getJob(id);
}

function isDeviceBusy(deviceId) {
  const row = db.prepare('SELECT busy FROM devices WHERE id = ?').get(deviceId);
  return Boolean(row?.busy);
}

function getLastPendingScheduleAnchor(deviceId = null) {
  if (deviceId) {
    const forDevice = db.prepare(`
      SELECT scheduled_at, created_at FROM jobs
      WHERE status = 'pending' AND device_id = ?
      ORDER BY COALESCE(scheduled_at, created_at) DESC
      LIMIT 1
    `).get(deviceId);
    if (forDevice) return forDevice.scheduled_at || forDevice.created_at;

    const unassigned = db.prepare(`
      SELECT scheduled_at, created_at FROM jobs
      WHERE status = 'pending' AND (device_id IS NULL OR device_id = '')
      ORDER BY COALESCE(scheduled_at, created_at) DESC
      LIMIT 1
    `).get();
    return unassigned ? (unassigned.scheduled_at || unassigned.created_at) : null;
  }

  const row = db.prepare(`
    SELECT scheduled_at, created_at FROM jobs
    WHERE status = 'pending'
    ORDER BY COALESCE(scheduled_at, created_at) DESC
    LIMIT 1
  `).get();
  return row ? (row.scheduled_at || row.created_at) : null;
}

function pendingJobWhere() {
  return "status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)";
}

function getNextPendingJob(deviceId = null) {
  const ts = now();
  const where = pendingJobWhere();
  const order = `ORDER BY
    CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END ASC,
    COALESCE(scheduled_at, created_at) ASC,
    created_at ASC`;

  if (deviceId) {
    const forDevice = db.prepare(`
      SELECT * FROM jobs
      WHERE ${where} AND device_id = ?
      ${order}
      LIMIT 1
    `).get(ts, deviceId);
    if (forDevice) return forDevice;

    return db.prepare(`
      SELECT * FROM jobs
      WHERE ${where} AND (device_id IS NULL OR device_id = '')
      ${order}
      LIMIT 1
    `).get(ts);
  }

  return db.prepare(`
    SELECT * FROM jobs
    WHERE ${where}
    ${order}
    LIMIT 1
  `).get(ts);
}

function claimJob(jobId, deviceId) {
  const job = getJob(jobId);
  if (!job || job.status !== 'pending') return null;
  if (job.device_id && job.device_id !== deviceId) return null;

  const ts = now();
  const result = db.prepare(`
    UPDATE jobs
    SET device_id = ?, status = 'assigned', started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
      AND (device_id IS NULL OR device_id = '' OR device_id = ?)
  `).run(deviceId, ts, ts, jobId, deviceId);

  if (result.changes === 0) return null;
  return getJob(jobId);
}

const acquireDeviceJob = db.transaction((deviceId) => {
  const dev = db.prepare('SELECT busy FROM devices WHERE id = ?').get(deviceId);
  if (!dev || dev.busy) return null;

  const job = getNextPendingJob(deviceId);
  if (!job) return null;

  const ts = now();
  const devResult = db.prepare(`
    UPDATE devices
    SET busy = 1, current_job_id = ?, heartbeat_at = ?, last_seen = ?
    WHERE id = ? AND busy = 0
  `).run(job.id, ts, ts, deviceId);

  if (devResult.changes === 0) return null;

  const jobResult = db.prepare(`
    UPDATE jobs
    SET device_id = ?, status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
      AND (device_id IS NULL OR device_id = '' OR device_id = ?)
  `).run(deviceId, ts, ts, job.id, ts, deviceId);

  if (jobResult.changes === 0) {
    throw new Error('JOB_CLAIM_FAILED');
  }

  return getJob(job.id);
});

function recoverStaleBusyDevices(maxAgeMs = 600000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const staleDevices = db.prepare(`
    SELECT * FROM devices
    WHERE busy = 1 AND (heartbeat_at IS NULL OR heartbeat_at < ?)
  `).all(cutoff);

  const recovered = [];
  for (const device of staleDevices) {
    if (device.current_job_id) {
      const job = getJob(device.current_job_id);
      const terminal = ['done', 'failed', 'need_manual_check', 'pending'];
      if (job && !terminal.includes(job.status)) {
        updateJob(job.id, {
          status: 'need_manual_check',
          error: 'Worker timeout — kiểm tra thủ công trước khi retry (tránh đăng trùng)',
          error_code: 'WORKER_TIMEOUT',
          finished_at: now(),
        });
      }
    }
    db.prepare(`
      UPDATE devices SET busy = 0, current_job_id = NULL, last_error = ?
      WHERE id = ?
    `).run('Stale lock recovered', device.id);
    recovered.push({
      id: device.id,
      jobId: device.current_job_id,
    });
  }
  return { count: recovered.length, devices: recovered };
}

function releaseDevice(deviceId, jobId = null) {
  if (jobId) {
    const row = db.prepare('SELECT current_job_id, busy FROM devices WHERE id = ?').get(deviceId);
    if (!row || !row.busy || row.current_job_id !== jobId) {
      return false;
    }
  }
  const ts = now();
  db.prepare(`
    UPDATE devices SET busy = 0, current_job_id = NULL, heartbeat_at = ?, last_seen = ?
    WHERE id = ?
  `).run(ts, ts, deviceId);
  return true;
}

function touchDeviceHeartbeat(deviceId) {
  const ts = now();
  db.prepare('UPDATE devices SET heartbeat_at = ?, last_seen = ? WHERE id = ?').run(ts, ts, deviceId);
}

function requestJobCancel(jobId) {
  const job = getJob(jobId);
  if (!job || !CANCELLABLE_STATUSES.includes(job.status)) return null;

  const ts = now();
  if (['pending', 'assigned'].includes(job.status)) {
    updateJob(jobId, {
      status: 'failed',
      cancel_requested: 1,
      error: 'Cancelled by operator',
      error_code: 'CANCELLED',
      finished_at: ts,
    });
    return getJob(jobId);
  }

  updateJob(jobId, {
    cancel_requested: 1,
    error_code: 'CANCELLED',
    error: 'Cancel requested — worker dừng ở bước kế tiếp',
  });
  return getJob(jobId);
}

function isJobCancelRequested(jobId) {
  const job = getJob(jobId);
  return Boolean(job?.cancel_requested);
}

function upsertDevice(id, fields = {}) {
  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  const ts = now();

  if (existing) {
    const allowed = ['label', 'busy', 'current_job_id', 'last_seen', 'last_error', 'tiktok_account', 'last_post_finished_at'];
    const sets = ['last_seen = ?'];
    const values = [ts];

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }

    values.push(id);
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } else {
    db.prepare(`
      INSERT INTO devices (id, label, busy, current_job_id, last_seen, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fields.label || id,
      fields.busy || 0,
      fields.current_job_id || null,
      ts,
      fields.last_error || null
    );
  }

  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function setDeviceBusy(deviceId, busy, jobId = null) {
  return upsertDevice(deviceId, { busy: busy ? 1 : 0, current_job_id: jobId });
}

function getIdleDevices(onlineDeviceIds) {
  const idle = [];
  for (const id of onlineDeviceIds) {
    const device = upsertDevice(id, {});
    if (!device.busy) idle.push(device);
  }
  return idle;
}

function touchDeviceLastPost(deviceId) {
  if (!deviceId) return;
  upsertDevice(deviceId, { last_post_finished_at: now() });
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM jobs GROUP BY status').all();
  const scheduledWaiting = db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at > ?
  `).get(now()).c;
  const devices = db.prepare('SELECT * FROM devices').all();
  const recentFailures = db.prepare(`
    SELECT id, device_id, video_path, error_code, error, finished_at
    FROM jobs
    WHERE status IN ('failed', 'need_manual_check')
    ORDER BY finished_at DESC
    LIMIT 10
  `).all();

  return { total, byStatus, scheduledWaiting, devices, recentFailures };
}

function addJobEvent(jobId, { step, level = 'info', message = null, artifact_path = null, artifact_type = null, meta = null }) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO job_events (job_id, step, level, message, artifact_path, artifact_type, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    step,
    level,
    message,
    artifact_path,
    artifact_type,
    meta ? JSON.stringify(meta) : null,
    ts
  );
  return db.prepare('SELECT * FROM job_events WHERE id = ?').get(result.lastInsertRowid);
}

function listJobEvents(jobId) {
  const events = db.prepare(`
    SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC, id ASC
  `).all(jobId);
  return events.map((e) => ({
    ...e,
    meta: e.meta ? JSON.parse(e.meta) : null,
  }));
}

function getJobDetail(id) {
  const job = getJob(id);
  if (!job) return null;
  const events = listJobEvents(id);
  const artifacts = events
    .filter((e) => e.artifact_path)
    .map((e) => ({
      path: e.artifact_path,
      type: e.artifact_type,
      step: e.step,
      created_at: e.created_at,
    }));
  return { job, events, artifacts };
}

function listJobsFiltered({
  status, device_id, post_mode, error_code, search, batch_id, campaign_id,
  limit = 100, offset = 0,
} = {}) {
  const clauses = [];
  const values = [];

  if (status === 'scheduled') {
    clauses.push("status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at > ?");
    values.push(now());
  } else if (status) {
    clauses.push('status = ?');
    values.push(status);
  }
  if (batch_id) {
    clauses.push('batch_id = ?');
    values.push(batch_id);
  }
  if (campaign_id) {
    clauses.push('campaign_id = ?');
    values.push(campaign_id);
  }
  if (device_id) {
    clauses.push('device_id = ?');
    values.push(device_id);
  }
  if (post_mode) {
    clauses.push('post_mode = ?');
    values.push(post_mode);
  }
  if (error_code) {
    clauses.push('error_code = ?');
    values.push(error_code);
  }
  if (search) {
    clauses.push('(video_path LIKE ? OR caption LIKE ? OR error LIKE ? OR error_code LIKE ? OR id LIKE ?)');
    const q = `%${search}%`;
    values.push(q, q, q, q, q);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit, offset);

  const jobs = db.prepare(`
    SELECT * FROM jobs ${where}
    ORDER BY COALESCE(scheduled_at, created_at) DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values);

  const countValues = values.slice(0, -2);
  const total = db.prepare(`SELECT COUNT(*) as c FROM jobs ${where}`).get(...countValues).c;

  return { jobs, total };
}

function countActiveJobsForCampaign(campaignId) {
  if (!campaignId) return 0;
  const placeholders = CAMPAIGN_JOB_TERMINAL.map(() => '?').join(', ');
  return db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE campaign_id = ? AND status NOT IN (${placeholders})
  `).get(campaignId, ...CAMPAIGN_JOB_TERMINAL).c;
}

function getPostedVideoPathsForCampaign(campaignId) {
  return db.prepare(`
    SELECT DISTINCT video_path FROM jobs
    WHERE campaign_id = ? AND status = 'done'
  `).all(campaignId).map((r) => r.video_path);
}

function cancelPendingJobsForCampaign(campaignId, reason = 'Campaign cancelled') {
  const pending = db.prepare(`
    SELECT id FROM jobs WHERE campaign_id = ? AND status = 'pending'
  `).all(campaignId);
  const ts = now();
  for (const row of pending) {
    updateJob(row.id, {
      status: 'failed',
      error: reason,
      error_code: 'CAMPAIGN_CANCELLED',
      finished_at: ts,
    });
    addJobEvent(row.id, {
      step: 'queue',
      level: 'warn',
      message: reason,
    });
  }
  return pending.length;
}

function refreshCampaignStatus(campaignId) {
  if (!campaignId) return null;
  const campaign = db.prepare('SELECT id, status FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || ['draft', 'cancelled'].includes(campaign.status)) {
    return campaign?.status || null;
  }

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status NOT IN ('done', 'failed', 'need_manual_check', 'ready_manual') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status IN ('failed', 'need_manual_check') THEN 1 ELSE 0 END) AS failed
    FROM jobs WHERE campaign_id = ?
  `).get(campaignId);

  const active = row?.active || 0;
  const done = row?.done || 0;
  const failed = row?.failed || 0;
  let newStatus = campaign.status;

  if (active > 0) {
    const ts = now();
    const inFlightPlaceholders = NON_TERMINAL_ACTIVE.map(() => '?').join(', ');
    const inFlight = db.prepare(`
      SELECT COUNT(*) AS c FROM jobs
      WHERE campaign_id = ? AND status IN (${inFlightPlaceholders})
    `).get(campaignId, ...NON_TERMINAL_ACTIVE).c;

    const duePending = db.prepare(`
      SELECT COUNT(*) AS c FROM jobs
      WHERE campaign_id = ? AND status = 'pending'
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
    `).get(campaignId, ts).c;

    if (inFlight > 0 || duePending > 0) {
      newStatus = 'running';
    } else {
      const futurePending = db.prepare(`
        SELECT COUNT(*) AS c FROM jobs
        WHERE campaign_id = ? AND status = 'pending'
          AND scheduled_at IS NOT NULL AND scheduled_at > ?
      `).get(campaignId, ts).c;
      newStatus = futurePending > 0 ? 'scheduled' : 'running';
    }
  } else if (done === 0 && failed > 0) {
    newStatus = 'failed';
  } else if (done > 0) {
    newStatus = failed > 0 ? 'completed_with_errors' : 'completed';
  } else {
    newStatus = 'draft';
  }

  if (newStatus !== campaign.status) {
    db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, now(), campaignId);
  }
  return newStatus;
}

function recoverStaleLaunchingCampaigns(maxAgeMs = 60000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db.prepare(`
    SELECT id FROM campaigns
    WHERE status = 'launching' AND updated_at < ?
  `).all(cutoff);

  let recovered = 0;
  for (const row of stale) {
    if (countActiveJobsForCampaign(row.id) > 0) {
      refreshCampaignStatus(row.id);
    } else {
      db.prepare(`
        UPDATE campaigns SET status = 'draft', updated_at = ?
        WHERE id = ? AND status = 'launching'
      `).run(now(), row.id);
    }
    recovered += 1;
  }
  return recovered;
}

module.exports = {
  exec: (sql) => db.exec(sql),
  prepare: (sql) => db.prepare(sql),
  VALID_STATUSES,
  POST_MODES,
  CANCELLABLE_STATUSES,
  TERMINAL_STATUSES,
  NON_TERMINAL_ACTIVE,
  getLastPendingScheduleAnchor,
  touchDeviceLastPost,
  createJob,
  createJobsInTransaction,
  deletePendingJobsByIds,
  transaction,
  createEngageJob,
  normalizePostMode,
  getJob,
  getDevice,
  listJobs,
  listJobsFiltered,
  updateJob,
  updateJobIfActive,
  isDeviceBusy,
  getNextPendingJob,
  claimJob,
  acquireDeviceJob,
  recoverStaleBusyDevices,
  releaseDevice,
  touchDeviceHeartbeat,
  upsertDevice,
  setDeviceBusy,
  getIdleDevices,
  getStats,
  addJobEvent,
  listJobEvents,
  getJobDetail,
  requestJobCancel,
  isJobCancelRequested,
  countActiveJobsForCampaign,
  getPostedVideoPathsForCampaign,
  cancelPendingJobsForCampaign,
  refreshCampaignStatus,
  recoverStaleLaunchingCampaigns,
  CAMPAIGN_JOB_TERMINAL,
};
