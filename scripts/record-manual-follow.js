/**
 * Theo dõi thao tác tay — tự ghi khi màn hình TikTok đổi.
 * Dừng: Ctrl+C
 */
const fs = require('fs');
const path = require('path');

const adb = require('../adb');
const ui = require('../ui-state');
const screen = require('../screen');

const DEVICE = process.argv[2] || process.env.ADB_DEVICE || null;
const POLL_MS = parseInt(process.argv[3] || '2500', 10);
const LOG_FILE = path.join(__dirname, '..', 'logs', 'manual-steps.jsonl');
const SESSION = new Date().toISOString().replace(/[:.]/g, '-');

let lastKey = '';
let stepNo = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function screenKey(detected, xml) {
  const hasPost = xml && /Đăng|Post/i.test(xml) ? 'post' : '';
  const hasNext = xml && /Tiếp|Next/i.test(xml) ? 'next' : '';
  return `${detected}|${hasPost}|${hasNext}`;
}

async function capture(deviceId, profile, reason) {
  stepNo += 1;
  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, '-');
  const label = `follow-${String(stepNo).padStart(2, '0')}-${reason}`;

  await adb.ensureDeviceAwake(deviceId, profile, { forceUnlock: false });
  const shot = await adb.screenshot(deviceId, label);
  const { content: xml, path: xmlPath } = await adb.dumpUi(deviceId, label);
  const detected = xml ? ui.detectScreen(xml, profile) : 'no_xml';

  const entry = {
    ts,
    session: SESSION,
    step_no: stepNo,
    device_id: deviceId,
    step: reason,
    screen: detected,
    screenshot: shot,
    ui_dump: xmlPath,
    screen_size: `${profile.width}x${profile.height}`,
    auto: true,
  };

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);

  console.log(`[${new Date().toLocaleTimeString('vi-VN')}] #${stepNo} ${detected} — ${reason}`);
  if (shot) console.log(`  📷 ${path.basename(shot)}`);
  return detected;
}

async function main() {
  const devices = adb.getDevices();
  if (!devices.length) {
    console.error('Không có thiết bị ADB.');
    process.exit(1);
  }
  const deviceId = DEVICE || devices[0].id;
  const profile = screen.getScreenSize(deviceId);

  console.log('=== THEO DÕI THAO TÁC TAY ===');
  console.log(`Thiết bị: ${deviceId}`);
  console.log(`Session: ${SESSION}`);
  console.log(`Poll: ${POLL_MS}ms · Log: ${LOG_FILE}`);
  console.log('Làm đăng video trên máy — script tự ghi khi màn hình đổi.');
  console.log('Dừng: Ctrl+C\n');

  await capture(deviceId, profile, '00-bat-dau-theo-doi');

  while (true) {
    try {
      const { content: xml } = await adb.dumpUi(deviceId, 'follow_poll');
      const detected = xml ? ui.detectScreen(xml, profile) : 'no_xml';
      const key = screenKey(detected, xml);
      if (key !== lastKey) {
        const reason = lastKey ? `chuyen-${detected}` : detected;
        await capture(deviceId, profile, reason);
        lastKey = key;
      }
    } catch (err) {
      console.warn('Poll lỗi:', err.message);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
