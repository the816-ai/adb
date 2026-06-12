const adb = require('../adb');

const deviceId = process.argv[2] || 'R94Y60BCW2T';
const remotePath = process.argv[3] || '/sdcard/TikTokAuto/ttjob_testjobid123.mp4';

async function main() {
  console.log('device:', deviceId);
  console.log('path:', remotePath);

  await adb.scanMedia(deviceId, remotePath);

  const info = await adb.getVideoMediaInfo(deviceId, remotePath, { forceRefresh: true });
  console.log('media info:', info);
  if (!info) {
    console.log('NO MEDIA — scan/index thất bại');
    process.exit(1);
  }

  const pkg = await adb.detectTikTokPackage(deviceId);
  console.log('pkg:', pkg);

  const result = await adb.shareVideoToTikTok(deviceId, info.id, pkg, remotePath);
  console.log('share result:', result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
