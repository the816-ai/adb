const { v4: uuidv4 } = require('uuid');

function parseScheduledAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseIntervalMinutes(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseIntervalSeconds(minutes, fallbackSec = 0) {
  const min = parseIntervalMinutes(minutes, null);
  if (min === null) return fallbackSec;
  return min * 60;
}

function computeBatchSchedule({ startAt = null, intervalMinutes = 0, count }) {
  const baseMs = startAt ? new Date(startAt).getTime() : Date.now();
  const stepMs = parseIntervalMinutes(intervalMinutes, 0) * 60 * 1000;
  const slots = [];
  for (let i = 0; i < count; i += 1) {
    slots.push(new Date(baseMs + i * stepMs).toISOString());
  }
  return slots;
}

function isJobDue(scheduledAt, nowIso = new Date().toISOString()) {
  if (!scheduledAt) return true;
  return scheduledAt <= nowIso;
}

function formatScheduleMessage(scheduledAt, intervalAfterSec = null) {
  if (!scheduledAt) return null;
  const at = new Date(scheduledAt).toLocaleString('vi-VN');
  if (intervalAfterSec > 0) {
    const min = Math.round(intervalAfterSec / 60);
    return `Hẹn đăng ${at} · cách bài trước ${min} phút`;
  }
  return `Hẹn đăng ${at}`;
}

function resolveScheduleForNewJob({
  scheduled_at,
  interval_minutes,
  device_id,
  getLastPendingAnchor,
}) {
  const explicit = parseScheduledAt(scheduled_at);
  const intervalSec = parseIntervalSeconds(interval_minutes, 0);

  if (explicit) {
    return {
      scheduled_at: explicit,
      interval_after_sec: intervalSec > 0 ? intervalSec : null,
    };
  }

  if (intervalSec > 0 && typeof getLastPendingAnchor === 'function') {
    const anchor = getLastPendingAnchor(device_id || null);
    if (anchor) {
      const slot = new Date(new Date(anchor).getTime() + intervalSec * 1000).toISOString();
      return { scheduled_at: slot, interval_after_sec: intervalSec };
    }
  }

  return { scheduled_at: null, interval_after_sec: intervalSec > 0 ? intervalSec : null };
}

function validateScheduleInput({ scheduled_at, interval_minutes } = {}) {
  if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== '') {
    const parsed = parseScheduledAt(scheduled_at);
    if (!parsed) {
      return { error: 'scheduled_at không hợp lệ — dùng ISO datetime hoặc datetime-local' };
    }
  }
  const intervalMin = parseIntervalMinutes(interval_minutes, null);
  if (interval_minutes !== undefined && interval_minutes !== null && interval_minutes !== '' && intervalMin === null) {
    return { error: 'interval_minutes phải là số ≥ 0' };
  }
  return null;
}

function newBatchId() {
  return uuidv4();
}

module.exports = {
  parseScheduledAt,
  parseIntervalMinutes,
  parseIntervalSeconds,
  computeBatchSchedule,
  isJobDue,
  formatScheduleMessage,
  resolveScheduleForNewJob,
  validateScheduleInput,
  newBatchId,
};
