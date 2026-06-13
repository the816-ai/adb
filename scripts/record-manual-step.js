/**
 * Ghi 1 bước thao tác tay (screenshot + UI dump + nhận diện màn hình).
 *
 * Cách dùng:
 *   1. Làm 1 bước trên điện thoại (vd: mở TikTok, share video, bấm Đăng...)
 *   2. Chạy: node scripts/record-manual-step.js "mô tả bước"
 *   3. Lặp lại cho từng bước
 *
 * File lưu: screenshots/manual-session/ + logs/manual-steps.jsonl
 */
const fs = require('fs');
const path = require('path');

const adb = require('../adb');
const ui = require('../ui-state');
const screen = require('../screen');

const STEP = process.argv.slice(2).join(' ').trim() || 'step';
const DEVICE = process.argv[3] || process.env.ADB_DEVICE || null;

const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'manual-session');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'manual-steps.jsonl');

function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'step';
}

async function main() {
  const devices = adb.getDevices();
  if (!devices.length) {
    console.error('Không có thiết bị ADB. Cắm máy và bật USB debugging.');
    process.exit(1);
  }
  const deviceId = DEVICE || devices[0].id;
  const profile = screen.getScreenSize(deviceId);
  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, '-');
  const label = slug(STEP);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  console.log(`Thiết bị: ${deviceId}`);
  console.log(`Bước: ${STEP}`);
  console.log('Đang chụp...');

  await adb.ensureDeviceAwake(deviceId, profile, { forceUnlock: true });

  const shot = await adb.screenshot(deviceId, `manual_${label}_${stamp}`);
  const { content: xml, path: xmlPath } = await adb.dumpUi(deviceId, `manual_${label}_${stamp}`);
  const detected = xml ? ui.detectScreen(xml, profile) : 'no_xml';

  const entry = {
    ts,
    device_id: deviceId,
    step: STEP,
    screen: detected,
    screenshot: shot,
    ui_dump: xmlPath,
    screen_size: `${profile.width}x${profile.height}`,
  };

  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);

  console.log('\n=== ĐÃ GHI ===');
  console.log(`Màn hình: ${detected}`);
  if (shot) console.log(`Screenshot: ${shot}`);
  if (xmlPath) console.log(`UI dump: ${xmlPath}`);
  console.log(`Log: ${LOG_FILE}`);
  console.log('\nLàm bước tiếp theo trên máy, rồi chạy lại lệnh với mô tả mới.');
}

main().catch((err) => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
