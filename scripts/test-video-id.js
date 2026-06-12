const path = require('path');
const adb = require('../adb');

const deviceId = process.argv[2] || 'R94Y60BCW2T';
const remotePath = process.argv[3] || '/sdcard/TikTokAuto/ttjob_testjobid123.mp4';

async function main() {
  const all = await adb.queryVideoMedia(deviceId);
  console.log('all count:', all.length);

  const rows = await adb.queryVideoMedia(deviceId, "_data LIKE '%TikTokAuto%'");
  console.log('tiktokauto rows:', JSON.stringify(rows, null, 2));

  const dl = await adb.queryVideoMedia(deviceId, "_data LIKE '%Download%'");
  console.log('download rows:', dl.map((r) => r.path));

  const b1 = await adb.queryVideoMedia(deviceId, "bucket_display_name='TikTokAuto'");
  const b2 = await adb.queryVideoMedia(deviceId, "_data LIKE '%TikTokAuto%'");
  const b3 = await adb.queryVideoMedia(deviceId, `_data LIKE '%${path.posix.basename(remotePath)}%'`);
  console.log('bucket len', b1.length, 'path len', b2.length, 'base len', b3.length);

  const grid = await adb.getVideoGridIndex(deviceId, remotePath);
  console.log('grid:', JSON.stringify(grid, null, 2));

  const fp = await adb.getRemoteVideoFingerprint(deviceId, remotePath);
  console.log('fingerprint:', fp);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
