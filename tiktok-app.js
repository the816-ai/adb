function adb() {
  return require('./adb');
}

const TIKTOK_PACKAGES = [
  'com.ss.android.ugc.trill',
  'com.zhiliaoapp.musically',
  'com.zhiliaoapp.musically.go',
];

const ACTIVITY_CANDIDATES = [
  'com.ss.android.ugc.aweme.splash.SplashActivity',
  'com.ss.android.ugc.aweme.main.MainActivity',
  '.splash.SplashActivity',
  '.main.MainActivity',
];

const packageCache = new Map();

async function detectTikTokPackage(deviceId) {
  if (packageCache.has(deviceId)) return packageCache.get(deviceId);

  for (const pkg of TIKTOK_PACKAGES) {
    const r = await adb().adb(deviceId, `shell pm path ${pkg}`, { ignoreError: true });
    if (r.success && r.output.includes(pkg)) {
      packageCache.set(deviceId, pkg);
      return pkg;
    }
  }

  packageCache.set(deviceId, TIKTOK_PACKAGES[0]);
  return TIKTOK_PACKAGES[0];
}

function clearPackageCache(deviceId) {
  if (deviceId) packageCache.delete(deviceId);
  else packageCache.clear();
}

async function getWindowState(deviceId) {
  const { output } = await adb().adb(deviceId, 'shell dumpsys window');
  const lines = output.split('\n');
  const focus = lines.find((l) => l.includes('mCurrentFocus')) || '';
  const focusedApp = lines.find((l) => l.includes('mFocusedApp')) || '';
  return { focus, focusedApp, output };
}

async function isTikTokOpen(deviceId) {
  const pkg = await detectTikTokPackage(deviceId);
  const { focus, focusedApp } = await getWindowState(deviceId);

  if (focus.includes(pkg) || focusedApp.includes(pkg)) return true;

  const act = await adb().adb(deviceId, 'shell dumpsys activity activities', { ignoreError: true, timeout: 15000 });
  if (act.success && act.output.includes(pkg)) {
    const pkgEsc = pkg.replace(/\./g, '\\.');
    if (new RegExp(`topResumedActivity=.*${pkgEsc}`).test(act.output)) return true;
    if (/mResumedActivity=.*ComponentInfo/.test(act.output) && act.output.includes(pkg)) return true;
    if (act.output.includes('ResumedActivity') && act.output.includes(pkg)) return true;
  }

  return false;
}

async function dismissNotificationShade(deviceId) {
  await adb().adb(deviceId, 'shell cmd statusbar collapse', { ignoreError: true });
  await adb().adb(deviceId, 'shell service call statusbar 2', { ignoreError: true });
}

async function bringTikTokToForeground(deviceId) {
  const pkg = await detectTikTokPackage(deviceId);
  await adb().wakeDevice(deviceId);
  await dismissNotificationShade(deviceId);

  for (const activity of ACTIVITY_CANDIDATES) {
    const component = activity.startsWith('com.') ? activity : `${pkg}/${activity}`;
    const r = await adb().adb(
      deviceId,
      `shell am start -W -n ${component}`,
      { ignoreError: true, timeout: 20000 }
    );
    if (r.success && !/Error/i.test(r.output)) return { pkg, component };
  }

  await adb().adb(
    deviceId,
    `shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg}`,
    { ignoreError: true }
  );
  await adb().adb(deviceId, `shell monkey -p ${pkg} 1`, { ignoreError: true });
  return { pkg, component: 'launcher' };
}

async function openTikTok(deviceId) {
  return bringTikTokToForeground(deviceId);
}

async function forceStopTikTok(deviceId) {
  const pkg = await detectTikTokPackage(deviceId);
  await adb().adb(deviceId, `shell am force-stop ${pkg}`, { ignoreError: true });
}

module.exports = {
  TIKTOK_PACKAGES,
  detectTikTokPackage,
  clearPackageCache,
  getWindowState,
  isTikTokOpen,
  dismissNotificationShade,
  bringTikTokToForeground,
  openTikTok,
  forceStopTikTok,
};
