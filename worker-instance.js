const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.join(__dirname, 'jobs', 'worker.lock');

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function releaseWorkerLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (_) {
    // ignore
  }
}

function acquireWorkerLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  const existing = readLock();
  if (existing?.pid && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    return { ok: false, pid: existing.pid, startedAt: existing.startedAt };
  }
  if (existing) releaseWorkerLock();

  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      const again = readLock();
      return { ok: false, pid: again?.pid, startedAt: again?.startedAt };
    }
    return { ok: false, error: err.message };
  }

  const cleanup = () => releaseWorkerLock();
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return { ok: true, pid: process.pid };
}

function getWorkerStatus() {
  const lock = readLock();
  if (!lock?.pid) return { running: false };
  if (!isPidAlive(lock.pid)) {
    return { running: false, stale: true, lastPid: lock.pid, startedAt: lock.startedAt };
  }
  return { running: true, pid: lock.pid, startedAt: lock.startedAt };
}

module.exports = {
  LOCK_PATH,
  acquireWorkerLock,
  releaseWorkerLock,
  getWorkerStatus,
};
