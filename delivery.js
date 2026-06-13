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

async function advancePastVideoPreview(ctx) {
  const { screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (current === ui.SCREENS.POST_EDIT) return current;
  if (current !== ui.SCREENS.VIDEO_EDIT) return current;

  ctx.logger.step(
    'deliver_video',
    'Preview TikTok — bấm Tiếp (dưới) hoặc mũi tên đỏ (trên) nếu vào màn chỉnh'
  );
  return ui.skipVideoEditAndTapNext(ctx.deviceId, ctx.screen, ctx.logger, { logStep: 'deliver_video' });
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
  await human.think(400, 800);
  await ui.confirmShareChooser(ctx.deviceId, ctx.screen, ctx.logger);
  await human.think(800, 1500);
  await adb.dismissNotificationShade(ctx.deviceId);

  const result = await ui.waitForEditAfterShare(ctx.deviceId, ctx.screen, ctx.logger, 28000, onAbort);
  const editScreens = [ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT];
  const onEditScreen = editScreens.includes(result.screen);

  if (onEditScreen) {
    if (result.timedOut) {
      ctx.logger.warn('deliver_video', `Share chậm nhưng đã vào ${result.screen} — tiếp tục`);
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
    let finalScreen = result.screen;
    if (finalScreen === ui.SCREENS.VIDEO_EDIT) {
      finalScreen = await advancePastVideoPreview(ctx);
      ctx.setScreenState(finalScreen);
    }
    return buildDeliveryResult({
      ok: true,
      method: DELIVERY_METHOD.SHARE,
      screen: finalScreen,
      mediaId: ctx.videoTarget.mediaId,
      uri: share.uri,
      verifiedSize: ctx.videoTarget.size,
      remoteName: ctx.videoTarget.remoteName,
    });
  }

  if (result.timedOut || !onEditScreen) {
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
}

async function exitEditWithoutPcPick(ctx, screenName) {
  const nav = require('./engage-nav');
  ctx.logger.warn(
    'deliver_video',
    `${screenName} mà chưa chọn video TikTokAuto — thoát và mở gallery`
  );
  for (let i = 0; i < 5; i += 1) {
    await nav.pressBack(ctx.deviceId, 1);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    const { screen: current, xml } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    if (current === ui.SCREENS.GALLERY) return { screen: current, xml };
    if (current === ui.SCREENS.CREATE_SHEET || ui.findInXml(xml, 'upload')) {
      return { screen: ui.SCREENS.CREATE_SHEET, xml };
    }
    if (ui.MAIN_SCREENS.includes(current)) return { screen: current, xml };
  }
  return ui.dumpAndDetect(ctx.deviceId, ctx.screen);
}

async function tapCreateUploadToGallery(ctx, helpers) {
  const { ensureScreen } = helpers;
  await ui.tapElement(ctx.deviceId, 'upload', ctx.screen, {
    label: 'Upload',
    fallbackZone: 'upload_button',
    logger: ctx.logger,
    required: true,
  });
  await human.think(1500, 2800);
  const galleryResult = await ensureScreen(ui.SCREENS.GALLERY, 15000);
  ctx.setScreenState(galleryResult.screen);
  return galleryResult.screen;
}

async function openGalleryPicker(ctx, helpers, startScreen = null) {
  const { ensureScreen, recoverToMain } = helpers;
  let { screen: current, xml } = startScreen
    ? { screen: startScreen, xml: null }
    : await ui.dumpAndDetect(ctx.deviceId, ctx.screen);

  if ([ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(current)) {
    ({ screen: current, xml } = await exitEditWithoutPcPick(ctx, current));
  }

  if (current === ui.SCREENS.GALLERY) {
    ctx.setScreenState(current);
    return current;
  }

  if (current === ui.SCREENS.PROFILE) {
    const dump = xml || (await adb.dumpUi(ctx.deviceId, 'profile_upload_entry')).content;
    if (ui.findInXml(dump, 'profile_upload')) {
      await ui.tapProfileUpload(ctx.deviceId, ctx.screen, ctx.logger);
      await human.think(1500, 2800);
      try {
        const picked = await ui.waitForScreen(ctx.deviceId, ctx.screen, [ui.SCREENS.GALLERY], {
          timeout: 12000,
          logger: ctx.logger,
          onAbort: () => ctx.checkAborted(),
        });
        ctx.setScreenState(picked.screen);
        return picked.screen;
      } catch (_) {
        ({ screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen));
      }
    }
  }

  if (!ui.MAIN_SCREENS.includes(current)) {
    await recoverToMain();
    ({ screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen));
  }

  await ui.tapElement(ctx.deviceId, 'create', ctx.screen, {
    label: 'Quay (+)',
    fallbackZone: 'create_button',
    logger: ctx.logger,
  });
  await human.think(600, 1000);

  let { screen: afterQuay } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if ([ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(afterQuay)) {
    ({ screen: afterQuay } = await exitEditWithoutPcPick(ctx, afterQuay));
    if (afterQuay === ui.SCREENS.GALLERY) {
      ctx.setScreenState(afterQuay);
      return afterQuay;
    }
    if (afterQuay === ui.SCREENS.CREATE_SHEET) {
      return tapCreateUploadToGallery(ctx, helpers);
    }
  }

  try {
    const opened = await ui.waitForScreen(ctx.deviceId, ctx.screen, [
      ui.SCREENS.CREATE_SHEET,
      ui.SCREENS.GALLERY,
    ], {
      timeout: 12000,
      logger: ctx.logger,
      onAbort: () => ctx.checkAborted(),
    });
    current = opened.screen;
  } catch (err) {
    const { screen: stuck } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    if ([ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(stuck)) {
      ({ screen: current } = await exitEditWithoutPcPick(ctx, stuck));
    } else {
      throw err;
    }
  }

  if (current === ui.SCREENS.GALLERY) {
    ctx.setScreenState(current);
    return current;
  }

  return tapCreateUploadToGallery(ctx, helpers);
}

async function selectPcVideoFromGallery(ctx, helpers) {
  if (!ctx.videoTarget) {
    throw Object.assign(new Error('Chưa xác minh video'), { code: 'VIDEO_NOT_VERIFIED' });
  }

  await openGalleryPicker(ctx, helpers);
  ctx.logger.step('deliver_video', `Chọn video PC: ${ctx.videoTarget.remoteName || ctx.remoteName}`);
  await ui.selectVideo(ctx.deviceId, ctx.screen, ctx.videoTarget, ctx.logger);
  await human.think(1500, 2500);
  await assertVideoIntegrity(ctx, 'post_gallery_select');

  const confirmed = await ui.confirmVideoSelected(ctx.deviceId, ctx.screen);
  if (!confirmed) {
    throw Object.assign(new Error('Không chọn được video trong gallery'), { code: 'VIDEO_NOT_IN_GALLERY' });
  }

  let finalScreen = confirmed;
  if (confirmed === ui.SCREENS.VIDEO_EDIT) {
    finalScreen = await advancePastVideoPreview(ctx);
  }
  ctx.setScreenState(finalScreen);
  return finalScreen;
}

async function runGalleryDelivery(ctx, helpers, { onAbort } = {}) {
  const { recoverToMain } = helpers;
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

  const confirmed = await selectPcVideoFromGallery(ctx, helpers);

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
      let finalScreen = shareResult.screen;
      if (finalScreen === ui.SCREENS.VIDEO_EDIT) {
        finalScreen = await advancePastVideoPreview(ctx);
      }
      shareResult.screen = finalScreen;
      ctx.deliveryResult = shareResult;
      ctx.deliveryMethod = DELIVERY_METHOD.SHARE;
      ctx.setScreenState(finalScreen);
      ctx.logger.success(
        'deliver_video',
        `OK [share] mediaId=${shareResult.mediaId} screen=${finalScreen}`,
        { meta: { delivery_method: DELIVERY_METHOD.SHARE, uri: shareResult.uri } }
      );
      return shareResult;
    }
  }

  ctx.logger.warn(
    'deliver_video',
    `Share thất bại (${shareResult.meta?.reason || 'unknown'}) — reset TikTok, fallback gallery`
  );

  const { screen: afterShareScreen } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if ([ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT].includes(afterShareScreen)) {
    ctx.logger.warn(
      'deliver_video',
      `Share fail ở ${afterShareScreen} — không tin video đúng, chọn lại từ TikTokAuto`
    );
    await exitEditWithoutPcPick(ctx, afterShareScreen);
  }

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
