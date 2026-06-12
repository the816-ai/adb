const db = require('./db');



const STALE_DEVICE_MS = parseInt(process.env.DEVICE_STALE_MS || '900000', 10);

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '10000', 10);



const ACTIVE_JOB_STATUSES = [

  'assigned',

  'running',

  'pushing_video',

  'opening_app',

  'selecting_video',

  'input_caption',

  'posting',

  'ready_manual',

  'engaging',

];



let recoveryInFlight = null;



async function recoverStaleDevices(maxAgeMs = STALE_DEVICE_MS) {

  if (recoveryInFlight) return recoveryInFlight;



  recoveryInFlight = (async () => {

    const result = db.recoverStaleBusyDevices(maxAgeMs);

    if (result.count > 0) {

      let adb;

      try {

        adb = require('./adb');

        for (const device of result.devices) {

          adb.log(device.id, `Stale lock recovered (job ${device.jobId || 'none'}) — force-stop TikTok`);

          await adb.forceStopTikTok(device.id);

        }

      } catch (_) {

        // adb optional during tests

      }

    }

    return result.count;

  })();



  try {

    return await recoveryInFlight;

  } finally {

    recoveryInFlight = null;

  }

}



async function tryAcquireJob(deviceId) {

  await recoverStaleDevices();

  return db.acquireDeviceJob(deviceId);

}



function releaseDevice(deviceId, jobId = null) {

  return db.releaseDevice(deviceId, jobId);

}



function touchHeartbeat(deviceId) {

  db.touchDeviceHeartbeat(deviceId);

}



function startHeartbeat(deviceId, intervalMs = HEARTBEAT_INTERVAL_MS) {

  touchHeartbeat(deviceId);

  return setInterval(() => touchHeartbeat(deviceId), intervalMs);

}



module.exports = {

  STALE_DEVICE_MS,

  HEARTBEAT_INTERVAL_MS,

  ACTIVE_JOB_STATUSES,

  recoverStaleDevices,

  tryAcquireJob,

  releaseDevice,

  touchHeartbeat,

  startHeartbeat,

};


