const fs = require('fs');
const path = require('path');
const campaigns = require('../campaigns');
const schedule = require('../schedule');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const slots = campaigns.buildStaggeredSlots({
  startAt: '2026-06-11T10:00:00.000Z',
  count: 3,
  intervalMin: 20,
  intervalMax: 20,
});
assert(slots.length === 3, '3 slots');
assert(slots[1] > slots[0], 'slot 2 after slot 1');

const spin = campaigns.applySpin('hello {a|b|c} world');
assert(/hello [abc] world/.test(spin), 'spin works');

const c = campaigns.createCampaign({ name: `test-${Date.now()}` });
assert(c.id, 'campaign created');

const videoDir = path.join(__dirname, '..', 'videos', c.folder_slug);
fs.mkdirSync(videoDir, { recursive: true });
fs.writeFileSync(path.join(videoDir, 'a.mp4'), 'a');
fs.writeFileSync(path.join(videoDir, 'b.mp4'), 'b');
campaigns.syncCampaignVideos(c.id);
campaigns.bulkUpdateCaptions(c.id, { mode: 'replace', text: '#fyp test' });

const launch = campaigns.launchCampaign(c.id, { immediate: true, interval_minutes: 5 }, {
  createJobsBatch: (payloads) => {
    assert(payloads.length >= 2, 'need 2+ videos for stagger test');
    assert(payloads[0].scheduled_at === null, 'immediate: job 0 ASAP (scheduled_at null)');
    assert(payloads[0].campaign_id === c.id, 'campaign_id on job payload');
    assert(payloads[1].scheduled_at != null, 'immediate: job 1+ has schedule');
    assert(payloads[1].interval_after_sec > 0, 'interval_after_sec reflects real gap');
    return { jobs: payloads.map((p, i) => ({ id: `mock-${i}`, ...p })) };
  },
});
assert(launch.batch_id, 'launch ok');
assert(launch.campaign_id === c.id, 'launch returns campaign_id');

campaigns.launchCampaign(c.id, {
  scheduled_at: new Date(Date.now() + 3600000).toISOString(),
  interval_minutes: 10,
}, {
  createJobsBatch: (payloads) => {
    assert(payloads[0].scheduled_at != null, 'scheduled: first job has slot');
    assert(payloads.every((p) => p.campaign_id === c.id), 'all payloads have campaign_id');
    return { jobs: payloads.map((p, i) => ({ id: `mock-s-${i}`, ...p })) };
  },
});

const err = schedule.validateScheduleInput({ scheduled_at: 'bad' });
assert(err && err.error, 'invalid schedule rejected');

campaigns.deleteCampaign(c.id);
fs.rmSync(videoDir, { recursive: true, force: true });
console.log('campaigns test PASS');
