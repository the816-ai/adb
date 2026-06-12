const human = require('./human');

const adb = require('./adb');



function extractHashtags(text) {

  const matches = text.match(/#[\w\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF]+/gi) || [];

  return [...new Set(matches)];

}



function normalizeCaption(raw) {

  if (!raw || typeof raw !== 'string') return { text: '', hashtags: [], body: '' };



  let text = raw.trim().replace(/\r\n/g, '\n').replace(/\s+/g, ' ');



  const tagMatches = text.match(/#[\w\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF]+/gi) || [];

  const hashtags = [...new Set(tagMatches)];

  const body = text.replace(/#[\w\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF]+/gi, '').replace(/\s+/g, ' ').trim();

  const rebuilt = [body, ...hashtags].filter(Boolean).join(' ').trim();

  return { text: rebuilt || text, hashtags, body };

}



function splitForHumanTyping(caption) {

  const { text, body, hashtags } = normalizeCaption(caption);

  const segments = [];



  if (body) segments.push({ type: 'text', value: body });

  for (const tag of hashtags) {

    segments.push({ type: 'hashtag', value: tag });

  }



  if (segments.length === 0 && text) {

    segments.push({ type: 'text', value: text });

  }



  return { normalized: text, segments };

}



function needsClipboard(caption) {

  const { text } = normalizeCaption(caption);

  const hasUnicode = /[^\x00-\x7F]/.test(text);

  const hasHashtag = /#/.test(text);

  const hasSpecial = /[@&%$!?,;:'"()]/.test(text);

  return hasUnicode || hasHashtag || hasSpecial || text.length > 60;

}



async function inputCaption(deviceId, rawCaption, ctx = {}) {

  const { logger, ui, screen: screenProfile } = ctx;

  const { normalized, segments } = splitForHumanTyping(rawCaption);



  if (logger) logger.step('input_caption', `Caption chuẩn hóa: ${normalized}`);



  const field = await ui.findCaptionField(deviceId, screenProfile);

  if (!field) {

    throw Object.assign(new Error('Không tìm thấy ô caption'), { code: 'CAPTION_FIELD_NOT_FOUND' });

  }



  await human.tapNode(deviceId, field, { spread: 8 });

  await human.think(500, 1000);

  await human.clearField(deviceId);

  await human.pause(200, 500);



  if (needsClipboard(normalized)) {

    if (logger) logger.step('input_caption', 'Paste caption + hashtag qua clipboard');

    await human.pasteText(deviceId, normalized, { segments, allowTypeFallback: true });

  } else {

    if (logger) logger.step('input_caption', 'Gõ caption từng đoạn');

    for (let i = 0; i < segments.length; i++) {

      const seg = segments[i];

      const chunk = i > 0 ? ` ${seg.value}` : seg.value;

      await human.typeChunk(deviceId, chunk);

      await human.pause(seg.type === 'hashtag' ? 200 : 100, seg.type === 'hashtag' ? 600 : 300);

    }

  }



  await human.think(600, 1400);

  await human.dismissKeyboard(deviceId, screenProfile);



  const verified = await verifyCaptionEntered(deviceId, normalized);

  if (!verified.ok) {

    if (logger) logger.warn('input_caption', `Verify fail (${verified.reason}) — paste lại`);

    await human.tapNode(deviceId, field, { spread: 6 });

    await human.clearField(deviceId);

    await human.pasteText(deviceId, normalized, { segments, allowTypeFallback: true });

    await human.dismissKeyboard(deviceId, screenProfile);



    const retry = await verifyCaptionEntered(deviceId, normalized);

    if (!retry.ok) {

      throw Object.assign(new Error('Không nhập được caption/hashtag'), { code: 'CAPTION_INPUT_FAILED', reason: retry.reason });

    }

  }



  return normalized;

}



async function verifyCaptionEntered(deviceId, expected) {

  const { content: xml } = await adb.dumpUi(deviceId, 'verify_caption');

  if (!xml) return { ok: false, reason: 'no_xml' };



  const { text, body, hashtags } = normalizeCaption(expected);

  if (!text.trim()) return { ok: true };

  if (hashtags.length && /%23/i.test(xml)) {
    return { ok: false, reason: 'encoded_hashtag' };
  }

  for (const tag of hashtags) {
    const found = adb.findNodeInXml(xml, [
      { field: 'text', regex: new RegExp(escapeRegex(tag), 'i') },
      { field: 'desc', regex: new RegExp(escapeRegex(tag), 'i') },
    ]);
    if (found) return { ok: true, matched: tag };
  }

  const checks = [];



  if (body.length >= 6) {

    checks.push(body.slice(0, Math.min(body.length, 24)));

  } else if (body.length > 0) {

    checks.push(body);

  }



  for (const tag of hashtags) {

    checks.push(tag.replace('#', ''));

  }



  if (!checks.length) {

    checks.push(text.slice(0, Math.min(text.length, 20)));

  }



  for (const sample of checks) {

    const found = adb.findNodeInXml(xml, [

      { field: 'text', regex: new RegExp(escapeRegex(sample), 'i') },

      { field: 'desc', regex: new RegExp(escapeRegex(sample), 'i') },

    ]);

    if (found) return { ok: true, matched: sample };

  }



  return { ok: false, reason: 'caption_not_visible' };

}



function escapeRegex(s) {

  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

}



module.exports = {

  normalizeCaption,

  extractHashtags,

  splitForHumanTyping,

  needsClipboard,

  inputCaption,

  verifyCaptionEntered,

};


