#!/usr/bin/env node
/**
 * QA regression — offline XML + live device (khi adb online).
 * Chạy: node qa/regression.js
 *        node qa/regression.js --live
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'screenshots');

const adb = require('../adb');
const ui = require('../ui-state');
const screen = require('../screen');
const accountSwitch = require('../account-switch');
const captionUtil = require('../caption');

const PROFILE = { width: 1080, height: 2340 };

const results = [];

function pass(id, msg, meta = {}) {
  results.push({ id, status: 'PASS', msg, ...meta });
  console.log(`  ✅ ${id}: ${msg}`);
}

function fail(id, msg, meta = {}) {
  results.push({ id, status: 'FAIL', msg, ...meta });
  console.log(`  ❌ ${id}: ${msg}`);
}

function skip(id, msg) {
  results.push({ id, status: 'SKIP', msg });
  console.log(`  ⏭️  ${id}: ${msg}`);
}

function loadXml(filename) {
  const p = path.join(SCREENSHOTS, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function testOfflineXml() {
  console.log('\n── Offline XML regression (artifact) ──');

  const postEdit = loadXml('R94Y60BCW2T_state_1781249160615.xml');
  if (postEdit) {
    const detected = ui.detectScreen(postEdit, PROFILE);
    const post = ui.findPostButton(postEdit, PROFILE);
    if (detected === 'post_edit' && post?.text === 'Đăng') {
      pass('UI-POST-01', 'Nhận màn post_edit + nút Đăng (zone dưới)');
    } else {
      fail('UI-POST-01', `post_edit=${detected}, post=${post?.text || 'null'}`);
    }
  } else {
    skip('UI-POST-01', 'Thiếu artifact post_edit');
  }

  const badCaption = loadXml('R94Y60BCW2T_verify_caption_1781249155414.xml');
  if (badCaption) {
    const hasEncoded = /%23fyp/i.test(badCaption);
    const postBtn = ui.findPostButton(badCaption, PROFILE);
    if (hasEncoded) {
      pass('CAP-01', 'Phát hiện caption lỗi %23 trong artifact (regression baseline)');
    } else {
      fail('CAP-01', 'Không thấy %23 trong artifact cũ');
    }
    if (postBtn) pass('UI-POST-02', 'Nút Đăng vẫn tìm được khi caption %23');
  }

  const profileXml = loadXml('R94Y60BCW2T_profile_upload_1781147588614.xml');
  if (profileXml) {
    const name = accountSwitch.readProfileDisplayName(profileXml, PROFILE);
    if (name && /nguyen anh/i.test(name)) {
      pass('ACC-01', `Đọc tên profile: "${name}"`);
    } else {
      fail('ACC-01', `Tên profile sai: ${name}`);
    }
    if (accountSwitch.accountsMatch(name, 'nguyen anh')) {
      pass('ACC-02', 'accountsMatch display name');
    }
    if (accountSwitch.accountsMatch('pun iu', 'pun')) {
      pass('ACC-03', 'accountsMatch partial nickname');
    }
  } else {
    skip('ACC-01', 'Thiếu artifact profile');
  }

  const shareChooser = loadXml('R94Y60BCW2T_share_chooser_1781249767533.xml');
  if (shareChooser) {
    const tiktok = ui.findInXml(shareChooser, 'share_to_tiktok') || ui.findInXml(shareChooser, 'gallery');
    if (tiktok || /tiktok|trill/i.test(shareChooser)) {
      pass('DEL-01', 'Share chooser artifact có TikTok');
    } else {
      fail('DEL-01', 'Share chooser không nhận TikTok');
    }
  }

  const { normalized } = captionUtil.splitForHumanTyping('#fyp #xuhuong upload auto');
  if (normalized.includes('#fyp') && !normalized.includes('%23')) {
    pass('CAP-02', `normalizeCaption: ${normalized}`);
  } else {
    fail('CAP-02', normalized);
  }
}

async function testDeviceConnectivity() {
  console.log('\n── Device connectivity ──');
  const devices = adb.getDevices();
  if (!devices.length) {
    fail('ADB-01', 'Không có thiết bị — cắm USB + bật USB debugging');
    return null;
  }
  pass('ADB-01', `Online: ${devices.join(', ')}`);
  return devices[0];
}

async function testLiveBasics(deviceId) {
  console.log(`\n── Live smoke (${deviceId}) ──`);

  const online = adb.isDeviceOnline(deviceId);
  if (!online) {
    fail('LIVE-01', 'isDeviceOnline=false');
    return;
  }
  pass('LIVE-01', 'Thiết bị phản hồi');

  screen.clearProfile(deviceId);
  const prof = screen.getScreenSize(deviceId);
  pass('LIVE-02', `Màn hình ${prof.width}x${prof.height}`);

  await adb.wakeDevice(deviceId);
  await adb.keepScreenOn(deviceId, true);

  const { content: xml } = await adb.dumpUi(deviceId, 'qa_live');
  if (!xml || !adb.isTikTokUiXml(xml)) {
    fail('LIVE-03', 'UI dump không phải TikTok — mở TikTok trên máy rồi chạy lại');
    return;
  }
  pass('LIVE-03', 'TikTok foreground OK');

  const detected = ui.detectScreen(xml, prof);
  pass('LIVE-04', `Màn hiện tại: ${detected}`);

  await ui.tapElement(deviceId, 'profile_tab', prof, {
    label: 'Hồ sơ QA',
    fallbackZone: 'bottom_nav',
    required: false,
  });
  await adb.sleep(2000);
  const { content: profileXml } = await adb.dumpUi(deviceId, 'qa_profile');
  const currentAccount = accountSwitch.readProfileDisplayName(profileXml, prof);
  if (currentAccount) {
    pass('LIVE-ACC-01', `TK đang active: "${currentAccount}"`);
  } else {
    fail('LIVE-ACC-01', 'Không đọc được tên TK trên profile');
  }

  const lsCmd = await adb.adb(deviceId, 'shell ls -1 /sdcard/TikTokAuto', { ignoreError: true });
  const fileLines = (lsCmd.output || '').split('\n').filter((l) => l.trim() && !/cannot find/i.test(l));
  pass('LIVE-FS-01', `TikTokAuto: ${fileLines.length} file`);
}

async function testLiveAccountSwitch(deviceId, targetAccount) {
  if (!targetAccount) {
    skip('LIVE-SW-01', 'Không truyền --account=...');
    return;
  }
  console.log(`\n── Live switch_account → "${targetAccount}" ──`);
  const prof = screen.getScreenSize(deviceId);
  const logger = {
    step: (_, m) => console.log(`    [switch] ${m}`),
    warn: (_, m) => console.log(`    [warn] ${m}`),
    success: (_, m) => console.log(`    [ok] ${m}`),
  };
  const ctx = {
    deviceId,
    screen: prof,
    logger,
    setScreenState() {},
    checkAborted() {},
    job: { tiktok_account: targetAccount },
  };
  try {
    const result = await accountSwitch.ensureAccount(ctx, targetAccount);
    if (result.account && accountSwitch.accountsMatch(result.account, targetAccount)) {
      pass('LIVE-SW-01', `Chuyển OK → ${result.account}`);
    } else {
      fail('LIVE-SW-01', `Kết quả: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    fail('LIVE-SW-01', `${err.code || 'ERR'}: ${err.message}`);
  }
}

function printSummary() {
  const passN = results.filter((r) => r.status === 'PASS').length;
  const failN = results.filter((r) => r.status === 'FAIL').length;
  const skipN = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n══════════════════════════════════════');
  console.log(`QA Summary: ${passN} PASS | ${failN} FAIL | ${skipN} SKIP`);
  console.log('══════════════════════════════════════');
  return failN === 0 ? 0 : 1;
}

async function main() {
  const live = process.argv.includes('--live');
  const accountArg = process.argv.find((a) => a.startsWith('--account='));
  const targetAccount = accountArg ? accountArg.split('=').slice(1).join('=').trim() : null;
  const deviceArg = process.argv.find((a) => a.startsWith('--device='));
  const deviceId = deviceArg ? deviceArg.split('=')[1] : null;

  console.log('TikTok ADB Auto — QA Regression');
  console.log(`Mode: ${live ? 'LIVE + offline' : 'offline only'}`);

  testOfflineXml();

  if (live) {
    const id = deviceId || await testDeviceConnectivity();
    if (id) {
      await testLiveBasics(id);
      await testLiveAccountSwitch(id, targetAccount);
    }
  } else {
    skip('LIVE-*', 'Thêm --live khi máy đã cắm USB');
  }

  process.exit(printSummary());
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
