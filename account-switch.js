const adb = require('./adb');
const human = require('./human');
const screen = require('./screen');
const ui = require('./ui-state');

const SKIP_NAME_RE = /follower|thích|follow|video|bài đăng|đã follow|lượt xem|số lượng|menu|chia sẻ|thêm người|trang chủ|cửa hàng|quay|hộp thư|hồ sơ|đăng|post/i;
const SKIP_ACCOUNT_ROW_RE = /thêm tài khoản|add account|đóng|close|hủy|cancel|quay lại|back/i;

function normalizeAccountName(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

function accountsMatch(a, b) {
  const left = normalizeAccountName(a);
  const right = normalizeAccountName(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function readProfileDisplayName(xml, screenProfile) {
  const headerZone = screen.getZone(screenProfile, 'profile_header');
  const candidates = ui.parseAllNodes(xml)
    .filter((node) => {
      const label = `${node.text || ''} ${node.desc || ''}`.trim();
      if (!label || label.length < 2) return false;
      if (SKIP_NAME_RE.test(label)) return false;
      if (/^\d+$/.test(String(node.text || '').trim())) return false;
      const inHeader = ui.nodeInZone(node, headerZone)
        || (node.y1 >= screenProfile.height * 0.04
          && node.y1 <= screenProfile.height * 0.13
          && node.x1 >= screenProfile.width * 0.2
          && node.x2 <= screenProfile.width * 0.85);
      return inHeader && Boolean(node.text || node.desc);
    })
    .sort((a, b) => {
      const aExact = a.text && a.text === a.desc ? 1 : 0;
      const bExact = b.text && b.text === b.desc ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return (b.text?.length || 0) - (a.text?.length || 0);
    });

  const pick = candidates[0];
  return pick?.text?.trim() || pick?.desc?.trim() || null;
}

function isAccountSwitcherOpen(xml, screenProfile) {
  return Boolean(
    ui.findInXml(xml, 'account_add')
    || ui.findInXml(xml, 'account_switch_title')
    || listAccountRows(xml, screenProfile).length >= 2
  );
}

function listAccountRows(xml, screenProfile) {
  return ui.parseAllNodes(xml)
    .filter((node) => {
      const label = `${node.text || ''} ${node.desc || ''}`.trim();
      if (!label || label.length < 2) return false;
      if (SKIP_ACCOUNT_ROW_RE.test(label)) return false;
      if (!node.clickable && !node.longClickable) return false;
      return node.y1 >= screenProfile.height * 0.18;
    })
    .map((node) => ({
      text: (node.text || node.desc || '').trim(),
      node,
    }));
}

async function openProfileTab(ctx) {
  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  await ui.tapElement(ctx.deviceId, 'profile_tab', ctx.screen, {
    label: 'Hồ sơ',
    fallbackZone: 'bottom_nav',
    logger: ctx.logger,
    required: false,
  });
  await human.think(1800, 2800);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { content: xml, screen: detected } = await ui.dumpAndDetect(ctx.deviceId, ctx.screen);
    if (detected === ui.SCREENS.PROFILE || ui.isProfileView(xml, ctx.screen)) {
      ctx.setScreenState(ui.SCREENS.PROFILE);
      return xml;
    }
    await human.think(700, 1200);
  }

  const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, 'account_profile', ctx.screen, 3);
  return xml;
}

async function readCurrentAccount(ctx) {
  const xml = await openProfileTab(ctx);
  return readProfileDisplayName(xml, ctx.screen);
}

function findDisplayNameNode(xml, screenProfile) {
  const headerZone = screen.getZone(screenProfile, 'profile_header');
  const candidates = ui.parseAllNodes(xml)
    .filter((node) => {
      const label = `${node.text || ''} ${node.desc || ''}`.trim();
      if (!label || SKIP_NAME_RE.test(label)) return false;
      return ui.nodeInZone(node, headerZone)
        || (node.y1 >= screenProfile.height * 0.04 && node.y1 <= screenProfile.height * 0.13);
    })
    .sort((a, b) => Number(b.clickable) - Number(a.clickable));

  return candidates[0] || null;
}

async function openAccountSwitcher(ctx) {
  let { content: xml } = await adb.dumpUi(ctx.deviceId, 'account_header');
  const headerZone = screen.getZone(ctx.screen, 'profile_header');
  const nameNode = findDisplayNameNode(xml, ctx.screen);

  if (nameNode) {
    ctx.logger.step('switch_account', `Mở danh sách TK — tap ${nameNode.text || nameNode.desc}`);
    await human.tapNode(ctx.deviceId, nameNode, { spread: 5 });
  } else {
    ctx.logger.step('switch_account', 'Mở danh sách TK — tap vùng tên');
    await human.tap(ctx.deviceId, headerZone.centerX, headerZone.centerY, { spread: 8 });
  }
  await human.think(1200, 2200);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    ({ content: xml } = await adb.dumpUi(ctx.deviceId, `account_sheet_${attempt}`));
    if (isAccountSwitcherOpen(xml, ctx.screen)) return xml;

    if (attempt === 1) {
      const menu = ui.findInXml(xml, 'profile_menu', { preferClickable: true });
      if (menu) {
        ctx.logger.step('switch_account', 'Thử Menu hồ sơ');
        await human.tapNode(ctx.deviceId, menu, { spread: 6 });
        await human.think(1000, 1800);
        continue;
      }
    }

    if (attempt === 2) {
      await human.tap(ctx.deviceId, headerZone.centerX, headerZone.centerY - 20, { spread: 10 });
      await human.think(1000, 1800);
      continue;
    }

    await human.think(700, 1200);
  }

  return null;
}

async function tapAccountInSwitcher(ctx, targetAccount) {
  const { content: xml } = await adb.dumpUi(ctx.deviceId, 'account_pick');
  const rows = listAccountRows(xml, ctx.screen);
  const match = rows.find((row) => accountsMatch(row.text, targetAccount));

  if (!match) {
    ctx.logger.warn('switch_account', `Không thấy TK "${targetAccount}" — có: ${rows.map((r) => r.text).join(', ') || '(trống)'}`);
    return false;
  }

  ctx.logger.step('switch_account', `Chọn tài khoản: ${match.text}`);
  await human.tapNode(ctx.deviceId, match.node, { spread: 6 });
  await human.think(2500, 4500);
  return true;
}

async function waitForAccount(ctx, targetAccount, timeoutMs = 18000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ctx.checkAborted) ctx.checkAborted();
    await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
    const xml = await openProfileTab(ctx);
    const current = readProfileDisplayName(xml, ctx.screen);
    if (accountsMatch(current, targetAccount)) {
      return current;
    }
    await human.pause(900, 1500);
  }
  return null;
}

function resolveTargetAccount(ctx) {
  const fromJob = ctx.job?.tiktok_account || ctx.tiktokAccount;
  if (fromJob && String(fromJob).trim()) return String(fromJob).trim();

  const db = require('./db');
  const device = db.getDevice(ctx.deviceId);
  if (device?.tiktok_account && String(device.tiktok_account).trim()) {
    return String(device.tiktok_account).trim();
  }
  return null;
}

async function ensureAccount(ctx, targetAccount) {
  const target = String(targetAccount || '').trim();
  if (!target) {
    return { switched: false, reason: 'no_target', account: null };
  }

  ctx.logger.step('switch_account', `Mục tiêu: ${target}`);
  const current = await readCurrentAccount(ctx);
  if (current && accountsMatch(current, target)) {
    ctx.logger.success('switch_account', `Đã đúng tài khoản: ${current}`);
    return { switched: false, account: current };
  }

  ctx.logger.step('switch_account', `Đang dùng: ${current || '?'} → chuyển sang ${target}`);
  const sheetXml = await openAccountSwitcher(ctx);
  if (!sheetXml) {
    const err = Object.assign(new Error('Không mở được danh sách tài khoản TikTok'), {
      code: 'ACCOUNT_SWITCH_FAILED',
    });
    throw err;
  }

  const tapped = await tapAccountInSwitcher(ctx, target);
  if (!tapped) {
    const err = Object.assign(new Error(`Không tìm thấy tài khoản "${target}" trong danh sách`), {
      code: 'ACCOUNT_NOT_FOUND',
      meta: { target, current },
    });
    throw err;
  }

  const after = await waitForAccount(ctx, target);
  if (!after) {
    const err = Object.assign(new Error(`Chuyển tài khoản sang "${target}" chưa xác nhận được`), {
      code: 'ACCOUNT_SWITCH_FAILED',
      meta: { target, current },
    });
    throw err;
  }

  ctx.logger.success('switch_account', `Đã chuyển sang: ${after}`);
  return { switched: true, account: after, previous: current };
}

module.exports = {
  normalizeAccountName,
  accountsMatch,
  resolveTargetAccount,
  readProfileDisplayName,
  ensureAccount,
};
