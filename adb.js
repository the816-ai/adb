const fs = require('fs');
const path = require('path');

const adbExec = require('./adb-exec');
const tiktokApp = require('./tiktok-app');
const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill';
const JOB_VIDEO_DIR = '/sdcard/TikTokAuto';
const JOB_VIDEO_PREFIX = 'ttjob_';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const LOGS_DIR = path.join(__dirname, 'logs');

for (const dir of [LOGS_DIR, SCREENSHOTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveAdbBinary() {
  if (process.env.ADB_PATH && fs.existsSync(process.env.ADB_PATH)) {
    return `"${process.env.ADB_PATH}"`;
  }

  const local = path.join(__dirname, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (fs.existsSync(local)) return `"${local}"`;

  const winGetGlob = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Packages'
  );
  if (fs.existsSync(winGetGlob)) {
    const pkgs = fs.readdirSync(winGetGlob).filter((p) => p.includes('PlatformTools'));
    for (const pkg of pkgs) {
      const candidate = path.join(winGetGlob, pkg, 'platform-tools', 'adb.exe');
      if (fs.existsSync(candidate)) return `"${candidate}"`;
    }
  }

  const sdkAdb = path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  if (fs.existsSync(sdkAdb)) return `"${sdkAdb}"`;

  return 'adb';
}

const ADB_BIN = resolveAdbBinary();

function log(deviceId, message) {
  const line = `[${new Date().toISOString()}] [${deviceId}] ${message}\n`;
  const logFile = path.join(LOGS_DIR, `${deviceId}.log`);
  fs.appendFileSync(logFile, line);
  console.log(line.trim());
}

async function adb(deviceId, command, options = {}) {
  return adbExec.run(ADB_BIN, deviceId, command, options);
}

function adbSync(deviceId, command, options = {}) {
  return adbExec.runSync(ADB_BIN, deviceId, command, options);
}

function setPulseCallback(deviceId, fn) {
  adbExec.setPulseCallback(deviceId, fn);
}

function getDevices() {
  const { output } = adbSync(null, 'devices');
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('offline'))
    .map((line) => {
      const [id, status] = line.split(/\s+/);
      return { id, status };
    })
    .filter((d) => d.status === 'device');
}

function isDeviceOnline(deviceId) {
  const devices = getDevices();
  return devices.some((d) => d.id === deviceId);
}

async function wakeDevice(deviceId) {
  await adb(deviceId, 'shell input keyevent KEYCODE_WAKEUP');
  await adb(deviceId, 'shell input keyevent KEYCODE_MENU', { ignoreError: true });
}

async function isDeviceAwake(deviceId) {
  const { output } = await adb(deviceId, 'shell dumpsys power', { ignoreError: true });
  return /mWakefulness=Awake/i.test(output) || /Display Power: state=ON/i.test(output);
}

async function unlockIfNeeded(deviceId, screenProfile = null) {
  const awake = await isDeviceAwake(deviceId);
  if (awake) return;

  await wakeDevice(deviceId);
  const w = screenProfile?.width || 1080;
  const h = screenProfile?.height || 2400;
  const x = Math.round(w * 0.5);
  const y1 = Math.round(h * 0.75);
  const y2 = Math.round(h * 0.35);
  await adb(
    deviceId,
    `shell input swipe ${x} ${y1} ${x} ${y2} ${300 + Math.floor(Math.random() * 150)}`,
    { ignoreError: true }
  );
}

async function screenshot(deviceId, label = 'error') {
  const timestamp = Date.now();
  const filename = `${deviceId}_${label}_${timestamp}.png`;
  const localPath = path.join(SCREENSHOTS_DIR, filename);
  const remotePath = `/sdcard/${filename}`;

  await adb(deviceId, `shell screencap -p ${remotePath}`, { ignoreError: true });
  await adb(deviceId, `pull ${remotePath} "${localPath}"`, { ignoreError: true });
  await adb(deviceId, `shell rm ${remotePath}`, { ignoreError: true });

  return fs.existsSync(localPath) ? localPath : null;
}

const TIKTOK_UI_PACKAGES = /ugc\.trill|musically/i;

function isTikTokUiXml(xml) {
  if (!xml) return false;
  return TIKTOK_UI_PACKAGES.test(xml);
}

function isKeyguardUiXml(xml) {
  if (!xml) return true;
  if (isTikTokUiXml(xml)) return false;
  return /keyguard|clockpack|legacy_window_root|notification_panel/i.test(xml)
    || (/com\.android\.systemui/i.test(xml) && !TIKTOK_UI_PACKAGES.test(xml));
}

async function keepScreenOn(deviceId, on = true) {
  await adb(deviceId, `shell svc power stayon ${on ? 'usb' : 'false'}`, { ignoreError: true });
}

async function dismissKeyguard(deviceId, screenProfile = null, { swipe = false } = {}) {
  await wakeDevice(deviceId);
  await adb(deviceId, 'shell wm dismiss-keyguard', { ignoreError: true });
  await adb(deviceId, 'shell input keyevent 82', { ignoreError: true });
  if (!swipe) return;

  const w = screenProfile?.width || 1080;
  const h = screenProfile?.height || 2400;
  const x = Math.round(w * 0.5);
  for (const [y1, y2] of [[0.82, 0.35], [0.78, 0.30]]) {
    await adb(
      deviceId,
      `shell input swipe ${x} ${Math.round(h * y1)} ${x} ${Math.round(h * y2)} ${320 + Math.floor(Math.random() * 120)}`,
      { ignoreError: true }
    );
    await sleep(500);
  }
}

async function ensureDeviceAwake(deviceId, screenProfile = null, { forceUnlock = false } = {}) {
  await wakeDevice(deviceId);
  await dismissNotificationShade(deviceId);

  if (forceUnlock) {
    await dismissKeyguard(deviceId, screenProfile, { swipe: true });
    await unlockIfNeeded(deviceId, screenProfile);
    return;
  }

  const awake = await isDeviceAwake(deviceId);
  if (awake) {
    await adb(deviceId, 'shell wm dismiss-keyguard', { ignoreError: true });
    return;
  }

  await dismissKeyguard(deviceId, screenProfile, { swipe: true });
  await unlockIfNeeded(deviceId, screenProfile);
}

async function dumpUi(deviceId, label = 'ui') {
  const stamp = Date.now();
  const remoteXml = `/sdcard/window_${stamp}.xml`;
  const localXml = path.join(SCREENSHOTS_DIR, `${deviceId}_${label}_${stamp}.xml`);

  await adb(deviceId, `shell uiautomator dump ${remoteXml}`, { timeout: 15000, ignoreError: true });
  await adb(deviceId, `pull ${remoteXml} "${localXml}"`, { ignoreError: true });
  await adb(deviceId, `shell rm ${remoteXml}`, { ignoreError: true });

  if (fs.existsSync(localXml)) {
    return { content: fs.readFileSync(localXml, 'utf8'), path: localXml };
  }
  return { content: null, path: null };
}

async function dumpUiValidated(deviceId, label = 'ui', screenProfile = null, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    await ensureDeviceAwake(deviceId, screenProfile, { forceUnlock: attempt > 0 });
    const result = await dumpUi(deviceId, label);
    if (result.content && isTikTokUiXml(result.content) && !isKeyguardUiXml(result.content)) {
      return result;
    }
    if (attempt < maxRetries - 1) {
      log(deviceId, `UI dump chưa phải TikTok (${label}) — mở khóa và thử lại ${attempt + 2}/${maxRetries}`);
      await sleep(800 + attempt * 400);
    }
  }
  return dumpUi(deviceId, label);
}

function readDeviceLog(deviceId, lines = 200) {
  const logFile = path.join(LOGS_DIR, `${deviceId}.log`);
  if (!fs.existsSync(logFile)) return [];
  const content = fs.readFileSync(logFile, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').slice(-lines);
}

function listArtifacts({ deviceId, jobIdPrefix, limit = 50 } = {}) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) return [];
  const files = fs.readdirSync(SCREENSHOTS_DIR)
    .filter((f) => /\.(png|xml)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(SCREENSHOTS_DIR, f));
      return { filename: f, path: path.join(SCREENSHOTS_DIR, f), mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  let filtered = files;
  if (deviceId) filtered = filtered.filter((f) => f.filename.startsWith(deviceId));
  if (jobIdPrefix) filtered = filtered.filter((f) => f.filename.includes(jobIdPrefix));
  return filtered.slice(0, limit);
}

function artifactUrl(filePath) {
  if (!filePath) return null;
  return `/api/artifacts/${path.basename(filePath)}`;
}

function parseBounds(boundsStr) {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  return {
    x1, y1, x2, y2,
    centerX: Math.floor((x1 + x2) / 2),
    centerY: Math.floor((y1 + y2) / 2),
  };
}

function findNodeInXml(xml, matchers) {
  if (!xml) return null;

  const nodeRegex = /<node[^>]*>/g;
  let match;
  const nodes = [];

  while ((match = nodeRegex.exec(xml)) !== null) {
    const tag = match[0];
    const text = (tag.match(/text="([^"]*)"/) || [])[1] || '';
    const desc = (tag.match(/content-desc="([^"]*)"/) || [])[1] || '';
    const resourceId = (tag.match(/resource-id="([^"]*)"/) || [])[1] || '';
    const bounds = (tag.match(/bounds="([^"]*)"/) || [])[1] || '';
    const clickable = tag.includes('clickable="true"');

    nodes.push({ text, desc, resourceId, bounds, clickable, tag });
  }

  for (const matcher of matchers) {
    for (const node of nodes) {
      const value = node[matcher.field] || '';
      if (matcher.regex.test(value)) {
        const parsed = parseBounds(node.bounds);
        if (parsed) {
          return { ...node, ...parsed, matchedBy: matcher.field };
        }
      }
    }
  }

  return null;
}

async function tap(deviceId, x, y) {
  await adb(deviceId, `shell input tap ${x} ${y}`);
}

async function tapNode(deviceId, node) {
  await tap(deviceId, node.centerX, node.centerY);
}

function escapeInputTextPlain(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/ /g, '%s')
    .replace(/&/g, '%26')
    .replace(/'/g, "%'")
    .replace(/\$/g, '%24')
    .replace(/`/g, '%60')
    .replace(/!/g, '%21')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/;/g, '%3B')
    .replace(/\|/g, '%7C')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

async function inputHashSymbol(deviceId) {
  const attempts = [
    `shell sh -c ${JSON.stringify("input text $(printf '#')")}`,
    'shell input keyevent 18',
  ];
  for (const cmd of attempts) {
    const r = await adb(deviceId, cmd, { ignoreError: true });
    if (r.success) return true;
  }
  return false;
}

async function inputTextPlain(deviceId, text) {
  if (!text) return;
  const escaped = escapeInputTextPlain(text);
  await adb(deviceId, `shell input text "${escaped}"`);
}

async function inputText(deviceId, text) {
  if (!text) return;
  if (!text.includes('#')) {
    await inputTextPlain(deviceId, text);
    return;
  }

  const parts = text.split('#');
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) await inputHashSymbol(deviceId);
    if (parts[i]) await inputTextPlain(deviceId, parts[i]);
  }
}

function isClipboardShellError(output) {
  if (!output) return false;
  return /no shell command implementation|securityexception|not permitted|unknown command|error/i.test(output);
}

async function setClipboard(deviceId, text) {
  const methods = [];

  const jsonText = JSON.stringify(text);
  const r1 = await adb(deviceId, `shell cmd clipboard set-text ${jsonText}`, { ignoreError: true });
  if (r1.success && !isClipboardShellError(r1.output)) methods.push('cmd');

  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const r0 = await adb(
    deviceId,
    `shell sh -c ${JSON.stringify(`echo ${b64} | base64 -d | cmd clipboard set-text`)}`,
    { ignoreError: true }
  );
  if (r0.success && !isClipboardShellError(r0.output)) methods.push('base64+cmd');

  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r2 = await adb(deviceId, `shell am broadcast -a clipper.set -e text "${escaped}"`, { ignoreError: true });
  if (r2.success && !/error/i.test(r2.output || '')) methods.push('clipper');

  return { ok: methods.length > 0, methods };
}

async function getClipboard(deviceId) {
  const r = await adb(deviceId, 'shell cmd clipboard get-text', { ignoreError: true });
  if (!r.success || !r.output || isClipboardShellError(r.output)) return null;
  return r.output;
}

async function setClipboardVerified(deviceId, text) {
  const result = await setClipboard(deviceId, text);
  if (!result.ok) return { ok: false, reason: 'no_method' };

  await sleep(400);
  const got = await getClipboard(deviceId);
  if (got !== null && got.trim() === text.trim()) {
    return { ok: true, method: result.methods[0], verified: true };
  }

  if (got === null) {
    return { ok: false, reason: 'verify_unavailable', methods: result.methods };
  }

  return { ok: false, reason: 'verify_failed', got, methods: result.methods };
}

async function pasteFromClipboard(deviceId) {
  await adb(deviceId, 'shell input keyevent 279');
}

async function touchFile(deviceId, remotePath) {
  await adb(deviceId, `shell touch "${remotePath}"`, { ignoreError: true });
}

function normalizeDevicePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace('/storage/emulated/0', '/sdcard').replace(/\/+/g, '/');
}

function pathVariants(remotePath) {
  const norm = normalizeDevicePath(remotePath);
  const base = path.posix.basename(norm);
  const variants = new Set([
    remotePath,
    norm,
    norm.replace('/sdcard/', '/storage/emulated/0/'),
    `${JOB_VIDEO_DIR}/${base}`,
  ]);
  return [...variants];
}

function buildJobRemoteName(jobId) {
  const slug = String(jobId).replace(/-/g, '').slice(0, 12);
  return `${JOB_VIDEO_PREFIX}${slug}.mp4`;
}

function parseContentQueryRows(output) {
  if (!output) return [];
  const rows = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('Row:')) continue;
    const row = {};
    const body = line.replace(/^Row:\s*\d+\s*/, '');
    for (const seg of body.split(', ')) {
      const eq = seg.indexOf('=');
      if (eq > 0) row[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
    }
    if (row._data) rows.push(row);
  }
  return rows;
}

function formatMediaRow(row) {
  const dateAdded = parseInt(row.date_added, 10);
  const dateModified = parseInt(row.date_modified, 10);
  const size = parseInt(row._size, 10);
  const duration = parseInt(row.duration, 10);
  return {
    id: row._id,
    path: normalizeDevicePath(row._data),
    displayName: row._display_name || path.posix.basename(row._data),
    bucket: row.bucket_display_name || '',
    dateAdded: Number.isNaN(dateAdded) ? 0 : dateAdded,
    dateModified: Number.isNaN(dateModified) ? 0 : dateModified,
    size: Number.isNaN(size) ? null : size,
    duration: Number.isNaN(duration) ? null : duration,
  };
}

function filterMediaRows(rows, whereClause) {
  if (!whereClause) return rows;

  const like = whereClause.match(/_data LIKE '%(.+?)%'/i);
  if (like) {
    const needle = like[1];
    return rows.filter((r) => r.path.includes(needle));
  }

  const likePrefix = whereClause.match(/_data LIKE '%(.+)'/i);
  if (likePrefix) {
    const needle = likePrefix[1];
    return rows.filter((r) => r.path.includes(needle));
  }

  const exact = whereClause.match(/_data='([^']+)'/i);
  if (exact) {
    const wanted = normalizeDevicePath(exact[1]);
    return rows.filter((r) => normalizeDevicePath(r.path) === wanted);
  }

  const bucket = whereClause.match(/bucket_display_name='([^']+)'/i);
  if (bucket) {
    return rows.filter((r) => r.bucket === bucket[1]);
  }

  return rows;
}

let mediaCache = new Map();
const MEDIA_CACHE_TTL_MS = parseInt(process.env.MEDIA_CACHE_TTL_MS || '8000', 10);

async function queryVideoMedia(deviceId, whereClause, { forceRefresh = false } = {}) {
  const cacheKey = deviceId;
  const cached = mediaCache.get(cacheKey);
  const cacheFresh = cached && (Date.now() - cached.at < MEDIA_CACHE_TTL_MS);

  if (!forceRefresh && cacheFresh) {
    if (!whereClause) return cached.rows;
    return filterMediaRows(cached.rows, whereClause);
  }

  const projection = '_id:_data:_display_name:date_added:date_modified:bucket_display_name:_size:duration';
  const r = await adb(
    deviceId,
    `shell content query --uri content://media/external/video/media --projection ${projection}`,
    { ignoreError: true, timeout: 30000 }
  );
  const rows = parseContentQueryRows(r.output).map(formatMediaRow);
  mediaCache.set(cacheKey, { rows, at: Date.now() });

  if (!whereClause) return rows;
  return filterMediaRows(rows, whereClause);
}

function clearMediaCache(deviceId) {
  if (deviceId) mediaCache.delete(deviceId);
  else mediaCache.clear();
}

async function getRemoteFileMtime(deviceId, remotePath) {
  const r = await adb(deviceId, `shell stat -c %Y "${remotePath}" 2>/dev/null || stat -f %m "${remotePath}"`, { ignoreError: true });
  if (r.success && r.output) {
    const mtime = parseInt(r.output.trim(), 10);
    if (!Number.isNaN(mtime)) return mtime;
  }

  const ls = await adb(deviceId, `shell ls -l "${remotePath}"`, { ignoreError: true });
  if (ls.success && ls.output) {
    const parts = ls.output.trim().split(/\s+/);
    if (parts.length >= 6) {
      const parsed = Date.parse(parts.slice(5).join(' '));
      if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    }
  }

  const info = await getVideoMediaInfo(deviceId, remotePath);
  if (info) return info.dateModified || info.dateAdded || null;
  return null;
}

async function getVideoMediaInfo(deviceId, remotePath, { forceRefresh = false } = {}) {
  const base = path.posix.basename(remotePath);
  for (const variant of pathVariants(remotePath)) {
    const escaped = variant.replace(/'/g, "''");
    const rows = await queryVideoMedia(deviceId, `_data='${escaped}'`, { forceRefresh });
    if (rows.length) return rows[0];
  }
  const likeRows = await queryVideoMedia(deviceId, `_data LIKE '%${base}%'`, { forceRefresh });
  const sameName = likeRows.filter((r) => path.posix.basename(r.path) === base);
  if (sameName.length === 1) return sameName[0];
  return null;
}

function getLocalVideoFingerprint(localPath) {
  const stat = fs.statSync(localPath);
  return { size: stat.size, path: localPath };
}

async function getRemoteFileSize(deviceId, remotePath) {
  const r = await adb(deviceId, `shell stat -c %s ${remotePath}`, { ignoreError: true });
  if (r.success && r.output) {
    const size = parseInt(r.output.trim(), 10);
    if (!Number.isNaN(size)) return size;
  }
  const r2 = await adb(deviceId, `shell ls -l "${remotePath}"`, { ignoreError: true });
  if (r2.success && r2.output) {
    const parts = r2.output.trim().split(/\s+/);
    if (parts.length >= 5) {
      const size = parseInt(parts[4], 10);
      if (!Number.isNaN(size)) return size;
    }
  }
  return null;
}

async function getRemoteVideoFingerprint(deviceId, remotePath) {
  const media = await getVideoMediaInfo(deviceId, remotePath);
  const fileSize = await getRemoteFileSize(deviceId, remotePath);
  return {
    fileSize,
    mediaSize: media?.size ?? null,
    duration: media?.duration ?? null,
    mediaId: media?.id ?? null,
    path: remotePath,
  };
}

function compareVideoFingerprints(localFp, remoteFp, options = {}) {
  const {
    toleranceBytes = 512,
    expectedMediaId = null,
    expectedDuration = null,
    durationToleranceMs = 2500,
  } = options;

  const localSize = localFp?.size;
  const remoteSize = remoteFp?.fileSize ?? remoteFp?.mediaSize;
  if (!localSize || !remoteSize) {
    return {
      ok: false,
      reason: 'missing_size',
      localSize: localSize || null,
      remoteSize: remoteSize || null,
    };
  }

  if (expectedMediaId != null && remoteFp?.mediaId != null
    && String(remoteFp.mediaId) !== String(expectedMediaId)) {
    return {
      ok: false,
      reason: 'media_id_mismatch',
      localSize,
      remoteSize,
      expectedMediaId,
      actualMediaId: remoteFp.mediaId,
    };
  }

  const diff = Math.abs(localSize - remoteSize);
  if (diff > toleranceBytes) {
    return {
      ok: false,
      reason: 'size_mismatch',
      localSize,
      remoteSize,
      diff,
      duration: remoteFp?.duration ?? null,
      mediaId: remoteFp?.mediaId ?? null,
    };
  }

  if (expectedDuration != null && remoteFp?.duration != null) {
    const dDiff = Math.abs(Number(expectedDuration) - Number(remoteFp.duration));
    if (dDiff > durationToleranceMs) {
      return {
        ok: false,
        reason: 'duration_mismatch',
        localSize,
        remoteSize,
        diff,
        expectedDuration,
        actualDuration: remoteFp.duration,
        mediaId: remoteFp?.mediaId ?? null,
      };
    }
  }

  return {
    ok: true,
    reason: 'match',
    localSize,
    remoteSize,
    diff,
    duration: remoteFp?.duration ?? null,
    mediaId: remoteFp?.mediaId ?? null,
  };
}

async function countFilesInDir(deviceId, dirPath) {
  const r = await adb(deviceId, `shell ls -1 ${dirPath}`, { ignoreError: true });
  if (!r.output) return 0;
  return r.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/no such file|not found|permission denied|cannot find the path/i.test(l))
    .length;
}

async function clearJobVideoDir(deviceId) {
  await adb(deviceId, `shell mkdir -p ${JOB_VIDEO_DIR}`, { ignoreError: true });
  await adb(deviceId, `shell rm -f ${JOB_VIDEO_DIR}/${JOB_VIDEO_PREFIX}*`, { ignoreError: true });
  await adb(deviceId, `shell rm -f ${JOB_VIDEO_DIR}/*`, { ignoreError: true });
}

async function isNewestLibraryVideo(deviceId, remotePath) {
  const base = path.posix.basename(remotePath);
  const all = await queryVideoMedia(deviceId);
  if (!all.length) return false;
  const sorted = [...all].sort((a, b) => b.dateAdded - a.dateAdded || b.dateModified - a.dateModified);
  return path.posix.basename(sorted[0].path) === base
    || normalizeDevicePath(sorted[0].path) === normalizeDevicePath(remotePath);
}

async function getVideoGridIndex(deviceId, remotePath, { album = 'TikTokAuto', cols = 3 } = {}) {
  const base = path.posix.basename(remotePath);
  let rows = await queryVideoMedia(deviceId, `bucket_display_name='${album}'`);
  if (!rows.length) {
    rows = await queryVideoMedia(deviceId, `_data LIKE '%${JOB_VIDEO_DIR}%'`);
  }
  if (!rows.length) {
    rows = await queryVideoMedia(deviceId, `_data LIKE '%${base}%'`);
  }

  const sorted = [...rows].sort((a, b) => b.dateAdded - a.dateAdded || b.dateModified - a.dateModified);
  const index = sorted.findIndex((r) => path.posix.basename(r.path) === base
    || normalizeDevicePath(r.path) === normalizeDevicePath(remotePath));
  return {
    index,
    total: sorted.length,
    cols,
    files: sorted.map((r) => r.displayName || path.posix.basename(r.path)),
  };
}

async function waitForMediaIndexed(deviceId, remotePath, { timeout = 12000, interval = 800 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const info = await getVideoMediaInfo(deviceId, remotePath);
    if (info) return info;
    await sleep(interval);
  }
  return null;
}

async function prepareJobVideo(deviceId, localPath, jobId) {
  await clearJobVideoDir(deviceId);
  clearMediaCache(deviceId);
  const remoteName = buildJobRemoteName(jobId);
  const remotePath = `${JOB_VIDEO_DIR}/${remoteName}`;

  await adb(deviceId, `push "${localPath}" "${remotePath}"`, { timeout: 120000 });
  const indexed = await scanMedia(deviceId, remotePath);
  clearMediaCache(deviceId);

  return { remotePath, remoteName, album: 'TikTokAuto', mediaIndexed: Boolean(indexed) };
}

async function verifyJobVideo(deviceId, remotePath, remoteName, localFingerprint = null) {
  const fileCount = await countFilesInDir(deviceId, JOB_VIDEO_DIR);
  const media = await waitForMediaIndexed(deviceId, remotePath);
  const grid = await getVideoGridIndex(deviceId, remotePath);
  const remoteFingerprint = await getRemoteVideoFingerprint(deviceId, remotePath);
  let fingerprint = null;
  if (localFingerprint) {
    fingerprint = compareVideoFingerprints(localFingerprint, remoteFingerprint, {
      expectedMediaId: media?.id ?? null,
      expectedDuration: media?.duration ?? null,
    });
  }

  return {
    ok: Boolean(media) && fileCount === 1 && grid.index >= 0
      && (!fingerprint || fingerprint.ok),
    fileCount,
    media,
    grid,
    remotePath,
    remoteName,
    remoteFingerprint,
    fingerprint,
  };
}

async function pushVideo(deviceId, localPath, remoteName) {
  const remotePath = `${JOB_VIDEO_DIR}/${remoteName}`;
  await adb(deviceId, `push "${localPath}" "${remotePath}"`, { timeout: 120000 });
  return remotePath;
}

async function scanMedia(deviceId, remotePath, { retries = 3 } = {}) {
  const norm = normalizeDevicePath(remotePath);
  const base = path.posix.basename(norm);
  const fileUri = `file://${norm}`;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    clearMediaCache(deviceId);
    await touchFile(deviceId, norm);

    await adb(
      deviceId,
      `shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "${fileUri}"`,
      { ignoreError: true, timeout: 20000 }
    );

    await adb(
      deviceId,
      `shell content query --uri content://media/external/video/media --projection _id:_data --where "_data LIKE '%${base.replace(/'/g, "''")}%'"`,
      { ignoreError: true, timeout: 20000 }
    );

    const waitMs = attempt === retries - 1 ? 10000 : 5000;
    const indexed = await waitForMediaIndexed(deviceId, norm, {
      timeout: waitMs,
      interval: 600,
    });
    if (indexed) return indexed;

    await sleep(800 * (attempt + 1));
  }

  return null;
}

function getVideoContentUri(mediaId) {
  return `content://media/external/video/media/${mediaId}`;
}

async function shareVideoToTikTok(deviceId, mediaId, pkg, remotePath = null) {
  const contentUri = getVideoContentUri(mediaId);
  const systemShare = `${pkg}/com.ss.android.ugc.aweme.share.SystemShareActivity`;
  const variants = [
    `shell am start -n ${systemShare} -a android.intent.action.SEND -t video/mp4 -c android.intent.category.DEFAULT --eu android.intent.extra.STREAM "${contentUri}" --grant-read-uri-permission`,
    `shell am start -a android.intent.action.SEND -t video/mp4 -c android.intent.category.DEFAULT --eu android.intent.extra.STREAM "${contentUri}" -p ${pkg} --grant-read-uri-permission`,
    `shell am start -a android.intent.action.SEND -t video/* -c android.intent.category.DEFAULT --eu android.intent.extra.STREAM "${contentUri}" -p ${pkg} --grant-read-uri-permission`,
  ];

  if (remotePath) {
    const fileUri = remotePath.startsWith('file://') ? remotePath : `file://${remotePath}`;
    variants.push(
      `shell am start -a android.intent.action.SEND -t video/mp4 -c android.intent.category.DEFAULT --eu android.intent.extra.STREAM "${fileUri}" -p ${pkg}`
    );
  }

  const ui = require('./ui-state');
  const screenMod = require('./screen');
  const screenProfile = screenMod.getScreenSize(deviceId);

  for (let i = 0; i < variants.length; i += 1) {
    const r = await adb(deviceId, variants[i], { ignoreError: true, timeout: 20000 });
    const bad = /Error:|does not exist|Permission Denial|SecurityException/i.test(r.output || '');
    if (!r.success || bad) continue;

    const verified = await ui.pollEditScreenQuick(deviceId, screenProfile, 6000);
    if (verified.ok) {
      return {
        ok: true,
        uri: contentUri,
        method: i,
        output: r.output,
        screen: verified.screen,
        verified: true,
      };
    }

    const focus = await getCurrentFocus(deviceId);
    if (focus && focus.includes(pkg)) {
      return { ok: true, uri: contentUri, method: i, output: r.output, focus, verified: false };
    }
  }

  return { ok: false, uri: contentUri };
}

async function clearOldVideo(deviceId, remoteName) {
  await adb(deviceId, `shell rm -f ${JOB_VIDEO_DIR}/${remoteName}`, { ignoreError: true });
  await adb(deviceId, `shell rm -f /sdcard/Download/${remoteName}`, { ignoreError: true });
}

async function refreshJobMediaTarget(deviceId, remotePath, videoTarget) {
  clearMediaCache(deviceId);
  const media = await getVideoMediaInfo(deviceId, remotePath, { forceRefresh: true });
  if (!media) return { ok: false, reason: 'media_not_found' };
  if (videoTarget?.mediaId && String(media.id) !== String(videoTarget.mediaId)) {
    return { ok: false, reason: 'media_id_changed', expected: videoTarget.mediaId, actual: media.id };
  }
  return { ok: true, media };
}

async function getCurrentFocus(deviceId) {
  const state = await tiktokApp.getWindowState(deviceId);
  return state.focus;
}

async function isTikTokOpen(deviceId) {
  return tiktokApp.isTikTokOpen(deviceId);
}

async function openTikTok(deviceId) {
  return tiktokApp.openTikTok(deviceId);
}

async function bringTikTokToForeground(deviceId) {
  return tiktokApp.bringTikTokToForeground(deviceId);
}

async function dismissNotificationShade(deviceId) {
  return tiktokApp.dismissNotificationShade(deviceId);
}

async function detectTikTokPackage(deviceId) {
  return tiktokApp.detectTikTokPackage(deviceId);
}

async function forceStopTikTok(deviceId) {
  return tiktokApp.forceStopTikTok(deviceId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(conditionFn, { timeout = 30000, interval = 1000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await conditionFn()) return true;
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function retry(fn, { retries = 3, delay = 2000, label = 'action' } = {}) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (i < retries - 1) await sleep(delay);
    }
  }
  throw new Error(`${label} failed after ${retries} retries: ${lastError.message}`);
}

async function findAndTap(deviceId, matchers, { fallback, label, retries = 3 } = {}) {
  return retry(
    async () => {
      const { content: xml } = await dumpUi(deviceId, label.replace(/\s+/g, '_').toLowerCase());
      const node = findNodeInXml(xml, matchers);
      if (node) {
        log(deviceId, `Found "${label}" via ${node.matchedBy}: ${node.text || node.desc || node.resourceId}`);
        await tapNode(deviceId, node);
        return node;
      }
      if (fallback) {
        log(deviceId, `Using fallback coords for "${label}"`);
        await tap(deviceId, fallback.x, fallback.y);
        return { fallback: true };
      }
      throw new Error(`Cannot find UI element: ${label}`);
    },
    { retries, label }
  );
}

module.exports = {
  TIKTOK_PACKAGE,
  JOB_VIDEO_DIR,
  JOB_VIDEO_PREFIX,
  tiktokApp,
  ADB_BIN,
  SCREENSHOTS_DIR,
  LOGS_DIR,
  adb,
  adbSync,
  setPulseCallback,
  resolveAdbBinary,
  getDevices,
  isDeviceOnline,
  wakeDevice,
  unlockIfNeeded,
  keepScreenOn,
  dismissKeyguard,
  ensureDeviceAwake,
  isTikTokUiXml,
  isKeyguardUiXml,
  screenshot,
  dumpUi,
  dumpUiValidated,
  readDeviceLog,
  listArtifacts,
  artifactUrl,
  findNodeInXml,
  parseBounds,
  tap,
  tapNode,
  inputText,
  setClipboard,
  getClipboard,
  setClipboardVerified,
  pasteFromClipboard,
  touchFile,
  getRemoteFileMtime,
  normalizeDevicePath,
  buildJobRemoteName,
  queryVideoMedia,
  clearMediaCache,
  getVideoMediaInfo,
  getVideoGridIndex,
  isNewestLibraryVideo,
  clearJobVideoDir,
  prepareJobVideo,
  verifyJobVideo,
  getVideoContentUri,
  shareVideoToTikTok,
  getLocalVideoFingerprint,
  getRemoteVideoFingerprint,
  compareVideoFingerprints,
  refreshJobMediaTarget,
  waitForMediaIndexed,
  pushVideo,
  scanMedia,
  clearOldVideo,
  openTikTok,
  bringTikTokToForeground,
  dismissNotificationShade,
  detectTikTokPackage,
  getCurrentFocus,
  isTikTokOpen,
  forceStopTikTok,
  sleep,
  waitFor,
  retry,
  findAndTap,
  log,
};
