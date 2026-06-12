const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const LOGS_DIR = path.join(ROOT, 'logs');

const RETENTION_DAYS = parseInt(process.env.ARTIFACT_RETENTION_DAYS || '7', 10);
const MAX_SCREENSHOT_FILES = parseInt(process.env.MAX_SCREENSHOT_FILES || '500', 10);
const MAX_LOG_BYTES = parseInt(process.env.MAX_LOG_FILE_BYTES || '2097152', 10);

function isOlderThan(filePath, days) {
  const stat = fs.statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function cleanupDirByAge(dirPath, days, extensions = null) {
  if (!fs.existsSync(dirPath)) return { removed: 0, freed: 0 };

  let removed = 0;
  let freed = 0;
  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;
    if (extensions && !extensions.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    if (!isOlderThan(full, days)) continue;
    try {
      freed += stat.size;
      fs.unlinkSync(full);
      removed += 1;
    } catch (_) {
      // ignore
    }
  }
  return { removed, freed };
}

function trimNewestCap(dirPath, maxFiles, extensions = null) {
  if (!fs.existsSync(dirPath)) return { removed: 0 };

  const files = fs.readdirSync(dirPath)
    .map((name) => {
      const full = path.join(dirPath, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return null;
        if (extensions && !extensions.some((ext) => name.toLowerCase().endsWith(ext))) return null;
        return { full, mtime: stat.mtimeMs, size: stat.size };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  for (const file of files.slice(maxFiles)) {
    try {
      fs.unlinkSync(file.full);
      removed += 1;
    } catch (_) {
      // ignore
    }
  }
  return { removed };
}

function truncateLargeLogs(dirPath, maxBytes) {
  if (!fs.existsSync(dirPath)) return { truncated: 0 };

  let truncated = 0;
  for (const name of fs.readdirSync(dirPath)) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(dirPath, name);
    try {
      const stat = fs.statSync(full);
      if (stat.size <= maxBytes) continue;
      const fd = fs.openSync(full, 'r+');
      const buf = Buffer.alloc(Math.min(maxBytes, 65536));
      fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, `...[truncated ${new Date().toISOString()}]\n`);
      fs.writeSync(fd, buf);
      fs.closeSync(fd);
      truncated += 1;
    } catch (_) {
      // ignore
    }
  }
  return { truncated };
}

function runMaintenance() {
  const screenshotsAge = cleanupDirByAge(SCREENSHOTS_DIR, RETENTION_DAYS, ['.png', '.xml']);
  const screenshotsCap = trimNewestCap(SCREENSHOTS_DIR, MAX_SCREENSHOT_FILES, ['.png', '.xml']);
  const logsAge = cleanupDirByAge(LOGS_DIR, RETENTION_DAYS, ['.log']);
  const logsTrunc = truncateLargeLogs(LOGS_DIR, MAX_LOG_BYTES);

  return {
    screenshotsAge,
    screenshotsCap,
    logsAge,
    logsTrunc,
    at: new Date().toISOString(),
  };
}

function startMaintenanceScheduler(intervalMs = null) {
  const ms = intervalMs || parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10);
  if (ms <= 0) return null;

  const run = () => {
    try {
      const result = runMaintenance();
      const totalRemoved = result.screenshotsAge.removed + result.screenshotsCap.removed + result.logsAge.removed;
      if (totalRemoved > 0 || result.logsTrunc.truncated > 0) {
        console.log(`[cleanup] screenshots -${totalRemoved}, logs truncated ${result.logsTrunc.truncated}`);
      }
    } catch (err) {
      console.error(`[cleanup] Failed: ${err.message}`);
    }
  };

  run();
  return setInterval(run, ms);
}

module.exports = {
  runMaintenance,
  startMaintenanceScheduler,
};
