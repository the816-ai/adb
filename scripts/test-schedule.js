#!/usr/bin/env node
/**
 * Kiểm tra hẹn giờ + khoảng cách giữa các bài.
 * node scripts/test-schedule.js
 */
require('../env').loadEnv();

const db = require('../db');
const schedule = require('../schedule');
const path = require('path');
const fs = require('fs');

const VIDEOS_DIR = path.join(__dirname, '..', 'videos');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cleanupTestJobs() {
  const Database = require('better-sqlite3');
  const dbPath = require('path').join(__dirname, '..', 'jobs', 'jobs.db');
  const sqlite = new Database(dbPath);
  sqlite.prepare(`
    UPDATE jobs SET status = 'failed', error = 'test cleanup', finished_at = ?
    WHERE caption LIKE '__schedule_test__%' AND status = 'pending'
  `).run(new Date().toISOString());
}

function pickVideo() {
  const files = fs.readdirSync(VIDEOS_DIR).filter((f) => /\.mp4$/i.test(f));
  assert(files.length > 0, 'Không có video trong videos/');
  return `videos/${files[0]}`;
}

function main() {
  console.log('Schedule integration test\n');
  cleanupTestJobs();

  const video = pickVideo();
  const deviceId = `TEST_SCHED_${Date.now()}`;
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();

  const futureJob = db.createJob({
    device_id: deviceId,
    video_path: video,
    caption: '__schedule_test__ future',
    scheduled_at: future,
  });
  const dueJob = db.createJob({
    device_id: deviceId,
    video_path: video,
    caption: '__schedule_test__ due',
    scheduled_at: past,
  });
  const asapJob = db.createJob({
    device_id: deviceId,
    video_path: video,
    caption: '__schedule_test__ asap',
  });

  const next = db.getNextPendingJob(deviceId);
  assert(next && next.id === asapJob.id, `ASAP job phải được claim trước (got ${next?.id})`);

  db.updateJob(asapJob.id, { status: 'failed', finished_at: new Date().toISOString() });
  const next2 = db.getNextPendingJob(deviceId);
  assert(next2 && next2.id === dueJob.id, `Due job phải claim sau ASAP (got ${next2?.id})`);

  db.updateJob(dueJob.id, { status: 'failed', finished_at: new Date().toISOString() });
  const next3 = db.getNextPendingJob(deviceId);
  assert(!next3 || next3.id !== futureJob.id, 'Future job vẫn bị chặn');

  const batchId = schedule.newBatchId();
  const slots = schedule.computeBatchSchedule({
    startAt: new Date(Date.now() + 30 * 60000).toISOString(),
    intervalMinutes: 15,
    count: 3,
  });
  assert(slots.length === 3, 'batch 3 slots');
  const gap = new Date(slots[1]).getTime() - new Date(slots[0]).getTime();
  assert(gap === 15 * 60 * 1000, `batch gap 15p (got ${gap / 60000}p)`);

  const stackDevice = `DEV_STACK_${Date.now()}`;
  const stack1 = db.createJob({
    video_path: video,
    caption: '__schedule_test__ stack1',
    device_id: stackDevice,
    scheduled_at: new Date(Date.now() + 60 * 60000).toISOString(),
  });
  const resolved = schedule.resolveScheduleForNewJob({
    interval_minutes: 20,
    device_id: stackDevice,
    getLastPendingAnchor: db.getLastPendingScheduleAnchor,
  });
  assert(resolved.scheduled_at, 'stack job phải có scheduled_at');
  const stackMs = new Date(resolved.scheduled_at).getTime() - new Date(stack1.scheduled_at).getTime();
  assert(Math.abs(stackMs - 20 * 60000) < 2000, `stack +20p (delta ${stackMs / 60000}p)`);

  const invalid = schedule.validateScheduleInput({ scheduled_at: 'not-a-date' });
  assert(invalid && invalid.error, 'validate reject bad datetime');

  cleanupTestJobs();
  console.log('\n✅ Tất cả kiểm tra schedule PASS');
}

try {
  main();
} catch (err) {
  console.error('\n❌ FAIL:', err.message);
  process.exit(1);
}
