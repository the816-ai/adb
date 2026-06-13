const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const schedule = require('./schedule');

const VIDEOS_ROOT = path.join(__dirname, 'videos');
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;

const CAMPAIGN_STATUSES = new Set([
  'draft', 'scheduled', 'running', 'launching',
  'completed', 'completed_with_errors', 'failed', 'cancelled',
]);

const BULK_CAPTION_MODES = new Set(['replace', 'append', 'from_filename', 'copy_title']);

function now() {
  return new Date().toISOString();
}

function normalizeEnabled(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  const s = String(value).toLowerCase();
  return (s === '1' || s === 'true' || s === 'yes') ? 1 : 0;
}

function validateCampaignFields(fields = {}) {
  const out = {};
  if (fields.name !== undefined) out.name = String(fields.name).trim();
  if (fields.description !== undefined) {
    out.description = fields.description ? String(fields.description).trim() : null;
  }
  if (fields.default_post_mode !== undefined) {
    out.default_post_mode = db.normalizePostMode(fields.default_post_mode);
  }
  if (fields.default_device_id !== undefined) out.default_device_id = fields.default_device_id || null;
  if (fields.default_tiktok_account !== undefined) {
    out.default_tiktok_account = fields.default_tiktok_account
      ? String(fields.default_tiktok_account).trim()
      : null;
  }
  if (fields.scheduled_start_at !== undefined) {
    out.scheduled_start_at = fields.scheduled_start_at
      ? schedule.parseScheduledAt(fields.scheduled_start_at)
      : null;
  }
  if (fields.interval_minutes !== undefined) {
    const min = schedule.parseIntervalMinutes(fields.interval_minutes, 0);
    if (min < 0) throw Object.assign(new Error('interval_minutes phải ≥ 0'), { status: 400 });
    out.interval_minutes = min;
  }
  if (fields.interval_min_max !== undefined) {
    const max = fields.interval_min_max == null
      ? null
      : schedule.parseIntervalMinutes(fields.interval_min_max, 0);
    if (max != null && max < 0) {
      throw Object.assign(new Error('interval_min_max phải ≥ 0'), { status: 400 });
    }
    out.interval_min_max = max;
  }
  if (fields.launch_batch_id !== undefined) out.launch_batch_id = fields.launch_batch_id || null;
  if (fields.status !== undefined) {
    const status = String(fields.status);
    if (!CAMPAIGN_STATUSES.has(status)) {
      throw Object.assign(new Error(`status không hợp lệ: ${status}`), { status: 400 });
    }
    out.status = status;
  }
  return out;
}

function assertCampaignStatusTransition(current, next) {
  if (!next || current === next) return;
  const allowed = {
    draft: new Set(['scheduled', 'running', 'launching', 'cancelled']),
    scheduled: new Set(['running', 'launching', 'cancelled', 'completed', 'completed_with_errors', 'failed']),
    running: new Set(['scheduled', 'completed', 'completed_with_errors', 'failed', 'cancelled']),
    launching: new Set(['scheduled', 'running', 'failed', 'draft']),
    completed: new Set(['draft', 'running', 'scheduled']),
    completed_with_errors: new Set(['draft', 'running', 'scheduled']),
    failed: new Set(['draft', 'running', 'scheduled']),
    cancelled: new Set(['draft']),
  };
  const ok = allowed[current]?.has(next);
  if (!ok) {
    throw Object.assign(
      new Error(`Không thể chuyển trạng thái ${current} → ${next}`),
      { status: 409, code: 'INVALID_STATUS_TRANSITION' }
    );
  }
}

function applyLaunchState(campaignId, {
  batchId, immediate, startAt, intervalMin, intervalMax, firstScheduled,
}) {
  const status = !immediate && startAt && new Date(startAt) > new Date() ? 'scheduled' : 'running';
  db.prepare(`
    UPDATE campaigns
    SET status = ?, launch_batch_id = ?, scheduled_start_at = ?,
        interval_minutes = ?, interval_min_max = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    batchId,
    firstScheduled,
    intervalMin,
    intervalMax > intervalMin ? intervalMax : null,
    now(),
    campaignId
  );
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `folder-${Date.now()}`;
}

function uniqueFolderSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 0;
  while (getCampaignBySlug(slug)) {
    n += 1;
    slug = `${base.slice(0, 40)}-${Date.now().toString(36)}${n > 1 ? n : ''}`;
  }
  return slug;
}

function folderAbs(folderSlug) {
  const rel = String(folderSlug || '').replace(/^videos[\\/]/, '').replace(/\\/g, '/');
  return path.join(VIDEOS_ROOT, rel);
}

function applySpin(text) {
  if (!text) return '';
  return String(text).replace(/\{([^{}]+)\}/g, (_, inner) => {
    const opts = inner.split('|').map((s) => s.trim()).filter(Boolean);
    if (!opts.length) return '';
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder_slug TEXT NOT NULL UNIQUE,
      description TEXT,
      default_post_mode TEXT NOT NULL DEFAULT 'auto',
      default_device_id TEXT,
      default_tiktok_account TEXT,
      scheduled_start_at TEXT,
      interval_minutes INTEGER NOT NULL DEFAULT 0,
      interval_min_max INTEGER,
      launch_batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_videos (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      video_path TEXT NOT NULL,
      video_name TEXT NOT NULL,
      title TEXT,
      caption TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      file_size INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, video_path),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_videos_campaign ON campaign_videos(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
  `);
}

initSchema();

function listCampaigns() {
  recoverStaleLaunchingCampaigns();
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_videos v WHERE v.campaign_id = c.id) AS video_count,
      (SELECT COUNT(*) FROM campaign_videos v WHERE v.campaign_id = c.id AND v.enabled = 1) AS enabled_count
    FROM campaigns c
    ORDER BY c.updated_at DESC
  `).all();
}

function getCampaign(id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}

function getCampaignBySlug(slug) {
  return db.prepare('SELECT * FROM campaigns WHERE folder_slug = ?').get(slug);
}

function scanFolderVideos(folderSlug) {
  const dir = folderAbs(folderSlug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => VIDEO_EXT.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return {
        video_name: f,
        video_path: `videos/${folderSlug}/${f}`,
        file_size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.video_name.localeCompare(b.video_name, 'vi'));
}

function syncCampaignVideos(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;

  const disk = scanFolderVideos(campaign.folder_slug);
  const existing = db.prepare('SELECT * FROM campaign_videos WHERE campaign_id = ? ORDER BY sort_order ASC, video_name ASC')
    .all(campaignId);
  const byPath = new Map(existing.map((r) => [r.video_path, r]));
  const byName = new Map(existing.map((r) => [r.video_name, r]));
  const ts = now();

  const runSync = () => {
    const consumedIds = new Set();
    let maxOrder = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), -1);
    let nextNewOrder = maxOrder + 1;

    for (const file of disk) {
      let prev = byPath.get(file.video_path);
      if (!prev) {
        const byNameMatch = byName.get(file.video_name);
        if (byNameMatch && !consumedIds.has(byNameMatch.id)) {
          prev = byNameMatch;
        }
      }

      if (prev) {
        consumedIds.add(prev.id);
        db.prepare(`
          UPDATE campaign_videos
          SET video_path = ?, video_name = ?, file_size = ?, updated_at = ?
          WHERE id = ?
        `).run(file.video_path, file.video_name, file.file_size, ts, prev.id);
        byPath.delete(prev.video_path);
        byName.delete(prev.video_name);
      } else {
        const stem = path.parse(file.video_name).name;
        const sortOrder = nextNewOrder;
        nextNewOrder += 1;
        db.prepare(`
          INSERT INTO campaign_videos (
            id, campaign_id, video_path, video_name, title, caption,
            sort_order, enabled, file_size, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          uuidv4(),
          campaignId,
          file.video_path,
          file.video_name,
          stem,
          '',
          sortOrder,
          file.file_size,
          ts,
          ts
        );
      }
    }

    for (const stale of byPath.values()) {
      if (!consumedIds.has(stale.id)) {
        db.prepare('DELETE FROM campaign_videos WHERE id = ?').run(stale.id);
      }
    }

    db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(ts, campaignId);
  };

  db.transaction(runSync)();
  return listCampaignVideos(campaignId);
}

function listCampaignVideos(campaignId) {
  return db.prepare(`
    SELECT * FROM campaign_videos
    WHERE campaign_id = ?
    ORDER BY sort_order ASC, video_name ASC
  `).all(campaignId);
}

function registerUploadedVideos(campaignId, uploadedFiles = []) {
  const campaign = getCampaign(campaignId);
  if (!campaign || !uploadedFiles.length) return listCampaignVideos(campaignId);

  const ts = now();
  const existing = listCampaignVideos(campaignId);
  let maxOrder = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), -1);

  const run = () => {
    for (const file of uploadedFiles) {
      const videoPath = file.video_path;
      const videoName = file.video_name || path.basename(videoPath);
      const fileSize = file.file_size ?? null;
      const prev = db.prepare(`
        SELECT * FROM campaign_videos WHERE campaign_id = ? AND video_path = ?
      `).get(campaignId, videoPath);

      if (prev) {
        db.prepare(`
          UPDATE campaign_videos
          SET video_name = ?, file_size = ?, updated_at = ?
          WHERE id = ?
        `).run(videoName, fileSize, ts, prev.id);
      } else {
        maxOrder += 1;
        const stem = path.parse(videoName).name;
        db.prepare(`
          INSERT INTO campaign_videos (
            id, campaign_id, video_path, video_name, title, caption,
            sort_order, enabled, file_size, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          uuidv4(),
          campaignId,
          videoPath,
          videoName,
          stem,
          '',
          maxOrder,
          fileSize,
          ts,
          ts
        );
      }
    }
    db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(ts, campaignId);
  };

  db.transaction(run)();
  return listCampaignVideos(campaignId);
}

function createCampaign({ name, description, post_mode, device_id, tiktok_account }) {
  const slug = uniqueFolderSlug(name);

  const id = uuidv4();
  const ts = now();
  try {
    db.prepare(`
      INSERT INTO campaigns (
        id, name, folder_slug, description, default_post_mode,
        default_device_id, default_tiktok_account, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      id,
      String(name).trim(),
      slug,
      description ? String(description).trim() : null,
      db.normalizePostMode(post_mode),
      device_id || null,
      tiktok_account ? String(tiktok_account).trim() : null,
      ts,
      ts
    );
    fs.mkdirSync(folderAbs(slug), { recursive: true });
    syncCampaignVideos(id);
    return getCampaign(id);
  } catch (err) {
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    throw err;
  }
}

function updateCampaign(id, fields = {}) {
  const current = getCampaign(id);
  if (!current) return null;

  let validated;
  try {
    validated = validateCampaignFields(fields);
  } catch (err) {
    throw err;
  }

  if (validated.status) {
    assertCampaignStatusTransition(current.status, validated.status);
    if (['draft', 'cancelled'].includes(validated.status) && db.countActiveJobsForCampaign(id) > 0) {
      throw Object.assign(
        new Error('Không thể đổi trạng thái khi còn job đang chạy'),
        { status: 409, code: 'CAMPAIGN_ACTIVE' }
      );
    }
  }

  const allowed = Object.keys(validated);
  if (!allowed.length) return current;

  const sets = allowed.map((k) => `${k} = ?`);
  const values = allowed.map((k) => validated[k]);
  sets.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCampaign(id);
}

function deleteCampaign(id) {
  const campaign = getCampaign(id);
  if (!campaign) return false;
  db.cancelPendingJobsForCampaign(id, 'Chiến dịch đã xóa');
  db.prepare('DELETE FROM campaign_videos WHERE campaign_id = ?').run(id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  return true;
}

function updateCampaignVideo(videoId, fields = {}) {
  const allowed = ['title', 'caption', 'enabled', 'sort_order'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) {
    return db.prepare('SELECT * FROM campaign_videos WHERE id = ?').get(videoId);
  }
  sets.push('updated_at = ?');
  values.push(now(), videoId);
  db.prepare(`UPDATE campaign_videos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM campaign_videos WHERE id = ?').get(videoId);
}

function bulkUpdateCaptions(campaignId, { mode, text, use_spin = true }) {
  if (!BULK_CAPTION_MODES.has(mode)) {
    throw Object.assign(new Error(`mode không hợp lệ: ${mode}`), { status: 400 });
  }
  const videos = listCampaignVideos(campaignId);
  const ts = now();
  let count = 0;

  for (const v of videos) {
    if (!v.enabled) continue;
    let caption = v.caption || '';
    if (mode === 'replace' && text != null) {
      caption = use_spin ? applySpin(String(text)) : String(text);
    } else if (mode === 'append' && text) {
      const chunk = use_spin ? applySpin(String(text)) : String(text);
      caption = caption ? `${caption} ${chunk}`.trim() : chunk;
    } else if (mode === 'from_filename') {
      caption = path.parse(v.video_name).name.replace(/[_-]+/g, ' ');
    } else if (mode === 'copy_title' && v.title) {
      caption = v.title;
    }
    db.prepare('UPDATE campaign_videos SET caption = ?, updated_at = ? WHERE id = ?').run(caption, ts, v.id);
    count += 1;
  }

  db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(ts, campaignId);
  return { updated: count };
}

function saveCampaignVideos(campaignId, items = []) {
  for (const item of items) {
    if (!item.id) continue;
    const row = db.prepare('SELECT campaign_id FROM campaign_videos WHERE id = ?').get(item.id);
    if (!row || row.campaign_id !== campaignId) {
      throw Object.assign(
        new Error(`Video ${item.id} không thuộc chiến dịch này`),
        { status: 400, code: 'VIDEO_OWNERSHIP' }
      );
    }
    updateCampaignVideo(item.id, {
      title: item.title,
      caption: item.caption,
      enabled: normalizeEnabled(item.enabled),
      sort_order: item.sort_order,
    });
  }
  db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(now(), campaignId);
  return listCampaignVideos(campaignId);
}

function resolveLaunchInterval(campaign, override = {}) {
  const min = schedule.parseIntervalMinutes(
    override.interval_minutes ?? campaign.interval_minutes ?? process.env.DEFAULT_POST_INTERVAL_MIN,
    0
  );
  const maxRaw = override.interval_min_max ?? campaign.interval_min_max;
  const max = maxRaw
    ? schedule.parseIntervalMinutes(maxRaw, min)
    : min;
  return { min, max: Math.max(min, max) };
}

function pickIntervalMinutes(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function buildStaggeredSlots({ startAt, count, intervalMin, intervalMax }) {
  const slots = [];
  let effMin = intervalMin;
  let effMax = intervalMax;
  if (count > 1 && effMin <= 0) {
    effMin = 1;
    effMax = Math.max(effMax, 1);
  }
  let cursor = startAt ? new Date(startAt).getTime() : Date.now();
  for (let i = 0; i < count; i += 1) {
    slots.push(new Date(cursor).toISOString());
    if (i < count - 1) {
      const gapMin = pickIntervalMinutes(effMin, effMax);
      cursor += gapMin * 60 * 1000;
    }
  }
  return slots;
}

function recoverStaleLaunchingCampaigns(maxAgeMs = 60000) {
  return db.recoverStaleLaunchingCampaigns(maxAgeMs);
}

function assertCanLaunch(campaignId) {
  recoverStaleLaunchingCampaigns();

  if (db.countActiveJobsForCampaign(campaignId) > 0) {
    return {
      error: 'Chiến dịch đang có job chưa hoàn tất. Đợi xong hoặc hủy job trước khi launch lại.',
      status: 409,
      code: 'CAMPAIGN_ACTIVE',
    };
  }
  const campaign = getCampaign(campaignId);
  if (campaign?.status === 'launching') {
    return {
      error: 'Chiến dịch đang được launch — thử lại sau vài giây.',
      status: 409,
      code: 'LAUNCH_IN_PROGRESS',
    };
  }
  return null;
}

function launchCampaign(campaignId, options = {}, hooks = {}) {
  const createJobsBatch = hooks.createJobsBatch;
  if (typeof createJobsBatch !== 'function') {
    return { error: 'createJobsBatch hook is required', status: 500 };
  }

  const blocked = assertCanLaunch(campaignId);
  if (blocked) return blocked;

  const campaign = getCampaign(campaignId);
  if (!campaign) {
    return { error: 'Campaign not found', status: 404 };
  }

  const immediate = options.immediate === true;
  const skipPosted = options.skip_posted !== false;

  syncCampaignVideos(campaignId);
  let videos = listCampaignVideos(campaignId).filter((v) => v.enabled);

  if (skipPosted) {
    const posted = new Set(db.getPostedVideoPathsForCampaign(campaignId));
    videos = videos.filter((v) => !posted.has(v.video_path));
  }

  if (!videos.length) {
    return {
      error: skipPosted
        ? 'Tất cả video enabled đã đăng thành công — không còn gì để launch'
        : 'Không có video enabled trong thư mục',
      status: 400,
      code: 'NO_VIDEOS_TO_LAUNCH',
    };
  }

  const postMode = db.normalizePostMode(options.post_mode || campaign.default_post_mode);
  const deviceId = options.device_id ?? campaign.default_device_id ?? null;
  const tiktokAccount = options.tiktok_account ?? campaign.default_tiktok_account ?? null;

  for (const v of videos) {
    if (postMode === db.POST_MODES.AUTO && !String(v.caption || '').trim()) {
      return { error: `Video "${v.video_name}" thiếu caption (bắt buộc auto)`, status: 400 };
    }
    const full = path.join(__dirname, v.video_path);
    if (!fs.existsSync(full)) {
      return { error: `File không tồn tại: ${v.video_path}`, status: 400 };
    }
  }

  const scheduleErr = schedule.validateScheduleInput({
    scheduled_at: immediate ? null : options.scheduled_at,
    interval_minutes: options.interval_minutes ?? campaign.interval_minutes,
  });
  if (scheduleErr) {
    return { error: scheduleErr.error, status: 400 };
  }

  const { min: intervalMin, max: intervalMax } = resolveLaunchInterval(campaign, options);
  const startAt = immediate ? null : schedule.parseScheduledAt(options.scheduled_at);
  const slots = buildStaggeredSlots({
    startAt,
    count: videos.length,
    intervalMin,
    intervalMax,
  });

  const batchId = schedule.newBatchId();
  const payloads = [];

  for (let i = 0; i < videos.length; i += 1) {
    const v = videos[i];
    const gapMs = i > 0
      ? new Date(slots[i]).getTime() - new Date(slots[i - 1]).getTime()
      : 0;
    const intervalAfterSec = gapMs > 0 ? Math.round(gapMs / 1000) : null;
    const scheduledAt = immediate && i === 0 ? null : slots[i];

    payloads.push({
      device_id: deviceId,
      video_path: v.video_path,
      caption: applySpin(String(v.caption || '').trim()) || '(đăng thủ công)',
      post_mode: postMode,
      tiktok_account: tiktokAccount,
      scheduled_at: scheduledAt,
      interval_after_sec: intervalAfterSec,
      batch_id: batchId,
      sequence_index: i,
      campaign_id: campaignId,
      source: 'campaign',
    });
  }

  const launchMeta = {
    batchId,
    immediate,
    startAt,
    intervalMin,
    intervalMax,
    firstScheduled: slots[0],
  };

  const batchResult = createJobsBatch(payloads, {
    campaignId,
    launchMeta,
    applyLaunchState: (jobs) => applyLaunchState(campaignId, {
      ...launchMeta,
      firstScheduled: jobs[0]?.scheduled_at || launchMeta.firstScheduled,
    }),
  });

  if (batchResult.error) {
    db.prepare(`
      UPDATE campaigns SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'launching'
    `).run(campaign.status, now(), campaignId);
    return batchResult;
  }

  const jobs = batchResult.jobs || [];
  return {
    batch_id: batchId,
    jobs,
    count: jobs.length,
    slots,
    campaign_id: campaignId,
    skipped_posted: skipPosted,
  };
}

function getCampaignDetail(id, { sync = true } = {}) {
  recoverStaleLaunchingCampaigns();
  const campaign = getCampaign(id);
  if (!campaign) return null;
  const videos = sync ? syncCampaignVideos(id) : listCampaignVideos(id);
  const job_stats = {
    active: db.countActiveJobsForCampaign(id),
    posted_paths: db.getPostedVideoPathsForCampaign(id),
  };
  return { campaign, videos, job_stats };
}

function refreshCampaignStatus(campaignId) {
  return db.refreshCampaignStatus(campaignId);
}

module.exports = {
  VIDEOS_ROOT,
  slugify,
  applySpin,
  listCampaigns,
  getCampaign,
  getCampaignDetail,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  syncCampaignVideos,
  registerUploadedVideos,
  uniqueFolderSlug,
  listCampaignVideos,
  updateCampaignVideo,
  saveCampaignVideos,
  bulkUpdateCaptions,
  launchCampaign,
  buildStaggeredSlots,
  scanFolderVideos,
  refreshCampaignStatus,
  recoverStaleLaunchingCampaigns,
  assertCanLaunch,
  CAMPAIGN_STATUSES,
};
