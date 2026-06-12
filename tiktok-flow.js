const path = require('path');
const fs = require('fs');
const adb = require('./adb');
const screen = require('./screen');
const human = require('./human');
const captionUtil = require('./caption');
const ui = require('./ui-state');
const delivery = require('./delivery');
const resultVerifier = require('./result-verifier');

const NEEDS_MANUAL_CODES = new Set([
  'POST_STUCK', 'POST_FAILED', 'POST_NOT_STARTED', 'POST_STILL_VISIBLE',
  'NOT_LOGGED_IN', 'TIKTOK_NOT_READY', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_SWITCH_FAILED',
  'VIDEO_NOT_IN_GALLERY', 'VIDEO_NOT_VERIFIED', 'VIDEO_AMBIGUOUS',
  'ALBUM_NOT_FOUND', 'VIDEO_META_MISMATCH', 'SHARE_FAILED',
  'CAPTION_INPUT_FAILED', 'CAPTION_FIELD_NOT_FOUND',
  'WRONG_SCREEN', 'WORKER_TIMEOUT', 'UNCONFIRMED_SCREEN', 'STILL_IN_FLOW',
  'NO_NEXT_BUTTON', 'NO_POST_BUTTON', 'NO_UPLOAD_BUTTON',
]);

const POST_MODES = {
  AUTO: 'auto',
  MANUAL: 'manual',
  ENGAGE: 'engage',
};

const FLOW_STEPS_AUTO = [
  'check_device',
  'wake_unlock',
  'open_tiktok',
  'switch_account',
  'push_video',
  'scan_media',
  'deliver_video',
  'click_next',
  'click_next_2',
  'input_caption',
  'click_post',
  'wait_result',
];

const FLOW_STEPS_MANUAL = [
  'check_device',
  'wake_unlock',
  'open_tiktok',
  'switch_account',
  'push_video',
  'scan_media',
];

const FLOW_STEPS = FLOW_STEPS_AUTO;

class TikTokFlowError extends Error {
  constructor(message, code, screenshot = null, step = null, meta = {}) {
    super(message);
    this.name = 'TikTokFlowError';
    this.code = code;
    this.screenshot = screenshot;
    this.step = step;
    this.meta = meta;
  }
}

function createJobLogger(jobId, deviceId, onEvent) {
  const emit = (step, level, message, extra = {}) => {
    adb.log(deviceId, `[${jobId.slice(0, 8)}] ${step}: ${message}`);
    if (onEvent) onEvent({ job_id: jobId, step, level, message, ...extra });
  };

  return {
    step: (s, m, e = {}) => emit(s, 'info', m, e),
    warn: (s, m, e = {}) => emit(s, 'warn', m, e),
    success: (s, m, e = {}) => emit(s, 'success', m, e),
    error: (s, m, e = {}) => emit(s, 'error', m, e),
    artifact: (s, m, fp, type) => emit(s, 'info', m, { artifact_path: fp, artifact_type: type }),
  };
}

async function wrapFlowError(err, ctx) {
  if (err instanceof TikTokFlowError) return err;
  const shot = await adb.screenshot(ctx.deviceId, 'error');
  return new TikTokFlowError(
    err.message,
    err.code || 'UNKNOWN_ERROR',
    shot,
    ctx.currentStep,
    err.meta || {}
  );
}

function createContext(job, callbacks) {
  const { device_id: deviceId, video_path: videoPath, caption, id: jobId } = job;
  const logger = createJobLogger(jobId, deviceId, callbacks.onEvent);
  screen.clearProfile(deviceId);
  const screenProfile = screen.getScreenSize(deviceId);

  let currentStep = null;
  let screenState = ui.SCREENS.UNKNOWN;

  const ctx = {
    job,
    jobId,
    deviceId,
    videoPath,
    videoName: path.basename(videoPath),
    caption,
    logger,
    screen: screenProfile,
    ui,
    human,
    sawPosting: false,
    postConfirmVia: null,
    deliveryMethod: null,
    postMode: job.post_mode === POST_MODES.MANUAL ? POST_MODES.MANUAL : POST_MODES.AUTO,
    get screenState() { return screenState; },
    setScreenState(s) { screenState = s; },
    get currentStep() { return currentStep; },
  };

  ctx.updateStatus = (status, extra = {}) => {
    if (callbacks.onStatusChange) callbacks.onStatusChange(status, extra);
    logger.step(status, `Status -> ${status}`);
  };

  ctx.pulse = () => {
    if (callbacks.onHeartbeat) callbacks.onHeartbeat();
  };

  ctx.checkAborted = () => {
    if (callbacks.isSuperseded && callbacks.isSuperseded()) {
      throw new TikTokFlowError('Job bị recover do worker timeout', 'WORKER_TIMEOUT', null, currentStep);
    }
    if (callbacks.isCancelled && callbacks.isCancelled()) {
      throw new TikTokFlowError('Job bị hủy bởi operator', 'CANCELLED', null, currentStep);
    }
    ctx.pulse();
  };

  ctx.runStep = async (stepName, fn) => {
    ctx.checkAborted();
    if (currentStep && currentStep !== stepName) {
      logger.warn('flow', `Chuyển bước: ${currentStep} -> ${stepName}`);
    }
    currentStep = stepName;
    logger.step(stepName, `Bắt đầu bước`);
    try {
      const result = await fn(ctx);
      ctx.pulse();
      return result;
    } catch (err) {
      throw await wrapFlowError(err, ctx);
    }
  };

  ctx.fail = async (message, code, step = currentStep, meta = {}) => {
    const shot = await adb.screenshot(ctx.deviceId, `fail_${step}`);
    if (shot) ctx.logger.artifact(step, 'Screenshot lỗi', shot, 'screenshot');
    throw new TikTokFlowError(message, code, shot, step, meta);
  };

  return ctx;
}

const STUCK_FLOW_SCREENS = [
  ui.SCREENS.GALLERY,
  ui.SCREENS.VIDEO_EDIT,
  ui.SCREENS.POST_EDIT,
  ui.SCREENS.POSTING,
  ui.SCREENS.CREATE_SHEET,
];

async function restartTikTokToMain(ctx, reason) {
  ctx.logger.warn('recover', `${reason} — force-stop và mở lại TikTok`);
  await adb.forceStopTikTok(ctx.deviceId);
  await human.think(1500, 2500);
  await adb.openTikTok(ctx.deviceId);
  await human.think(4500, 6500);
  await adb.dismissNotificationShade(ctx.deviceId);
  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  const { screen: afterRestart } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (ui.MAIN_SCREENS.includes(afterRestart)) {
    ctx.setScreenState(afterRestart);
    return afterRestart;
  }
  return null;
}

async function resetTikTokIfStuck(ctx, label = 'preflight') {
  const { screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (!STUCK_FLOW_SCREENS.includes(current)) return false;
  ctx.logger.warn(label, `TikTok đang kẹt ở ${current} — reset trước khi chạy job`);
  await restartTikTokToMain(ctx, `Kẹt ${current}`);
  return true;
}

async function recoverToMain(ctx, maxBack = 8) {
  let lastScreen = null;
  let sameScreenCount = 0;

  for (let i = 0; i < maxBack; i += 1) {
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    const { xml, screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    if (ui.MAIN_SCREENS.includes(current)) {
      ctx.setScreenState(current);
      return current;
    }

    if (ui.findInXml(xml, 'home_tab')) {
      try {
        await ui.tapElement(ctx.deviceId, 'home_tab', ctx.screen, {
          label: 'Trang chủ',
          fallbackZone: 'bottom_nav',
          logger: ctx.logger,
          required: false,
        });
        await human.think(1200, 2200);
        const { screen: afterHome } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
        if (ui.MAIN_SCREENS.includes(afterHome)) {
          ctx.setScreenState(afterHome);
          return afterHome;
        }
      } catch (_) {
        // fall through to Back
      }
    }

    if (current === lastScreen) {
      sameScreenCount += 1;
      if (sameScreenCount >= 3) {
        return restartTikTokToMain(ctx, `Back không thoát được ${current}`);
      }
    } else {
      sameScreenCount = 0;
    }
    lastScreen = current;

    ctx.logger.warn('recover', `Thoát màn ${current} (Back ${i + 1}/${maxBack})`);
    await adb.adb(ctx.deviceId, 'shell input keyevent 4', { ignoreError: true });
    await human.think(900, 1600);
  }

  const { screen: stuckOn } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (!ui.MAIN_SCREENS.includes(stuckOn)) {
    return restartTikTokToMain(ctx, `Vẫn kẹt ở ${stuckOn}`);
  }

  return stuckOn;
}

async function ensureScreen(ctx, expected, timeout = 18000) {
  try {
    const result = await ui.waitForScreen(ctx.deviceId, ctx.screen, expected, {
      timeout,
      logger: ctx.logger,
      onAbort: () => ctx.checkAborted(),
    });
    ctx.setScreenState(result.screen);
    return result;
  } catch (err) {
    if (err.code === 'CANCELLED' || err.code === 'WORKER_TIMEOUT') throw err;
    await ctx.fail(err.message, err.code || 'WRONG_SCREEN', ctx.currentStep, {
      expected,
      actual: err.actual,
    });
  }
}

async function stepCheckDevice(ctx) {
  await ctx.runStep('check_device', async () => {
    if (ctx.job?.post_mode === POST_MODES.ENGAGE || String(ctx.videoPath || '').startsWith('engage://')) {
      await ctx.fail('Job treo tương tác không được chạy pipeline đăng video', 'WRONG_JOB_TYPE');
    }
    if (!adb.isDeviceOnline(ctx.deviceId)) {
      await ctx.fail('ADB device offline', 'DEVICE_OFFLINE');
    }
    const localVideo = path.isAbsolute(ctx.videoPath)
      ? ctx.videoPath
      : path.join(__dirname, ctx.videoPath);
    if (!fs.existsSync(localVideo)) {
      await ctx.fail(`Video không tồn tại: ${localVideo}`, 'VIDEO_NOT_FOUND');
    }
    ctx.localVideo = localVideo;
    ctx.localFingerprint = adb.getLocalVideoFingerprint(localVideo);
    ctx.logger.success(
      'check_device',
      `Màn hình ${ctx.screen.width}x${ctx.screen.height} | video ${ctx.localFingerprint.size} bytes`
    );
  });
}

async function stepWakeUnlock(ctx) {
  await ctx.runStep('wake_unlock', async () => {
    await adb.keepScreenOn(ctx.deviceId, true);
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await human.think(600, 1200);
  });
}

async function stepOpenTikTok(ctx) {
  await ctx.runStep('open_tiktok', async () => {
    const { ensureTikTokOpen } = require('./tiktok-preflight');
    await ensureTikTokOpen(ctx, { resetIfStuck: true, failOnLogin: false });
  });
}

async function stepSwitchAccount(ctx) {
  await ctx.runStep('switch_account', async () => {
    const accountSwitch = require('./account-switch');
    const target = accountSwitch.resolveTargetAccount(ctx);
    if (!target) {
      ctx.logger.step('switch_account', 'Không chỉ định TK — dùng tài khoản đang active');
      return;
    }

    try {
      const result = await accountSwitch.ensureAccount(ctx, target);
      ctx.activeAccount = result.account;
    } catch (err) {
      const code = err.code || 'ACCOUNT_SWITCH_FAILED';
      await ctx.fail(err.message, code, 'switch_account', err.meta || {});
    }
  });
}

async function stepPushVideo(ctx) {
  await ctx.runStep('push_video', async () => {
    ctx.updateStatus('pushing_video');
    const prepared = await adb.prepareJobVideo(ctx.deviceId, ctx.localVideo, ctx.jobId);
    ctx.remotePath = prepared.remotePath;
    ctx.remoteName = prepared.remoteName;
    ctx.videoName = prepared.remoteName;
    ctx.videoAlbum = prepared.album;
    ctx.logger.success(
      'push_video',
      `Đã push video job: ${prepared.remoteName} → ${prepared.remotePath}`
    );
  });
}

async function stepScanMedia(ctx) {
  await ctx.runStep('scan_media', async () => {
    let verified = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        ctx.logger.warn('scan_media', `MediaStore chưa sẵn sàng — scan lại (${attempt + 1}/5)`);
        await adb.scanMedia(ctx.deviceId, ctx.remotePath);
        await human.think(1500, 2800);
      } else {
        await human.think(1200, 2200);
      }

      verified = await adb.verifyJobVideo(
        ctx.deviceId,
        ctx.remotePath,
        ctx.remoteName,
        ctx.localFingerprint
      );
      if (verified.ok) break;
    }

    if (!verified.ok) {
      const reason = !verified.media
        ? 'MediaStore chưa thấy file'
        : verified.fileCount !== 1
          ? `Thư mục TikTokAuto có ${verified.fileCount} file (cần đúng 1)`
          : verified.fingerprint && !verified.fingerprint.ok
            ? `Size PC vs máy lệch ${verified.fingerprint.diff} bytes`
            : 'Không tính được vị trí video trong gallery';
      await ctx.fail(
        `Xác minh video thất bại: ${reason}`,
        'VIDEO_NOT_VERIFIED',
        'scan_media',
        verified
      );
    }

    ctx.videoTarget = {
      remotePath: verified.remotePath,
      remoteName: verified.remoteName,
      mediaId: verified.media.id,
      dateAdded: verified.media.dateAdded,
      size: verified.remoteFingerprint?.fileSize || verified.media.size,
      duration: verified.remoteFingerprint?.duration || verified.media.duration,
      album: ctx.videoAlbum || 'TikTokAuto',
      grid: verified.grid,
      fingerprint: verified.fingerprint,
    };
    ctx.videoMtime = verified.media.dateModified || verified.media.dateAdded;

    ctx.logger.success(
      'scan_media',
      `Video đã xác minh: ${verified.remoteName} | album index ${verified.grid.index + 1}/${verified.grid.total} | mediaId=${verified.media.id}`
    );
  });
}

async function stepDeliverVideo(ctx) {
  await ctx.runStep('deliver_video', async () => {
    ctx.updateStatus('selecting_video');
    try {
      const result = await delivery.deliverVideo(ctx, {
        ensureScreen: (expected, timeout) => ensureScreen(ctx, expected, timeout),
        recoverToMain: () => recoverToMain(ctx),
      });
      if (result?.screen) {
        ctx.setScreenState(result.screen);
      }
    } catch (err) {
      if (err.code === 'CANCELLED' || err.code === 'WORKER_TIMEOUT') throw err;
      if (err.code === 'NOT_LOGGED_IN') {
        await ctx.fail('TikTok chưa đăng nhập', 'NOT_LOGGED_IN', 'deliver_video');
      }
      if (err.code === 'VIDEO_NOT_VERIFIED' || err.code === 'VIDEO_NOT_IN_GALLERY' || err.code === 'VIDEO_AMBIGUOUS' || err.code === 'VIDEO_META_MISMATCH' || err.code === 'ALBUM_NOT_FOUND') {
        await ctx.fail(err.message, err.code, 'deliver_video', err.meta || {});
      }
      throw err;
    }
  });
}

async function stepClickNext(ctx) {
  await ctx.runStep('click_next', async () => {
    if (ctx.screenState === ui.SCREENS.POST_EDIT) {
      ctx.logger.step('click_next', 'Đã ở POST_EDIT — bỏ qua Next');
      return;
    }

    if (ctx.screenState !== ui.SCREENS.VIDEO_EDIT) {
      const { screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
      ctx.setScreenState(detected);
      if (detected === ui.SCREENS.POST_EDIT) return;
      if (detected !== ui.SCREENS.VIDEO_EDIT) {
        await ctx.fail(`Không ở màn edit video (${detected})`, 'WRONG_SCREEN', 'click_next');
      }
    }

    try {
      await ui.tapElement(ctx.deviceId, 'next', ctx.screen, {
        label: 'Next',
        fallbackZone: 'next_button',
        logger: ctx.logger,
      });
    } catch (_) {
      await ctx.fail('Không thấy nút Next', 'NO_NEXT_BUTTON', 'click_next');
    }

    await human.think(1500, 2800);

    const start = Date.now();
    while (Date.now() - start < 12000) {
      const { xml, screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
      if (detected === ui.SCREENS.POST_EDIT) {
        ctx.setScreenState(detected);
        return;
      }
      if (detected === ui.SCREENS.VIDEO_EDIT) {
        ctx.logger.warn('click_next', 'Vẫn ở VIDEO_EDIT sau Next — chờ thêm');
      }
      if (detected === ui.SCREENS.GALLERY) {
        await ctx.fail('Quay lại gallery sau Next — chọn video sai', 'VIDEO_NOT_IN_GALLERY', 'click_next');
      }
      await human.pause(800, 1200);
    }

    await ctx.fail('Không chuyển sang màn caption sau Next', 'NO_NEXT_BUTTON', 'click_next');
  });
}

async function stepClickNext2(ctx) {
  await ctx.runStep('click_next_2', async () => {
    if (ctx.screenState === ui.SCREENS.POST_EDIT) return;

    const { content: xml } = await adb.dumpUi(ctx.deviceId, 'click_next_2');
    const nextZone = screen.getZone(ctx.screen, 'next_button');
    if (!ui.findInXml(xml, 'next', { zone: nextZone })) return;

    ctx.logger.step('click_next_2', 'Bấm Next lần 2');
    await ui.tapElement(ctx.deviceId, 'next', ctx.screen, {
      label: 'Next 2',
      fallbackZone: 'next_button',
      logger: ctx.logger,
    });
    await human.think(1500, 2500);

    const { screen: nextScreen } = await ensureScreen(ctx, ui.SCREENS.POST_EDIT, 12000);
    ctx.setScreenState(nextScreen);
  });
}

async function stepInputCaption(ctx) {
  await ctx.runStep('input_caption', async () => {
    ctx.updateStatus('input_caption');

    if (ctx.screenState !== ui.SCREENS.POST_EDIT) {
      const { screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
      if (detected !== ui.SCREENS.POST_EDIT) {
        await ctx.fail(`Không ở màn nhập caption (${detected})`, 'WRONG_SCREEN', 'input_caption');
      }
      ctx.setScreenState(detected);
    }

    try {
      const normalized = await captionUtil.inputCaption(ctx.deviceId, ctx.caption, {
        logger: ctx.logger,
        ui,
        screen: ctx.screen,
      });
      ctx.normalizedCaption = normalized;
    } catch (err) {
      const code = err.code || 'CAPTION_INPUT_FAILED';
      await ctx.fail(err.message, code, 'input_caption');
    }

    ctx.logger.success('input_caption', `Caption: ${ctx.normalizedCaption}`);
    await human.think(800, 1600);
  });
}

async function confirmPostStarted(ctx, timeoutMs = 22000) {
  const start = Date.now();
  let leftFlowStreak = 0;

  while (Date.now() - start < timeoutMs) {
    ctx.checkAborted();
    await adb.wakeDevice(ctx.deviceId);
    const { content: xml } = await adb.dumpUi(ctx.deviceId, 'post_confirm');
    if (!xml) {
      await human.pause(700, 1200);
      continue;
    }

    if (!adb.isTikTokUiXml(xml)) {
      if (Date.now() - start >= 3000) {
        ctx.sawPosting = true;
        return { started: true, via: 'left_app_after_post' };
      }
      await human.pause(700, 1200);
      continue;
    }

    const detected = ui.detectScreen(xml, ctx.screen);

    if (ui.findInXml(xml, 'error')) {
      await ctx.fail('Đăng video thất bại (dialog lỗi)', 'POST_FAILED', 'click_post');
    }

    if (ui.findInXml(xml, 'posting') || detected === ui.SCREENS.POSTING) {
      ctx.sawPosting = true;
      return { started: true, via: 'posting_ui' };
    }

    if (ui.findInXml(xml, 'upload_success')) {
      ctx.sawPosting = true;
      return { started: true, via: 'success_toast_early' };
    }

    const postVisible = ui.findPostButton(xml, ctx.screen);
    const notInFlow = !ui.isStillInPublishFlow(xml, ctx.screen);
    const inMain = ui.MAIN_SCREENS.includes(detected);

    if (notInFlow && inMain && !postVisible) {
      leftFlowStreak += 1;
      if (leftFlowStreak >= 2 && Date.now() - start >= 2000) {
        ctx.sawPosting = true;
        return { started: true, via: 'fast_complete' };
      }
    } else {
      leftFlowStreak = 0;
    }

    await human.pause(700, 1200);
  }

  return { started: false };
}

async function stepClickPost(ctx) {
  await ctx.runStep('click_post', async () => {
    ctx.updateStatus('posting');
    const postZone = screen.getZone(ctx.screen, 'post_button');
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { xml, screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
      const postNode = ui.findPostButton(xml, ctx.screen);
      const onPostScreen = detected === ui.SCREENS.POST_EDIT
        || detected === ui.SCREENS.POSTING
        || Boolean(postNode);
      if (!onPostScreen) {
        await ctx.fail(`Không ở màn đăng (${detected})`, 'WRONG_SCREEN', 'click_post');
      }
      if (!postNode) {
        await ctx.fail('Không thấy nút Post/Đăng', 'NO_POST_BUTTON', 'click_post');
      }

      ctx.logger.step('click_post', `Bấm Post/Đăng (lần ${attempt + 1}/${maxAttempts})`);
      try {
        await ui.tapElement(ctx.deviceId, 'post', ctx.screen, {
          label: 'Post/Đăng',
          fallbackZone: 'post_button',
          logger: ctx.logger,
        });
      } catch (_) {
        await ctx.fail('Không thấy nút Post/Đăng', 'NO_POST_BUTTON', 'click_post');
      }

      await human.think(1200, 2200);
      const confirm = await confirmPostStarted(ctx);
      if (confirm.started) {
        ctx.postConfirmVia = confirm.via;
        ctx.logger.success('click_post', `Post đã khởi chạy (${confirm.via})`);
        return;
      }

      ctx.logger.warn('click_post', `Chưa thấy posting sau tap — thử lại (${attempt + 2}/${maxAttempts})`);
      await human.think(800, 1500);
    }

    await ctx.fail('Post không khởi chạy sau 3 lần bấm', 'POST_NOT_STARTED', 'click_post');
  });
}

async function stepWaitResult(ctx) {
  await ctx.runStep('wait_result', async () => {
    await human.think(2000, 4000);

    const start = Date.now();
    const timeout = 120000;
    let sawPosting = ctx.sawPosting;
    let postingPollCount = ctx.postConfirmVia === 'posting_ui' ? 1 : 0;
    let wasPostingLastPoll = false;
    const postConfirmVia = ctx.postConfirmVia;

    while (Date.now() - start < timeout) {
      ctx.checkAborted();
      const elapsedMs = Date.now() - start;
      const { xml, screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);

      if (!xml) {
        ctx.logger.warn('wait_result', 'UI dump trống — thử lại');
        await human.pause(1500, 2500);
        continue;
      }

      if (ui.findInXml(xml, 'error')) {
        await ctx.fail('Đăng video thất bại', 'POST_FAILED', 'wait_result');
      }

      const isPostingNow = ui.findInXml(xml, 'posting') || detected === ui.SCREENS.POSTING;
      const postingEnded = wasPostingLastPoll && !isPostingNow && sawPosting;
      wasPostingLastPoll = isPostingNow;

      if (isPostingNow) {
        sawPosting = true;
        postingPollCount += 1;
        await human.pause(2000, 3500);
        continue;
      }

      const verdict = resultVerifier.evaluatePublishState(xml, ctx.screen, {
        sawPosting,
        postingPollCount,
        postingEnded,
        postConfirmVia,
        elapsedMs,
      });
      if (verdict.sawPosting) sawPosting = true;
      if (verdict.postingPollCount != null) {
        postingPollCount = verdict.postingPollCount;
      }

      if (verdict.ok) {
        const shot = await adb.screenshot(ctx.deviceId, 'success');
        ctx.logger.artifact('wait_result', 'Đăng thành công', shot, 'screenshot');
        ctx.logger.success(
          'wait_result',
          `Xác nhận đăng thành công (${verdict.screen}) via ${verdict.via || 'default'}`
        );
        return shot;
      }

      if (verdict.code === 'POST_STILL_VISIBLE' && elapsedMs > 20000 && elapsedMs < 55000) {
        ctx.logger.warn('wait_result', 'Nút Post vẫn hiện — thử bấm Post lại');
        try {
          await ui.tapElement(ctx.deviceId, 'post', ctx.screen, {
            label: 'Post retry',
            fallbackZone: 'post_button',
            logger: ctx.logger,
            required: false,
          });
          const retry = await confirmPostStarted(ctx, 10000);
          if (retry.started) {
            sawPosting = true;
            ctx.postConfirmVia = retry.via;
          }
        } catch (_) {
          // continue polling
        }
      }

      if (verdict.code === 'POST_NOT_STARTED' && elapsedMs > 30000 && !sawPosting) {
        await ctx.fail('Post không khởi chạy — chưa thấy trạng thái posting', 'POST_NOT_STARTED', 'wait_result');
      }

      await human.pause(2000, 3500);
    }

    await ctx.fail('Post bị kẹt / timeout 120s', 'POST_STUCK', 'wait_result');
  });
}

const STEP_PIPELINE_AUTO = [
  stepCheckDevice,
  stepWakeUnlock,
  stepOpenTikTok,
  stepSwitchAccount,
  stepPushVideo,
  stepScanMedia,
  stepDeliverVideo,
  stepClickNext,
  stepClickNext2,
  stepInputCaption,
  stepClickPost,
  stepWaitResult,
];

const STEP_PIPELINE_MANUAL = [
  stepCheckDevice,
  stepWakeUnlock,
  stepOpenTikTok,
  stepSwitchAccount,
  stepPushVideo,
  stepScanMedia,
];

const STEP_PIPELINE = STEP_PIPELINE_AUTO;

function getPipelineForJob(job) {
  return job?.post_mode === POST_MODES.MANUAL ? STEP_PIPELINE_MANUAL : STEP_PIPELINE_AUTO;
}

async function startJob(job, callbacks = {}) {
  if (job?.post_mode === POST_MODES.ENGAGE) {
    return {
      success: false,
      error: 'Job engage phải chạy qua startEngagementJob',
      error_code: 'WRONG_JOB_TYPE',
      status: 'failed',
      failed_step: 'flow',
    };
  }

  const ctx = createContext(job, callbacks);
  const pipeline = getPipelineForJob(job);
  const isManual = ctx.postMode === POST_MODES.MANUAL;
  let publishSucceeded = false;

  try {
    ctx.logger.step('flow', isManual
      ? 'Chế độ: Chuẩn bị đăng thủ công (push + verify)'
      : 'Chế độ: Tự động đăng TikTok (full pipeline)');

    for (const stepFn of pipeline) {
      await stepFn(ctx);
    }

    const shot = await adb.screenshot(ctx.deviceId, isManual ? 'ready_manual' : 'done');

    if (isManual) {
      ctx.updateStatus('ready_manual', { screenshot: shot });
      ctx.logger.success(
        'ready_manual',
        `Video sẵn sàng trên máy: /sdcard/TikTokAuto/${ctx.remoteName} — mở TikTok đăng thủ công`
      );
      return {
        success: true,
        status: 'ready_manual',
        screenshot: shot,
        postMode: POST_MODES.MANUAL,
        remotePath: ctx.remotePath,
        remoteName: ctx.remoteName,
        caption: ctx.caption,
        mediaId: ctx.videoTarget?.mediaId,
      };
    }

    publishSucceeded = true;
    ctx.updateStatus('done', { screenshot: shot });
    ctx.logger.success('done', 'Job hoàn thành — đã đăng TikTok tự động');
    return {
      success: true,
      screenshot: shot,
      caption: ctx.normalizedCaption,
      deliveryMethod: ctx.deliveryMethod,
      postMode: POST_MODES.AUTO,
    };
  } catch (err) {
    const shot = err.screenshot || await adb.screenshot(ctx.deviceId, 'error');
    const code = err.code || 'UNKNOWN_ERROR';
    const message = err.message || 'Unknown error';
    const step = err.step || ctx.currentStep || 'unknown';

    ctx.logger.error(step, `FAILED [${code}]: ${message}`, {
      artifact_path: shot,
      artifact_type: 'screenshot',
      meta: err.meta,
    });

    const status = code === 'CANCELLED'
      ? 'failed'
      : (NEEDS_MANUAL_CODES.has(code) ? 'need_manual_check' : 'failed');

    ctx.updateStatus(status, { error: message, error_code: code, screenshot: shot });
    return { success: false, error: message, error_code: code, screenshot: shot, status, failed_step: step };
  } finally {
    if (publishSucceeded && ctx.remoteName && ctx.postMode !== POST_MODES.MANUAL) {
      await adb.clearOldVideo(ctx.deviceId, ctx.remoteName);
    }
    adb.clearMediaCache(ctx.deviceId);
  }
}

module.exports = {
  TikTokFlowError,
  POST_MODES,
  FLOW_STEPS,
  FLOW_STEPS_AUTO,
  FLOW_STEPS_MANUAL,
  startJob,
  createContext,
  STEP_PIPELINE,
  getPipelineForJob,
};
