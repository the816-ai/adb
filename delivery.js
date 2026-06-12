const adb = require('./adb');
const human = require('./human');
const ui = require('./ui-state');

const DELIVERY_METHOD = {
  SHARE: 'share',
  GALLERY: 'gallery',
};

function buildDeliveryResult({ ok, method, screen: screenName, mediaId, uri, meta = {} }) {
  return {
    ok,
    method,
    screen: screenName || null,
    mediaId: mediaId || null,
    uri: uri || null,
    verifiedSize: meta.verifiedSize || null,
    remoteName: meta.remoteName || null,
    ...meta,
  };
}

async function assertVideoIntegrity(ctx, stepLabel) {
  const refresh = await adb.refreshJobMediaTarget(ctx.deviceId, ctx.remotePath, ctx.videoTarget);
  if (!refresh.ok) {
    const code = refresh.reason === 'media_id_changed' ? 'VIDEO_META_MISMATCH' : 'VIDEO_NOT_VERIFIED';
    throw Object.assign(
      new Error(`Xác minh media thất bại [${stepLabel}]: ${refresh.reason}`),
      { code, meta: refresh }
    );
  }

  if (refresh.media?.id) {
    ctx.videoTarget.mediaId = refresh.media.id;
    ctx.videoTarget.duration = refresh.media.duration ?? ctx.videoTarget.duration;
    ctx.videoTarget.size = refresh.media.size ?? ctx.videoTarget.size;
  }

  await ui.verifyVideoMetadata(
    ctx.deviceId,
    ctx.videoTarget,
    ctx.localFingerprint,
    ctx.logger,
    { expectedMediaId: ctx.videoTarget.mediaId, expectedDuration: ctx.videoTarget.duration }
  );
}

async function tryShareDelivery(ctx, { onAbort } = {}) {
  if (!ctx.videoTarget?.mediaId) {
    return buildDeliveryResult({ ok: false, method: DELIVERY_METHOD.SHARE, meta: { reason: 'no_media_id' } });
  }

  try {
    await assertVideoIntegrity(ctx, 'pre_share');
  } catch (err) {
    return buildDeliveryResult({
      ok: false,
      method: DELIVERY_METHOD.SHARE,
      meta: { reason: err.code || 'pre_share_verify_failed', message: err.message },
    });
  }

  await adb.wakeDevice(ctx.deviceId);
  await adb.dismissNotificationShade(ctx.deviceId);
  await human.pause(300, 600);

  const pkg = await adb.detectTikTokPackage(ctx.deviceId);
  const share = await adb.shareVideoToTikTok(
    ctx.deviceId,
    ctx.videoTarget.mediaId,
    pkg,
    ctx.remotePath
  );

  if (!share.ok) {
    return buildDeliveryResult({
      ok: false,
      method: DELIVERY_METHOD.SHARE,
      meta: { reason: 'intent_failed', uri: share.uri, code: 'SHARE_FAILED' },
    });
  }

  ctx.logger.step('deliver_video', `Share intent #${share.method}: ${share.uri}`);
  await human.think(800, 1500);
  await ui.confirmShareChooser(ctx.deviceId, ctx.screen, ctx.logger);
  await human.think(1500, 2800);
  await adb.dismissNotificationShade(ctx.deviceId);

  const result = await ui.waitForEditAfterShare(ctx.deviceId, ctx.screen, ctx.logger, 25000, onAbort);
  if (result.timedOut || ![ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(result.screen)) {
    const shot = await adb.screenshot(ctx.deviceId, 'share_fail');
    if (shot) ctx.logger.artifact('deliver_video', 'Share fail screenshot', shot, 'screenshot');
    const reason = result.screen === ui.SCREENS.GALLERY
      ? 'share_chooser_stuck'
      : (result.screen === ui.SCREENS.UNKNOWN ? 'wrong_app_or_chooser' : 'no_edit_screen');
    return buildDeliveryResult({
      ok: false,
      method: DELIVERY_METHOD.SHARE,
      screen: result.screen,
      mediaId: ctx.videoTarget.mediaId,
      uri: share.uri,
      meta: {
        reason,
        code: 'SHARE_FAILED',
        shareMethod: share.method,
        timedOut: Boolean(result.timedOut),
        screenshot: shot,
      },
    });
  }

  try {
    await assertVideoIntegrity(ctx, 'post_share');
  } catch (err) {
    return buildDeliveryResult({
      ok: false,
      method: DELIVERY_METHOD.SHARE,
      screen: result.screen,
      mediaId: ctx.videoTarget.mediaId,
      uri: share.uri,
      meta: { reason: err.code || 'post_share_verify_failed', message: err.message },
    });
  }

  return buildDeliveryResult({
    ok: true,
    method: DELIVERY_METHOD.SHARE,
    screen: result.screen,
    mediaId: ctx.videoTarget.mediaId,
    uri: share.uri,
    verifiedSize: ctx.videoTarget.size,
    remoteName: ctx.videoTarget.remoteName,
  });
}

async function runGalleryDelivery(ctx, helpers, { onAbort } = {}) {
  const { ensureScreen, recoverToMain } = helpers;
  const abortOpt = onAbort ? { onAbort } : {};

  await adb.wakeDevice(ctx.deviceId);
  await adb.dismissNotificationShade(ctx.deviceId);
  await human.pause(400, 800);

  adb.clearMediaCache(ctx.deviceId);
  await assertVideoIntegrity(ctx, 'pre_gallery');

  const pkg = await adb.detectTikTokPackage(ctx.deviceId);
  ctx.logger.step('deliver_video', `Gallery path — package ${pkg}`);

  if (await adb.isTikTokOpen(ctx.deviceId)) {
    await adb.bringTikTokToForeground(ctx.deviceId);
  } else {
    await adb.openTikTok(ctx.deviceId);
  }

  await human.think(3000, 5000);
  await adb.dismissNotificationShade(ctx.deviceId);
  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);

  try {
    await adb.waitFor(async () => adb.isTikTokOpen(ctx.deviceId), {
      timeout: 22000, interval: 1500, label: 'TikTok foreground',
    });
  } catch (_) {
    await adb.bringTikTokToForeground(ctx.deviceId);
    await adb.dismissNotificationShade(ctx.deviceId);
    await human.think(2000, 3500);
    await adb.waitFor(async () => adb.isTikTokOpen(ctx.deviceId), {
      timeout: 15000, interval: 1500, label: 'TikTok foreground retry',
    });
  }

  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  const recovered = await recoverToMain();
  if (!recovered) {
    ctx.logger.warn('deliver_video', 'recoverToMain thất bại — force-stop TikTok lần nữa');
    await adb.forceStopTikTok(ctx.deviceId);
    await human.think(1500, 2800);
    await adb.openTikTok(ctx.deviceId);
    await human.think(4500, 6500);
    await adb.dismissNotificationShade(ctx.deviceId);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  }

  let homeResult;
  try {
    homeResult = await ui.waitForScreen(ctx.deviceId, ctx.screen, ui.MAIN_SCREENS, {
      timeout: 20000,
      logger: ctx.logger,
      ...abortOpt,
    });
  } catch (err) {
    if (err.code === 'NOT_LOGGED_IN') throw err;
    if (err.code === 'CANCELLED') throw err;
    ctx.logger.warn('deliver_video', `Chưa về main (${err.actual}) — restart TikTok`);
    await adb.forceStopTikTok(ctx.deviceId);
    await human.think(1500, 2800);
    await adb.openTikTok(ctx.deviceId);
    await human.think(4500, 6500);
    await adb.dismissNotificationShade(ctx.deviceId);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    homeResult = await ui.waitForScreen(ctx.deviceId, ctx.screen, ui.MAIN_SCREENS, {
      timeout: 20000,
      logger: ctx.logger,
      ...abortOpt,
    });
  }

  if (ui.findInXml(homeResult.xml, 'login')) {
    throw Object.assign(new Error('TikTok chưa đăng nhập'), { code: 'NOT_LOGGED_IN' });
  }

  ctx.setScreenState(homeResult.screen);

  await ui.tapElement(ctx.deviceId, 'create', ctx.screen, {
    label: 'Quay (+)',
    fallbackZone: 'create_button',
    logger: ctx.logger,
  });
  await human.think(1200, 2200);

  const createResult = await ensureScreen(
    [ui.SCREENS.CREATE_SHEET, ui.SCREENS.GALLERY],
    12000
  );
  ctx.setScreenState(createResult.screen);

  if (createResult.screen !== ui.SCREENS.GALLERY) {
    await ui.tapElement(ctx.deviceId, 'upload', ctx.screen, {
      label: 'Upload',
      fallbackZone: 'upload_button',
      logger: ctx.logger,
      required: true,
    });
    await human.think(1500, 2800);
    const galleryResult = await ensureScreen(ui.SCREENS.GALLERY, 15000);
    ctx.setScreenState(galleryResult.screen);
  }

  if (!ctx.videoTarget) {
    throw Object.assign(new Error('Chưa xác minh video'), { code: 'VIDEO_NOT_VERIFIED' });
  }

  await ui.selectVideo(ctx.deviceId, ctx.screen, ctx.videoTarget, ctx.logger);
  await human.think(1500, 2500);
  await assertVideoIntegrity(ctx, 'post_gallery_select');

  const confirmed = await ui.confirmVideoSelected(ctx.deviceId, ctx.screen);
  if (!confirmed) {
    throw Object.assign(new Error('Không chọn được video trong gallery'), { code: 'VIDEO_NOT_IN_GALLERY' });
  }

  ctx.setScreenState(confirmed);

  return buildDeliveryResult({
    ok: true,
    method: DELIVERY_METHOD.GALLERY,
    screen: confirmed,
    mediaId: ctx.videoTarget.mediaId,
    uri: adb.getVideoContentUri(ctx.videoTarget.mediaId),
    verifiedSize: ctx.videoTarget.size,
    remoteName: ctx.videoTarget.remoteName,
  });
}

async function deliverVideo(ctx, helpers) {
  adb.clearMediaCache(ctx.deviceId);
  const onAbort = () => ctx.checkAborted();

  const { screen: preScreen } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if ([ui.SCREENS.GALLERY, ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT, ui.SCREENS.POSTING].includes(preScreen)) {
    ctx.logger.warn('deliver_video', `TikTok đang ở ${preScreen} từ session cũ — force-stop trước share`);
    await adb.forceStopTikTok(ctx.deviceId);
    await human.think(1500, 2800);
  }

  const shareResult = await tryShareDelivery(ctx, { onAbort });
  if (shareResult.ok) {
    if (![ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(shareResult.screen)) {
      ctx.logger.warn(
        'deliver_video',
        `Share báo OK nhưng màn hình ${shareResult.screen} — không tin, fallback gallery`
      );
    } else {
      ctx.deliveryResult = shareResult;
      ctx.deliveryMethod = DELIVERY_METHOD.SHARE;
      ctx.setScreenState(shareResult.screen);
      ctx.logger.success(
        'deliver_video',
        `OK [share] mediaId=${shareResult.mediaId} screen=${shareResult.screen}`,
        { meta: { delivery_method: DELIVERY_METHOD.SHARE, uri: shareResult.uri } }
      );
      return shareResult;
    }
  }

  ctx.logger.warn(
    'deliver_video',
    `Share thất bại (${shareResult.meta?.reason || 'unknown'}) — reset TikTok, fallback gallery`
  );

  await adb.forceStopTikTok(ctx.deviceId);
  adb.clearMediaCache(ctx.deviceId);
  await human.think(1500, 2800);

  const galleryResult = await runGalleryDelivery(ctx, helpers, { onAbort });
  ctx.deliveryResult = galleryResult;
  ctx.deliveryMethod = DELIVERY_METHOD.GALLERY;
  ctx.logger.success(
    'deliver_video',
    `OK [gallery] mediaId=${galleryResult.mediaId} screen=${galleryResult.screen}`,
    { meta: { delivery_method: DELIVERY_METHOD.GALLERY, uri: galleryResult.uri } }
  );
  return galleryResult;
}

module.exports = {
  DELIVERY_METHOD,
  buildDeliveryResult,
  tryShareDelivery,
  runGalleryDelivery,
  deliverVideo,
  assertVideoIntegrity,
};
