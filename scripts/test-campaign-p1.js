/**
 * P1 fixes: refreshCampaignStatus, sort_order preserve, launching TTL.
 */
const fs = require('fs');
const path = require('path');
const campaigns = require('../campaigns');
const db = require('../db');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- sort_order preserved after sync ---
const c = campaigns.createCampaign({ name: `order-${Date.now()}` });
const dir = path.join(__dirname, '..', 'videos', c.folder_slug);
fs.writeFileSync(path.join(dir, 'z-last.mp4'), 'z');
fs.writeFileSync(path.join(dir, 'a-first.mp4'), 'a');
campaigns.syncCampaignVideos(c.id);
let videos = campaigns.listCampaignVideos(c.id);
const byName = Object.fromEntries(videos.map((v) => [v.video_name, v]));

campaigns.saveCampaignVideos(c.id, [
  { id: byName['a-first.mp4'].id, sort_order: 10 },
  { id: byName['z-last.mp4'].id, sort_order: 0 },
]);
campaigns.syncCampaignVideos(c.id);
videos = campaigns.listCampaignVideos(c.id);
const orderMap = Object.fromEntries(videos.map((v) => [v.video_name, v.sort_order]));
assert(orderMap['z-last.mp4'] === 0, 'z-last sort_order preserved');
assert(orderMap['a-first.mp4'] === 10, 'a-first sort_order preserved');

// --- refreshCampaignStatus: running wins over scheduled ---
const launchC = campaigns.createCampaign({ name: `status-${Date.now()}` });
const launchDir = path.join(__dirname, '..', 'videos', launchC.folder_slug);
fs.writeFileSync(path.join(launchDir, 'v1.mp4'), '1');
fs.writeFileSync(path.join(launchDir, 'v2.mp4'), '2');
campaigns.syncCampaignVideos(launchC.id);
campaigns.bulkUpdateCaptions(launchC.id, { mode: 'replace', text: 'x' });

const batchId = require('../schedule').newBatchId();
const future = new Date(Date.now() + 3600000).toISOString();
const j1 = db.createJob({
  video_path: `videos/${launchC.folder_slug}/v1.mp4`,
  caption: 'x',
  post_mode: 'auto',
  campaign_id: launchC.id,
  batch_id: batchId,
  scheduled_at: null,
});
db.updateJob(j1.id, { status: 'posting' });
const j2 = db.createJob({
  video_path: `videos/${launchC.folder_slug}/v2.mp4`,
  caption: 'x',
  post_mode: 'auto',
  campaign_id: launchC.id,
  batch_id: batchId,
  scheduled_at: future,
});
db.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(launchC.id);

const st = campaigns.refreshCampaignStatus(launchC.id);
assert(st === 'running', `expected running when posting + future pending, got ${st}`);

db.updateJob(j1.id, { status: 'done', finished_at: new Date().toISOString() });
const st2 = campaigns.refreshCampaignStatus(launchC.id);
assert(st2 === 'scheduled', `expected scheduled when only future pending, got ${st2}`);

// --- launching TTL recovery ---
const stuck = campaigns.createCampaign({ name: `stuck-${Date.now()}` });
const stuckTs = new Date(Date.now() - 120000).toISOString();
db.prepare(`UPDATE campaigns SET status = 'launching', updated_at = ? WHERE id = ?`)
  .run(stuckTs, stuck.id);
const n = db.recoverStaleLaunchingCampaigns(60000);
assert(n >= 1, 'recovered stale launching');
const stuckAfter = campaigns.getCampaign(stuck.id);
assert(stuckAfter.status === 'draft', `stuck campaign reset to draft, got ${stuckAfter.status}`);

// cleanup
db.deletePendingJobsByIds([j1.id, j2.id]);
campaigns.deleteCampaign(c.id);
campaigns.deleteCampaign(launchC.id);
campaigns.deleteCampaign(stuck.id);
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(launchDir, { recursive: true, force: true });
fs.rmSync(path.join(__dirname, '..', 'videos', stuck.folder_slug), { recursive: true, force: true });
console.log('P1 campaign fixes PASS');
