const adb = require('./adb');
const human = require('./human');
const ui = require('./ui-state');
const tiktokApp = require('./tiktok-app');

const STUCK_SCREENS = [
  ui.SCREENS.GALLERY,
  ui.SCREENS.VIDEO_EDIT,
  ui.SCREENS.POST_EDIT,
  ui.SCREENS.POSTING,
  ui.SCREENS.CREATE_SHEET,
  ui.SCREENS.KEYGUARD,
];

function isReadyScreen(xml, screenProfile, screenName) {
  if (screenName === ui.SCREENS.LOGIN) return false;
  if (ui.MAIN_SCREENS.includes(screenName)) return true;
  if (ui.isFeedScreen(xml, screenProfile)) return true;
  return false;
}

function needsColdStart(xml, screenProfile, screenName) {
  if (screenName === ui.SCREENS.KEYGUARD) return false;
  if (STUCK_SCREENS.includes(screenName)) return true;
  if (isReadyScreen(xml, screenProfile, screenName)) return false;
  return false;
}

async function coldStartTikTok(ctx, reason) {
  ctx.logger.warn('open_tiktok', `${reason} — force-stop và mở TikTok sạch`);
  await tiktokApp.forceStopTikTok(ctx.deviceId);
  await human.think(1200, 2000);
  await adb.wakeDevice(ctx.deviceId);
  await adb.dismissNotificationShade(ctx.deviceId);
  await tiktokApp.openTikTok(ctx.deviceId);
  await human.think(2800, 4200);
}

async function tapHomeTab(ctx) {
  try {
    await ui.tapElement(ctx.deviceId, 'home_tab', ctx.screen, {
      label: 'Trang chủ',
      fallbackZone: 'bottom_nav',
      logger: ctx.logger,
      required: false,
    });
    await human.think(1400, 2400);
    return true;
  } catch (_) {
    return false;
  }
}

async function tryCloseGallery(ctx) {
  const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, 'gallery_close', ctx.screen, 2);
  const closeNode = ui.findInXml(xml, 'gallery_close', { preferClickable: true });
  if (!closeNode) return false;
  ctx.logger.warn('open_tiktok', 'Đóng gallery/picker TikTok');
  await human.tapNode(ctx.deviceId, closeNode, { spread: 6 });
  await human.think(1200, 2200);
  return true;
}

async function recoverToHome(ctx, maxAttempts = 10) {
  let lastScreen = null;
  let sameScreenCount = 0;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (ctx.checkAborted) ctx.checkAborted();
    await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    const { xml, screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);

    if (isReadyScreen(xml, ctx.screen, current)) {
      ctx.setScreenState(current);
      return current;
    }

    if (current === ui.SCREENS.LOGIN) return null;

    if (current === ui.SCREENS.KEYGUARD) {
      await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen);
      continue;
    }

    if (current === ui.SCREENS.GALLERY) {
      const closed = await tryCloseGallery(ctx);
      if (closed) continue;
    }

    if (STUCK_SCREENS.includes(current)) {
      ctx.logger.warn('open_tiktok', `Kẹt ${current} — reset sạch`);
      await coldStartTikTok(ctx, `Kẹt ${current}`);
      lastScreen = null;
      sameScreenCount = 0;
      continue;
    }

    const tappedHome = await tapHomeTab(ctx);
    if (tappedHome) {
      const { xml: afterXml, screen: after } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
      if (isReadyScreen(afterXml, ctx.screen, after)) {
        ctx.setScreenState(after);
        return after;
      }
    }

    if (current === lastScreen) {
      sameScreenCount += 1;
      if (sameScreenCount >= 2) {
        await coldStartTikTok(ctx, `Back không thoát ${current}`);
        lastScreen = null;
        sameScreenCount = 0;
        continue;
      }
    } else {
      sameScreenCount = 0;
    }
    lastScreen = current;

    ctx.logger.warn('open_tiktok', `Thoát màn ${current} (Back ${i + 1}/${maxAttempts})`);
    await adb.adb(ctx.deviceId, 'shell input keyevent 4', { ignoreError: true });
    await human.think(900, 1600);
  }

  const { xml, screen: finalScreen } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
  if (isReadyScreen(xml, ctx.screen, finalScreen)) {
    ctx.setScreenState(finalScreen);
    return finalScreen;
  }
  return null;
}

/**
 * Bắt buộc đầu mọi job: mở TikTok ngầm, về Trang chủ/feed, rồi mới push video hoặc tương tác.
 */
async function ensureTikTokOpen(ctx, options = {}) {
  const { failOnLogin = false } = options;

  if (ctx.updateStatus) ctx.updateStatus('opening_app');

  await adb.keepScreenOn(ctx.deviceId, true);
  await adb.ensureDeviceAwake(ctx.deviceId, ctx.screen, { forceUnlock: true });

  let { xml, screen: current } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);

  if (current === ui.SCREENS.LOGIN && failOnLogin) {
    await ctx.fail('TikTok chưa đăng nhập — đăng nhập thủ công trước', 'NOT_LOGGED_IN', 'open_tiktok');
  }

  const tiktokForeground = await tiktokApp.isTikTokOpen(ctx.deviceId);

  if (!tiktokForeground) {
    await coldStartTikTok(ctx, 'TikTok chưa mở');
  } else if (needsColdStart(xml, ctx.screen, current)) {
    await coldStartTikTok(ctx, `Màn ${current} chưa sẵn sàng`);
  } else if (!isReadyScreen(xml, ctx.screen, current)) {
    ctx.logger.step('open_tiktok', `TikTok đang chạy — đưa lên foreground (màn ${current})`);
    await tiktokApp.bringTikTokToForeground(ctx.deviceId);
    await human.think(1400, 2400);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    const quickHome = await recoverToHome(ctx, 6);
    if (quickHome) {
      ctx.logger.success('open_tiktok', `TikTok sẵn sàng · màn ${quickHome}`);
      return { screen: quickHome };
    }
    await coldStartTikTok(ctx, `Không về Trang chủ từ ${current}`);
  } else {
    ctx.logger.step('open_tiktok', 'TikTok đang chạy — đưa lên foreground');
    await tiktokApp.bringTikTokToForeground(ctx.deviceId);
    await human.think(1800, 3000);
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  }

  try {
    await adb.waitFor(async () => tiktokApp.isTikTokOpen(ctx.deviceId), {
      timeout: 20000,
      interval: 1200,
      label: 'TikTok foreground',
    });
  } catch (_) {
    await tiktokApp.bringTikTokToForeground(ctx.deviceId);
    await human.think(2000, 3500);
  }

  let home = await recoverToHome(ctx);
  if (!home) {
    await coldStartTikTok(ctx, 'Không về được Trang chủ — thử lại');
    home = await recoverToHome(ctx);
  }

  if (!home) {
    const { screen: stuck } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    await ctx.fail(
      `Không mở được TikTok đúng màn hình — đang ${stuck}. Đóng TikTok thủ công rồi thử lại.`,
      'TIKTOK_NOT_READY',
      'open_tiktok',
      { actual: stuck }
    );
  }

  ctx.logger.success('open_tiktok', `TikTok sẵn sàng · màn ${home}`);
  return { screen: home };
}

module.exports = {
  STUCK_SCREENS,
  isReadyScreen,
  ensureTikTokOpen,
  recoverToHome,
};
