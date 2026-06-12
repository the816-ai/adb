const { execSync, spawn } = require('child_process');



const pulseCallbacks = new Map();



function setPulseCallback(deviceId, fn) {

  if (typeof deviceId === 'function') {

    pulseCallbacks.set('*', deviceId);

    return;

  }

  if (!deviceId) {

    pulseCallbacks.clear();

    return;

  }

  if (typeof fn === 'function') {

    pulseCallbacks.set(deviceId, fn);

  } else {

    pulseCallbacks.delete(deviceId);

  }

}



function pulse(deviceId) {

  try {

    pulseCallbacks.get(deviceId)?.();

    pulseCallbacks.get('*')?.();

  } catch (_) {

    // ignore pulse errors

  }

}



function unquoteBin(quoted) {

  return String(quoted || 'adb').replace(/^"|"$/g, '');

}



function buildShellCommand(adbBin, deviceId, command) {

  const bin = unquoteBin(adbBin);

  const quotedBin = process.platform === 'win32' ? `"${bin}"` : bin;

  return deviceId

    ? `${quotedBin} -s ${deviceId} ${command}`

    : `${quotedBin} ${command}`;

}



function runSync(adbBin, deviceId, command, options = {}) {

  const { timeout = 30000, ignoreError = false } = options;

  const fullCmd = buildShellCommand(adbBin, deviceId, command);



  try {

    const result = execSync(fullCmd, {

      timeout,

      encoding: 'utf8',

      stdio: ['pipe', 'pipe', 'pipe'],

      windowsHide: true,

    });

    return { success: true, output: result.trim() };

  } catch (err) {

    const output = `${err.stdout || ''}${err.stderr || ''}`.trim();

    if (ignoreError) {

      return { success: false, output, error: err.message };

    }

    throw new Error(`ADB failed: ${fullCmd}\n${output}`);

  }

}



function run(adbBin, deviceId, command, options = {}) {

  const { timeout = 30000, ignoreError = false } = options;

  const fullCmd = buildShellCommand(adbBin, deviceId, command);



  pulse(deviceId);



  return new Promise((resolve, reject) => {

    const child = spawn(fullCmd, [], {

      shell: true,

      windowsHide: true,

      stdio: ['ignore', 'pipe', 'pipe'],

    });



    let stdout = '';

    let stderr = '';

    let settled = false;

    let killEscalated = false;



    const finish = (fn, value) => {

      if (settled) return;

      settled = true;

      clearTimeout(timer);

      clearTimeout(killTimer);

      pulse(deviceId);

      fn(value);

    };



    const timer = setTimeout(() => {

      child.kill('SIGTERM');

      killTimer = setTimeout(() => {

        if (!settled) {

          killEscalated = true;

          child.kill('SIGKILL');

        }

      }, 3000);

      const err = new Error(`ADB timeout after ${timeout}ms: ${fullCmd}`);

      if (ignoreError) {

        finish(resolve, { success: false, output: `${stdout}${stderr}`.trim(), error: err.message });

      } else {

        finish(reject, err);

      }

    }, timeout);



    let killTimer = null;



    child.stdout.on('data', (chunk) => {

      stdout += chunk.toString();

    });



    child.stderr.on('data', (chunk) => {

      stderr += chunk.toString();

    });



    child.on('error', (err) => {

      if (ignoreError) {

        finish(resolve, { success: false, output: '', error: err.message });

      } else {

        finish(reject, err);

      }

    });



    child.on('close', (code) => {

      if (settled && killEscalated) return;

      const output = `${stdout}${stderr}`.trim();

      if (code === 0) {

        finish(resolve, { success: true, output });

        return;

      }

      if (ignoreError) {

        finish(resolve, { success: false, output, error: `exit ${code}` });

        return;

      }

      finish(reject, new Error(`ADB failed (exit ${code}): ${fullCmd}\n${output}`));

    });

  });

}



module.exports = {

  setPulseCallback,

  pulse,

  run,

  runSync,

};


