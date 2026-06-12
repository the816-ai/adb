const adb = require('./adb');

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

async function pause(minMs = 400, maxMs = 1200) {
  await adb.sleep(randInt(minMs, maxMs));
}

async function think(minMs = 800, maxMs = 2500) {
  await adb.sleep(randInt(minMs, maxMs));
}

function jitterCoord(x, y, spread = 12) {
  return {
    x: Math.round(x + rand(-spread, spread)),
    y: Math.round(y + rand(-spread, spread)),
  };
}

async function tap(deviceId, x, y, options = {}) {
  const { spread = 10, preDelay = [80, 200], postDelay = [120, 350] } = options;
  await pause(preDelay[0], preDelay[1]);
  const { x: jx, y: jy } = jitterCoord(x, y, spread);
  await adb.adb(deviceId, `shell input tap ${jx} ${jy}`);
  await pause(postDelay[0], postDelay[1]);
}

async function tapNode(deviceId, node, options = {}) {
  return tap(deviceId, node.centerX, node.centerY, options);
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = null) {
  const dur = durationMs || randInt(280, 450);
  await pause(100, 300);
  await adb.adb(deviceId, `shell input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
  await pause(200, 500);
}

async function unlockSwipe(deviceId, screen) {
  const x = Math.round(screen.width * 0.5);
  const y1 = Math.round(screen.height * 0.75);
  const y2 = Math.round(screen.height * 0.35);
  await swipe(deviceId, x, y1, x, y2);
}

async function dismissKeyboard(deviceId, screen) {
  const x = Math.round(screen.width * 0.5);
  const y = Math.round(screen.height * 0.45);
  await tap(deviceId, x, y, { spread: 20, preDelay: [100, 200], postDelay: [200, 400] });
}

async function clearField(deviceId) {
  await adb.adb(deviceId, 'shell input keycombination 113 29', { ignoreError: true });
  await pause(150, 300);

  const r = await adb.adb(deviceId, 'shell input keyevent 67', { ignoreError: true });
  if (r.success) {
    await pause(100, 200);
    return;
  }

  await adb.adb(deviceId, 'shell input keyevent 122', { ignoreError: true });
  await pause(80, 150);
  for (let i = 0; i < 80; i++) {
    await adb.adb(deviceId, 'shell input keyevent 67', { ignoreError: true });
    if (i % 10 === 0) await pause(30, 60);
  }
  await pause(100, 200);
}

async function typeSegments(deviceId, segments) {
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const chunk = i > 0 ? ` ${seg.value}` : seg.value;
    await typeChunk(deviceId, chunk);
    await pause(seg.type === 'hashtag' ? 200 : 100, seg.type === 'hashtag' ? 600 : 300);
  }
}

async function pasteText(deviceId, text, options = {}) {
  const { segments = null, allowTypeFallback = true } = options;
  await think(300, 800);

  const setResult = await adb.setClipboard(deviceId, text);
  if (setResult.ok) {
    await pause(400, 900);
    await adb.pasteFromClipboard(deviceId);
    await think(500, 1200);
    return { method: setResult.methods[0] || 'clipboard', verified: false };
  }

  if (allowTypeFallback && segments?.length) {
    await think(200, 500);
    await typeSegments(deviceId, segments);
    return { method: 'type', reason: 'no_clipboard' };
  }

  throw new Error('Clipboard failed: no_method');
}

async function typeChunk(deviceId, chunk) {
  if (!chunk) return;
  await adb.inputText(deviceId, chunk);
  await pause(150, 400);
}

module.exports = {
  rand,
  randInt,
  pause,
  think,
  jitterCoord,
  tap,
  tapNode,
  swipe,
  unlockSwipe,
  dismissKeyboard,
  clearField,
  pasteText,
  typeSegments,
  typeChunk,
};
