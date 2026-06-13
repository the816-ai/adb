require('./env').loadEnv();

const adb = require('./adb');
const workerInstance = require('./worker-instance');

const db = require('./db');

const workerLock = require('./worker-lock');

const { startJob } = require('./tiktok-flow');
const { startEngagementJob } = require('./engagement-flow');
const { startMaintenanceScheduler } = require('./ops/cleanup');



const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);

const JOB_COOLDOWN_MS = parseInt(process.env.JOB_COOLDOWN_MS || '30000', 10);



const runningDevices = new Set();



function recordEvent(jobId, event) {

  db.addJobEvent(jobId, {

    step: event.step,

    level: event.level,

    message: event.message,

    artifact_path: event.artifact_path || null,

    artifact_type: event.artifact_type || null,

    meta: event.meta || null,

  });

}



function isJobSuperseded(jobId) {

  const job = db.getJob(jobId);

  if (!job) return true;

  return job.status === 'need_manual_check' && job.error_code === 'WORKER_TIMEOUT';

}



async function processDevice(deviceId) {

  if (runningDevices.has(deviceId)) return;

  runningDevices.add(deviceId);

  let acquiredJobId = null;

  try {

    if (!adb.isDeviceOnline(deviceId)) {

      db.upsertDevice(deviceId, { last_error: 'Device offline' });

      return;

    }



    db.upsertDevice(deviceId, { last_seen: new Date().toISOString() });



    const claimed = await workerLock.tryAcquireJob(deviceId);

    if (!claimed) return;



    const job = claimed;

    acquiredJobId = job.id;

    db.addJobEvent(job.id, { step: 'worker', level: 'info', message: `Worker nhận job: ${job.video_path}` });

    adb.log(deviceId, `Starting job ${job.id}: ${job.video_path}`);

    await adb.keepScreenOn(deviceId, true);

    const heartbeatTimer = workerLock.startHeartbeat(deviceId);

    adb.setPulseCallback(deviceId, () => workerLock.touchHeartbeat(deviceId));

    let result;

    try {

      const jobCallbacks = {

        onStatusChange: (status, extra = {}) => {

          if (isJobSuperseded(job.id)) return;

          db.updateJobIfActive(job.id, { status, ...extra });

          workerLock.touchHeartbeat(deviceId);

        },

        onEvent: (event) => recordEvent(job.id, event),

        onHeartbeat: () => workerLock.touchHeartbeat(deviceId),

        isCancelled: () => db.isJobCancelRequested(job.id),

        isSuperseded: () => isJobSuperseded(job.id),

      };

      result = job.post_mode === db.POST_MODES.ENGAGE
        ? await startEngagementJob(job, jobCallbacks)
        : await startJob(job, jobCallbacks);

    } finally {

      adb.setPulseCallback(deviceId, null);

      clearInterval(heartbeatTimer);

    }



    if (isJobSuperseded(job.id)) {

      adb.log(deviceId, `Job ${job.id} superseded by stale recovery — bỏ qua ghi kết quả`);

      workerLock.releaseDevice(deviceId, acquiredJobId);

      return;

    }



    if (db.isJobCancelRequested(job.id) && !result.success) {

      result = {

        ...result,

        error: result.error || 'Cancelled by operator',

        error_code: 'CANCELLED',

        status: 'failed',

      };

    }



    if (result.success && job.post_mode !== db.POST_MODES.ENGAGE) {
      db.touchDeviceLastPost(deviceId);
    }



    const finalStatus = result.success

      ? (result.status || 'done')

      : (result.status || 'failed');



    const updated = db.updateJobIfActive(job.id, {

      status: finalStatus,

      error: result.error || null,

      error_code: result.error_code || null,

      screenshot: result.screenshot || null,

      finished_at: new Date().toISOString(),

    });



    if (!updated) {

      adb.log(deviceId, `Job ${job.id} không ghi được trạng thái cuối — job đã terminal/recovered`);

    }



    const released = workerLock.releaseDevice(deviceId, acquiredJobId);

    if (!released) {

      adb.log(deviceId, `Device lock mismatch khi release job ${job.id} — có thể đã recover stale`);

    }



    db.addJobEvent(job.id, {

      step: 'worker',

      level: result.success ? 'success' : 'error',

      message: result.success ? 'Worker hoàn tất job' : `Worker fail: ${result.error}`,

      artifact_path: result.screenshot || null,

      artifact_type: result.screenshot ? 'screenshot' : null,

      meta: result.failed_step ? { failed_step: result.failed_step } : null,

    });



    if (result.success) {

      adb.log(deviceId, `Job ${job.id} completed successfully`);

    } else {

      db.upsertDevice(deviceId, { last_error: result.error });

      adb.log(deviceId, `Job ${job.id} failed: ${result.error}`);

    }

    if (job.campaign_id) {
      try {
        require('./campaigns').refreshCampaignStatus(job.campaign_id);
      } catch (refreshErr) {
        adb.log(deviceId, `Campaign status refresh failed: ${refreshErr.message}`);
      }
    }



    await adb.sleep(JOB_COOLDOWN_MS);

  } catch (err) {

    adb.log(deviceId, `Worker error: ${err.message}`);

    db.upsertDevice(deviceId, { last_error: err.message });

    if (acquiredJobId) {
      db.updateJobIfActive(acquiredJobId, {
        status: 'failed',
        error: err.message,
        error_code: 'WORKER_EXCEPTION',
        finished_at: new Date().toISOString(),
      });
      db.addJobEvent(acquiredJobId, {
        step: 'worker',
        level: 'error',
        message: `Worker exception: ${err.message}`,
      });
      workerLock.releaseDevice(deviceId, acquiredJobId);
      const failedJob = db.getJob(acquiredJobId);
      if (failedJob?.campaign_id) {
        try {
          require('./campaigns').refreshCampaignStatus(failedJob.campaign_id);
        } catch (_) { /* ignore */ }
      }
    }

  } finally {
    await adb.keepScreenOn(deviceId, false);
    runningDevices.delete(deviceId);
  }

}



async function tick() {

  await workerLock.recoverStaleDevices();

  const devices = adb.getDevices();



  for (const { id } of devices) {

    db.upsertDevice(id, { last_seen: new Date().toISOString() });

    processDevice(id).catch((err) => {

      adb.log(id, `Unhandled: ${err.message}`);

    });

  }

}



let pollTimer = null;
let cleanupTimer = null;

function shutdown(signal) {
  console.log(`\n[worker] ${signal} — shutting down...`);
  if (pollTimer) clearInterval(pollTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  workerInstance.releaseWorkerLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const lock = workerInstance.acquireWorkerLock();
  if (!lock.ok) {
    console.error(`Worker đã chạy (pid ${lock.pid || 'unknown'}). Chỉ chạy một instance.`);
    process.exit(1);
  }

  console.log('TikTok ADB Worker started');
  console.log(`PID ${process.pid} | Poll: ${POLL_INTERVAL_MS}ms | Cooldown: ${JOB_COOLDOWN_MS}ms`);

  cleanupTimer = startMaintenanceScheduler();

  await tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}



if (require.main === module) {

  main();

}



module.exports = { processDevice, tick, recordEvent };


