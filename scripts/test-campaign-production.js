/**
 * Production guards: duplicate launch block, atomic batch, skip posted.
 */
const fs = require('fs');
const path = require('path');
const campaigns = require('../campaigns');
const db = require('../db');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function prepareJob(payload) {
  const full = path.join(__dirname, '..', payload.video_path);
  if (!fs.existsSync(full)) return { error: 'not found', status: 400 };
  return {
    record: {
      device_id: null,
      video_path: payload.video_path,
      caption: payload.caption,
      post_mode: 'auto',
      tiktok_account: null,
      scheduled_at: payload.scheduled_at ?? null,
      batch_id: payload.batch_id || null,
      sequence_index: payload.sequence_index ?? null,
      interval_after_sec: payload.interval_after_sec ?? null,
      campaign_id: payload.campaign_id || null,
    },
    event: { step: 'queue', level: 'info', message: 'test' },
    fullPath: full,
  };
}

function createJobsBatch(payloads, hooks = {}) {
  const prepared = [];
  for (const payload of payloads) {
    const p = prepareJob(payload);
    if (p.error) return p;
    prepared.push(p);
  }
  try {
    const jobs = db.transaction(() => {
      if (hooks.campaignId) {
        if (db.countActiveJobsForCampaign(hooks.campaignId) > 0) {
          throw Object.assign(new Error('CAMPAIGN_ACTIVE'), { code: 'CAMPAIGN_ACTIVE' });
        }
        db.prepare(`UPDATE campaigns SET status = 'launching', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), hooks.campaignId);
      }
      const created = [];
      for (const p of prepared) {
        const job = db.createJob(p.record);
        db.addJobEvent(job.id, p.event);
        created.push(job);
      }
      if (typeof hooks.applyLaunchState === 'function') {
        hooks.applyLaunchState(created);
      }
      return created;
    })();
    return { jobs };
  } catch (err) {
    return { error: err.message, status: 409, code: err.code };
  }
}

const c = campaigns.createCampaign({ name: `prod-${Date.now()}` });
const videoDir = path.join(__dirname, '..', 'videos', c.folder_slug);
fs.writeFileSync(path.join(videoDir, 'a.mp4'), 'a');
fs.writeFileSync(path.join(videoDir, 'b.mp4'), 'b');
campaigns.syncCampaignVideos(c.id);
campaigns.bulkUpdateCaptions(c.id, { mode: 'replace', text: 'cap' });

const launch1 = campaigns.launchCampaign(c.id, { immediate: true, interval_minutes: 5 }, { createJobsBatch });
assert(launch1.count === 2, `first launch creates 2 jobs, got ${launch1.count} err=${launch1.error}`);
assert(launch1.jobs.every((j) => j.campaign_id === c.id), 'campaign_id set');

const launch2 = campaigns.launchCampaign(c.id, { immediate: true }, { createJobsBatch });
assert(launch2.code === 'CAMPAIGN_ACTIVE', `duplicate launch blocked, got ${launch2.code}`);

for (const j of launch1.jobs) {
  db.updateJob(j.id, { status: 'done', finished_at: new Date().toISOString() });
}
campaigns.refreshCampaignStatus(c.id);
const camp = campaigns.getCampaign(c.id);
assert(['completed', 'completed_with_errors', 'draft'].includes(camp.status), `status=${camp.status}`);

const launch3 = campaigns.launchCampaign(c.id, { immediate: true, skip_posted: true }, { createJobsBatch });
assert(launch3.code === 'NO_VIDEOS_TO_LAUNCH', 'skip posted leaves nothing');

for (const j of launch1.jobs) {
  db.deletePendingJobsByIds([j.id]);
}
campaigns.deleteCampaign(c.id);
fs.rmSync(videoDir, { recursive: true, force: true });
console.log('production campaign guards PASS');
