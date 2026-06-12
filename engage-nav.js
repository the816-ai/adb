const adb = require('./adb');
const screen = require('./screen');
const human = require('./human');
const ui = require('./ui-state');

const STUCK_SCREENS = [
  ui.SCREENS.GALLERY,
  ui.SCREENS.VIDEO_EDIT,
  ui.SCREENS.POST_EDIT,
  ui.SCREENS.POSTING,
  ui.SCREENS.CREATE_SHEET,
  ui.SCREENS.KEYGUARD,
];

async function tryCloseGallery(deviceId, screenProfile, logger) {
  const { content: xml } = await adb.dumpUiValidated(deviceId, 'gallery_close', screenProfile, 2);
  const closeNode = ui.findInXml(xml, 'gallery_close', { preferClickable: true });
  if (!closeNode) return false;
  if (logger) logger.warn('open_feed', 'Đóng gallery/picker');
  await human.tapNode(deviceId, closeNode, { spread: 6 });
  await human.think(1200, 2200);
  return true;
}

async function tapFeedTab(deviceId, screenProfile, logger) {
  const { content: xml } = await adb.dumpUiValidated(deviceId, 'engage_feed_tab', screenProfile, 2);
  const topZone = {
    x1: Math.round(screenProfile.width * 0.55),
    y1: Math.round(screenProfile.height * 0.03),
    x2: screenProfile.width,
    y2: Math.round(screenProfile.height * 0.14),
    centerX: Math.round(screenProfile.width * 0.78),
    centerY: Math.round(screenProfile.height * 0.08),
  };
  const feedNode = ui.findInXml(xml, 'feed_tab', { zone: topZone, preferClickable: true });
  if (!feedNode) return false;
  if (logger) logger.step('open_feed', 'Về tab Đề xuất');
  await human.tapNode(deviceId, feedNode, { spread: 6 });
  await human.think(1400, 2400);
  return true;
}

async function pressBack(deviceId, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await adb.adb(deviceId, 'shell input keyevent 4', { ignoreError: true });
    await human.think(650, 1200);
  }
}

async function swipeDownDismiss(deviceId, screenProfile) {
  const x = Math.round(screenProfile.width * (0.35 + human.rand() * 0.3));
  const y1 = Math.round(screenProfile.height * 0.28);
  const y2 = Math.round(screenProfile.height * 0.72);
  await human.swipe(deviceId, x, y1, x, y2, human.randInt(260, 380));
  await human.think(700, 1300);
}

async function tapHomeTab(deviceId, screenProfile, logger) {
  const { content: xml } = await adb.dumpUiValidated(deviceId, 'engage_home_tab', screenProfile, 2);
  const bottomNav = screen.getZone(screenProfile, 'bottom_nav');
  const homeNode = ui.findInXml(xml, 'home_tab', { zone: bottomNav, preferClickable: true });
  if (!homeNode) return false;
  if (logger) logger.step('open_feed', 'Về tab Trang chủ');
  await human.tapNode(deviceId, homeNode, { spread: 6 });
  await human.think(1400, 2400);
  return true;
}

async function recoverToFeed(ctx, options = {}) {
  const { maxAttempts = 8, logger = ctx.logger, failOnLogin = false } = options;

  for (let i = 0; i < maxAttempts; i += 1) {
    ctx.checkAborted();
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, logger);
    const { xml, screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);

    if (current === ui.SCREENS.KEYGUARD) {
      await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
      continue;
    }

    if (current === ui.SCREENS.LOGIN) {
      if (failOnLogin) {
        await ctx.fail('TikTok chưa đăng nhập', 'NOT_LOGGED_IN');
      }
      return false;
    }

    if (ui.isFeedScreen(xml, ctx.screen)) {
      ctx.setScreenState(current);
      return true;
    }

    if (ui.isCommentsPanel(xml, ctx.screen)) {
      if (logger) logger.warn('open_feed', 'Đóng panel bình luận');
      await swipeDownDismiss(ctx.deviceId, ctx.screen);
      await pressBack(ctx.deviceId, 1);
      continue;
    }

    if (ui.isProfileView(xml, ctx.screen)) {
      if (logger) logger.warn('open_feed', 'Thoát profile');
      await pressBack(ctx.deviceId, 1);
      continue;
    }

    if (current === ui.SCREENS.GALLERY) {
      const closed = await tryCloseGallery(ctx.deviceId, ctx.screen, logger);
      if (closed) continue;
    }

    if ([ui.SCREENS.VIDEO_EDIT, ui.SCREENS.POST_EDIT, ui.SCREENS.CREATE_SHEET, ui.SCREENS.POSTING].includes(current)) {
      if (logger) logger.warn('open_feed', `Thoát màn ${current}`);
      await pressBack(ctx.deviceId, 1);
      continue;
    }

    if (ui.MAIN_SCREENS.includes(current) || current === ui.SCREENS.UNKNOWN) {
      const tappedFeed = await tapFeedTab(ctx.deviceId, ctx.screen, logger);
      if (tappedFeed) continue;
      const tapped = await tapHomeTab(ctx.deviceId, ctx.screen, logger);
      if (tapped) continue;
    }

    if (STUCK_SCREENS.includes(current)) {
      if (logger) logger.warn('open_feed', `Kẹt ${current} — reset TikTok`);
      const tiktokApp = require('./tiktok-app');
      await tiktokApp.forceStopTikTok(ctx.deviceId);
      await human.think(1500, 2500);
      await tiktokApp.openTikTok(ctx.deviceId);
      await human.think(4000, 6000);
      continue;
    }

    if (logger) logger.warn('open_feed', `Không rõ màn ${current} — thử Trang chủ rồi Back (${i + 1}/${maxAttempts})`);
    await tapHomeTab(ctx.deviceId, ctx.screen, logger);
    await pressBack(ctx.deviceId, 1);
  }

  const { xml, screen: stuck } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (ui.isFeedScreen(xml, ctx.screen)) {
    ctx.setScreenState(stuck);
    return true;
  }
  return false;
}

module.exports = {
  pressBack,
  swipeDownDismiss,
  tapHomeTab,
  recoverToFeed,
};
