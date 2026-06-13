/**
 * Integration: campaign launch persists jobs atomically with campaign_id.
 */
const fs = require('fs');
const path = require('path');
const campaigns = require('../campaigns');
const db = require('../db');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Minimal server helpers (mirror server.js batch path)
const schedule = require('../schedule');

function resolveVideoPath(video_path) {
  return path.join(__dirname, '..', video_path);
}

function prepareJobFromVideo(payload) {
  const fullPath = resolveVideoPath(payload.video_path);
  if (!fs.existsSync(fullPath)) {
    return { error: `Video file not found: ${payload.video_path}`, status: 400 };
  }
  return {
    record: {
      device_id: payload.device_id || null,
      video_path: payload.video_path,
      caption: payload.caption,
      post_mode: payload.post_mode || 'auto',
      tiktok_account: payload.tiktok_account || null,
      scheduled_at: schedule.parseScheduledAt(payload.scheduled_at),
      batch_id: payload.batch_id || null,
      sequence_index: payload.sequence_index ?? null,
      interval_after_sec: payload.interval_after_sec ?? null,
      campaign_id: payload.campaign_id || null,
    },
    event: { step: 'queue', level: 'info', message: 'test' },
    fullPath,
  };
}

function createJobsFromVideosBatch(payloads) {
  const preparedList = [];
  for (const payload of payloads) {
    const prepared = prepareJobFromVideo(payload);
    if (prepared.error) return prepared;
    preparedList.push(prepared);
  }
  try {
    const jobs = db.transaction(() => {
      const created = [];
      for (const prepared of preparedList) {
        const job = db.createJob(prepared.record);
        db.addJobEvent(job.id, prepared.event);
        created.push(job);
      }
      return created;
    })();
    return { jobs };
  } catch (err) {
    return { error: err.message, status: 500 };
  }
}

const c = campaigns.createCampaign({ name: `batch-${Date.now()}` });
const dir = path.join(__dirname, '..', 'videos', c.folder_slug);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'a.mp4'), 'a');
fs.writeFileSync(path.join(dir, 'b.mp4'), 'b');
campaigns.syncCampaignVideos(c.id);
campaigns.bulkUpdateCaptions(c.id, { mode: 'replace', text: 'cap' });

const before = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
const result = campaigns.launchCampaign(c.id, { immediate: true, interval_minutes: 1 }, {
  createJobsBatch: createJobsFromVideosBatch,
});
assert(result.jobs.length === 2, '2 jobs created');
assert(result.jobs.every((j) => j.campaign_id === c.id), 'jobs have campaign_id');
assert(result.jobs[0].scheduled_at === null, 'first job ASAP');

const after = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
assert(after === before + 2, 'exactly 2 jobs in DB');

// Rollback path: invalid video in batch
const bad = createJobsFromVideosBatch([
  {
    video_path: 'videos/missing.mp4',
    caption: 'x',
    post_mode: 'auto',
    campaign_id: c.id,
  },
]);
assert(bad.error, 'invalid batch returns error');
const afterBad = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
assert(afterBad === after, 'no partial jobs on validation fail');

for (const j of result.jobs) {
  db.deletePendingJobsByIds([j.id]);
}
campaigns.deleteCampaign(c.id);
fs.rmSync(dir, { recursive: true, force: true });
console.log('campaign batch integration PASS');
