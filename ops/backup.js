const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'jobs', 'jobs.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = parseInt(process.env.BACKUP_KEEP_COUNT || '14', 10);

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('jobs-') && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function pruneBackups() {
  const backups = listBackups();
  for (const old of backups.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(old.path);
    } catch (_) {
      // ignore
    }
  }
}

function backupDatabase(label = 'auto') {
  if (!fs.existsSync(DB_PATH)) {
    return { ok: false, reason: 'db_not_found' };
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `jobs-${stamp}-${label}.db`);

  fs.copyFileSync(DB_PATH, dest);
  pruneBackups();

  return {
    ok: true,
    path: dest,
    size: fs.statSync(dest).size,
    kept: Math.min(listBackups().length, MAX_BACKUPS),
  };
}

function startBackupScheduler(intervalMs = null) {
  const ms = intervalMs || parseInt(process.env.BACKUP_INTERVAL_MS || '21600000', 10);
  if (ms <= 0) return null;

  const run = () => {
    try {
      const result = backupDatabase('scheduled');
      if (result.ok) {
        console.log(`[backup] OK → ${path.basename(result.path)} (${result.size} bytes)`);
      }
    } catch (err) {
      console.error(`[backup] Failed: ${err.message}`);
    }
  };

  run();
  return setInterval(run, ms);
}

module.exports = {
  DB_PATH,
  BACKUP_DIR,
  backupDatabase,
  listBackups,
  startBackupScheduler,
};
