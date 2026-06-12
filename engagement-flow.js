const adb = require('./adb');
const screen = require('./screen');
const human = require('./human');
const ui = require('./ui-state');
const behavior = require('./engage-behavior');
const nav = require('./engage-nav');

const ENGAGE_VIDEO_PATH = 'engage://session';

const DEFAULT_CONFIG = {
  duration_minutes: parseFloat(process.env.ENGAGE_DURATION_MINUTES || '10'),
  like_ratio: parseFloat(process.env.ENGAGE_LIKE_RATIO || '0.55'),
  watch_min_sec: parseInt(process.env.ENGAGE_WATCH_MIN_SEC || '5', 10),
  watch_max_sec: parseInt(process.env.ENGAGE_WATCH_MAX_SEC || '22', 10),
  max_videos: parseInt(process.env.ENGAGE_MAX_VIDEOS || '40', 10),
  ...behavior.DEFAULT_BEHAVIOR,
};

const FLOW_STEPS_ENGAGE = [
  'check_device',
  'wake_unlock',
  'open_tiktok',
  'switch_account',
  'open_feed',
  'engage_loop',
];

class EngagementFlowError extends Error {
  constructor(message, code, screenshot = null, step = null, meta = {}) {
    super(message);
    this.name = 'EngagementFlowError';
    this.code = code;
    this.screenshot = screenshot;
    this.step = step;
    this.meta = meta;
  }
}

function parseEngageConfig(caption) {
  const config = { ...DEFAULT_CONFIG };
  if (!caption || !String(caption).trim()) return config;

  try {
    const parsed = JSON.parse(caption);
    if (typeof parsed.duration_minutes === 'number') config.duration_minutes = parsed.duration_minutes;
    if (typeof parsed.like_ratio === 'number') config.like_ratio = Math.min(1, Math.max(0, parsed.like_ratio));
    if (typeof parsed.watch_min_sec === 'number') config.watch_min_sec = parsed.watch_min_sec;
    if (typeof parsed.watch_max_sec === 'number') config.watch_max_sec = parsed.watch_max_sec;
    if (typeof parsed.max_videos === 'number') config.max_videos = parsed.max_videos;
    if (typeof parsed.profile_ratio === 'number') config.profile_ratio = parsed.profile_ratio;
    if (typeof parsed.comment_view_ratio === 'number') config.comment_view_ratio = parsed.comment_view_ratio;
    if (typeof parsed.comment_post_ratio === 'number') config.comment_post_ratio = parsed.comment_post_ratio;
    if (typeof parsed.comment_like_ratio === 'number') config.comment_like_ratio = parsed.comment_like_ratio;
    if (typeof parsed.pause_ratio === 'number') config.pause_ratio = parsed.pause_ratio;
    if (typeof parsed.passive_ratio === 'number') config.passive_ratio = parsed.passive_ratio;
    if (typeof parsed.max_actions_per_video === 'number') config.max_actions_per_video = parsed.max_actions_per_video;
    if (typeof parsed.min_action_gap_sec === 'number') config.min_action_gap_sec = parsed.min_action_gap_sec;
    if (typeof parsed.min_like_gap_sec === 'number') config.min_like_gap_sec = parsed.min_like_gap_sec;
  } catch (_) {
    // caption không phải JSON — dùng mặc định
  }

  if (config.watch_max_sec < config.watch_min_sec) {
    [config.watch_min_sec, config.watch_max_sec] = [config.watch_max_sec, config.watch_min_sec];
  }
  config.duration_minutes = Math.min(180, Math.max(1, config.duration_minutes));
  config.max_videos = Math.min(500, Math.max(1, config.max_videos));
  return { ...config, ...behavior.mergeBehaviorConfig(config) };
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
  };
}

function createEngageContext(job, callbacks) {
  const { device_id: deviceId, id: jobId, caption } = job;
  const logger = createJobLogger(jobId, deviceId, callbacks.onEvent);
  screen.clearProfile(deviceId);
  const screenProfile = screen.getScreenSize(deviceId);

  let currentStep = null;
  let screenState = ui.SCREENS.UNKNOWN;

  const ctx = {
    job,
    jobId,
    deviceId,
    caption,
    config: parseEngageConfig(caption),
    logger,
    screen: screenProfile,
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
      throw new EngagementFlowError('Job bị recover do worker timeout', 'WORKER_TIMEOUT', null, currentStep);
    }
    if (callbacks.isCancelled && callbacks.isCancelled()) {
      throw new EngagementFlowError('Job bị hủy bởi operator', 'CANCELLED', null, currentStep);
    }
    ctx.pulse();
  };

  ctx.runStep = async (stepName, fn) => {
    ctx.checkAborted();
    currentStep = stepName;
    logger.step(stepName, 'Bắt đầu bước');
    try {
      const result = await fn(ctx);
      ctx.pulse();
      return result;
    } catch (err) {
      if (err instanceof EngagementFlowError) throw err;
      const shot = await adb.screenshot(ctx.deviceId, 'engage_error');
      throw new EngagementFlowError(
        err.message,
        err.code || 'UNKNOWN_ERROR',
        shot,
        currentStep,
        err.meta || {}
      );
    }
  };

  ctx.fail = async (message, code, step = currentStep, meta = {}) => {
    const shot = await adb.screenshot(ctx.deviceId, `engage_fail_${step}`);
    throw new EngagementFlowError(message, code, shot, step, meta);
  };

  return ctx;
}

async function stepCheckDevice(ctx) {
  await ctx.runStep('check_device', async () => {
    if (!adb.isDeviceOnline(ctx.deviceId)) {
      await ctx.fail('ADB device offline', 'DEVICE_OFFLINE');
    }
    ctx.logger.success(
      'check_device',
      `Màn hình ${ctx.screen.width}x${ctx.screen.height} | treo ${ctx.config.duration_minutes}p · tim ${Math.round(ctx.config.like_ratio * 100)}% · profile ${Math.round(ctx.config.profile_ratio * 100)}% · cmt ${Math.round(ctx.config.comment_view_ratio * 100)}%`
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
    await ensureTikTokOpen(ctx, { resetIfStuck: true, failOnLogin: true });
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

async function requireFeed(ctx, maxAttempts = 8) {
  const ok = await nav.recoverToFeed(ctx, { maxAttempts, failOnLogin: true });
  if (!ok) {
    const { screen: stuck } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    await ctx.fail(`Không vào được feed TikTok — đang ${stuck}`, 'ENGAGE_FEED_LOST', 'open_feed', { actual: stuck });
  }
}

async function stepOpenFeed(ctx) {
  await ctx.runStep('open_feed', async () => {
    await adb.dismissNotificationShade(ctx.deviceId);
    await requireFeed(ctx);
    ctx.logger.success('open_feed', 'Đã vào feed For You');
  });
}

async function watchVideo(ctx, watchSec) {
  const totalMs = watchSec * 1000;
  const start = Date.now();
  let lastWake = Date.now();
  while (Date.now() - start < totalMs) {
    ctx.checkAborted();
    if (Date.now() - lastWake > 4000) {
      await adb.keepScreenOn(ctx.deviceId, true);
      await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
      lastWake = Date.now();
    }
    const chunk = Math.min(2500, totalMs - (Date.now() - start));
    await adb.sleep(chunk);
    ctx.pulse();
  }
}

function pickLikeTapTarget(xml, screenProfile) {
  const likeZone = screen.getZone(screenProfile, 'like_button');
  const nodes = ui.parseAllNodes(xml);
  const inZone = (n) => likeZone && ui.nodeInZone(n, likeZone);

  const railButtons = nodes
    .filter((n) => inZone(n) && n.clickable && /thích video|like video/i.test(n.desc || ''))
    .sort((a, b) => {
      const score = (node) => {
        let s = 0;
        if (/^thích video/i.test(node.desc)) s += 20;
        if (/\/fnf$/i.test(node.resourceId)) s += 10;
        return s;
      };
      return score(b) - score(a);
    });
  if (railButtons.length) return { node: railButtons[0], method: 'button' };

  const likeBtn = ui.findInXml(xml, 'like_button', { zone: likeZone, preferClickable: true });
  if (likeBtn?.clickable) return { node: likeBtn, method: 'button' };

  if (likeZone) {
    return {
      node: {
        centerX: likeZone.centerX,
        centerY: Math.round(likeZone.y1 + (likeZone.y2 - likeZone.y1) * 0.35),
      },
      method: 'zone_fallback',
    };
  }
  return null;
}

async function doubleTapFeedCenter(ctx) {
  const center = screen.getZone(ctx.screen, 'feed_center');
  const cx = center.centerX + human.randInt(-14, 14);
  const cy = center.centerY + human.randInt(-20, 20);
  await human.tap(ctx.deviceId, cx, cy, { spread: 4, postDelay: [50, 100] });
  await human.pause(human.randInt(70, 130), human.randInt(120, 200));
  await human.tap(ctx.deviceId, cx + human.randInt(-6, 6), cy + human.randInt(-6, 6), { spread: 3 });
}

async function verifyLikeApplied(ctx, method, beforeDesc = null) {
  await human.pause(600, 1200);
  for (let i = 0; i < 4; i += 1) {
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, `engage_like_verify_${i}`, ctx.screen, 3);
    if (xml && ui.isVideoLiked(xml, ctx.screen)) {
      return { liked: true, method };
    }
    const afterDesc = xml ? ui.readLikeDesc(xml, ctx.screen) : null;
    if (beforeDesc && afterDesc && afterDesc !== beforeDesc && /bỏ thích/i.test(afterDesc)) {
      return { liked: true, method: `${method}_desc` };
    }
    await human.pause(400, 800);
  }
  return { liked: false, method: `${method}_unverified` };
}

async function tryLikeVideo(ctx) {
  await adb.keepScreenOn(ctx.deviceId, true);
  await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
  if (!await nav.recoverToFeed(ctx, { maxAttempts: 3 })) {
    return { liked: false, method: 'not_on_feed' };
  }

  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
  const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, 'engage_like', ctx.screen);

  if (ui.isVideoLiked(xml, ctx.screen)) {
    return { liked: false, method: 'already_liked' };
  }

  const beforeDesc = ui.readLikeDesc(xml, ctx.screen);

  const target = pickLikeTapTarget(xml, ctx.screen);
  if (target) {
    await human.tapNode(ctx.deviceId, target.node, { spread: 5 });
    const result = await verifyLikeApplied(ctx, target.method, beforeDesc);
    if (result.liked) return result;
  }

  await doubleTapFeedCenter(ctx);
  let result = await verifyLikeApplied(ctx, 'double_tap', beforeDesc);
  if (result.liked) return result;

  if (target) {
    await human.tapNode(ctx.deviceId, target.node, { spread: 4 });
    return verifyLikeApplied(ctx, `${target.method}_retry`, beforeDesc);
  }

  return { liked: false, method: 'no_target' };
}

async function swipeNextVideo(ctx) {
  const x = Math.round(ctx.screen.width * (0.46 + human.rand() * 0.08));
  const y1 = Math.round(ctx.screen.height * (0.74 + human.rand() * 0.06));
  const y2 = Math.round(ctx.screen.height * (0.18 + human.rand() * 0.06));
  await human.swipe(ctx.deviceId, x, y1, x, y2, human.randInt(300, 520));
  await human.think(human.randInt(1100, 2600));
}

async function runHumanEngagement(ctx, plan, stats, pacer) {
  if (plan.passive) {
    if (plan.idlePause) await behavior.maybeIdlePause(ctx);
    return;
  }

  const runProfile = async (when) => {
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await pacer.waitBeforeAction(ctx);
    const pr = await behavior.tryVisitProfile(ctx);
    pacer.markAction();
    if (pr.visited) stats.profiles += 1;
    else stats.profile_skipped += 1;
    ctx.logger.step('engage_loop', `Profile ${when}: ${pr.visited ? 'ok' : pr.reason || 'skip'}`);
  };

  if (plan.profileEarly) await runProfile('early');
  if (plan.idlePause) await behavior.maybeIdlePause(ctx);

  if (plan.like) {
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await pacer.waitBeforeAction(ctx, { isLike: true });
    const likeResult = await tryLikeVideo(ctx);
    pacer.markAction({ isLike: likeResult.liked });
    if (likeResult.liked) {
      stats.liked += 1;
      ctx.logger.step('engage_loop', `❤ Video #${stats.watched} (${likeResult.method})`);
    } else {
      stats.skipped_like += 1;
      ctx.logger.warn('engage_loop', `Tim bỏ qua #${stats.watched}: ${likeResult.method}`);
    }
    await human.think(400, 1200);
  }

  if (plan.viewComments) {
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await pacer.waitBeforeAction(ctx);
    const cr = await behavior.tryBrowseComments(ctx, ctx.config, {
      postComment: plan.postComment,
      likeComment: plan.likeComment,
    });
    pacer.markAction({ isLike: cr.liked });
    if (cr.viewed) stats.comments_viewed += 1;
    else stats.comments_skipped += 1;
    if (cr.liked) stats.comment_likes += 1;
    if (cr.posted) stats.comments_posted += 1;
  }

  if (plan.profileLate) await runProfile('late');
}

async function stepEngageLoop(ctx) {
  await ctx.runStep('engage_loop', async () => {
    ctx.updateStatus('engaging');
    const { config } = ctx;
    const sessionEnd = Date.now() + config.duration_minutes * 60 * 1000;
    const stats = {
      watched: 0,
      liked: 0,
      skipped_like: 0,
      profiles: 0,
      profile_skipped: 0,
      comments_viewed: 0,
      comments_posted: 0,
      comments_skipped: 0,
      comment_likes: 0,
      passive_watches: 0,
      elapsed_ms: 0,
    };
    const pacer = behavior.createActionPacer(config);

    ctx.logger.step(
      'engage_loop',
      `Treo kiểu người thật: ${config.duration_minutes}p / ${config.max_videos} video · tim ${Math.round(config.like_ratio * 100)}% · xem profile ${Math.round(config.profile_ratio * 100)}% · đọc cmt ${Math.round(config.comment_view_ratio * 100)}%`
    );

    while (Date.now() < sessionEnd && stats.watched < config.max_videos) {
      ctx.checkAborted();

      if (stats.watched > 0 && stats.watched % 5 === 0) {
        await nav.recoverToFeed(ctx, { maxAttempts: 4 });
      }

      const plan = behavior.planVideoEngagement(config);
      await watchVideo(ctx, plan.watchSec);
      stats.watched += 1;
      if (plan.passive) stats.passive_watches += 1;
      stats.elapsed_ms = Date.now() - (sessionEnd - config.duration_minutes * 60 * 1000);

      await runHumanEngagement(ctx, plan, stats, pacer);

      if (stats.watched >= config.max_videos || Date.now() >= sessionEnd) break;

      await swipeNextVideo(ctx);
      ctx.pulse();

      if (stats.watched % 4 === 0) {
        ctx.logger.step(
          'engage_loop',
          `Tiến độ: ${stats.watched} video · ${stats.liked} tim · ${stats.profiles} profile · ${stats.comments_viewed} đọc cmt · ${stats.comments_posted} gửi cmt`
        );
      }
    }

    ctx.engageStats = stats;
    ctx.logger.success(
      'engage_loop',
      `Hoàn tất: ${stats.watched} video (${stats.passive_watches} passive) · ${stats.liked} tim · ${stats.profiles} profile · ${stats.comments_viewed} đọc cmt · ${stats.comments_posted} gửi cmt`
    );
  });
}

async function startEngagementJob(job, callbacks = {}) {
  const ctx = createEngageContext(job, callbacks);

  try {
    ctx.logger.step('flow', 'Chế độ: Treo tương tác kiểu người thật (xem · profile · cmt · tim)');

    await stepCheckDevice(ctx);
    await stepWakeUnlock(ctx);
    await stepOpenTikTok(ctx);
    await stepSwitchAccount(ctx);
    await stepOpenFeed(ctx);
    await stepEngageLoop(ctx);

    const shot = await adb.screenshot(ctx.deviceId, 'engage_done');
    ctx.updateStatus('done', { screenshot: shot });
    return {
      success: true,
      status: 'done',
      screenshot: shot,
      stats: ctx.engageStats,
      config: ctx.config,
      postMode: 'engage',
    };
  } catch (err) {
    const shot = err.screenshot || await adb.screenshot(ctx.deviceId, 'engage_error');
    const code = err.code || 'UNKNOWN_ERROR';
    const message = err.message || 'Unknown error';
    const step = err.step || ctx.currentStep || 'unknown';

    ctx.logger.error(step, `FAILED [${code}]: ${message}`);

    const status = code === 'CANCELLED' ? 'failed' : 'failed';
    ctx.updateStatus(status, { error: message, error_code: code, screenshot: shot });
    return {
      success: false,
      error: message,
      error_code: code,
      screenshot: shot,
      status,
      failed_step: step,
    };
  }
}

module.exports = {
  EngagementFlowError,
  ENGAGE_VIDEO_PATH,
  FLOW_STEPS_ENGAGE,
  DEFAULT_CONFIG,
  parseEngageConfig,
  startEngagementJob,
};
