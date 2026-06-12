const adb = require('./adb');
const screen = require('./screen');
const human = require('./human');
const ui = require('./ui-state');
const nav = require('./engage-nav');

const COMMENT_TEMPLATES = [
  'Hay quá',
  'Xịn thật',
  'Đỉnh luôn',
  'Ưng ghê',
  'Chất quá',
  'Quá đã',
  '10 điểm',
  'Haha =))',
  'Ok luôn',
  'Quá hay',
  'Mê vid này',
  'Xem hoài không chán',
  'Ghiền',
  'Đúng gu',
  'Phải tim',
  'Có tâm',
  'Chill ghê',
  'Ổn áp',
  'Hay nha',
  'Thích thật',
];

const COMMENT_SUFFIX = ['', '', '', ' 🔥', ' ❤️', ' 👍', ' haizz', ' nhỉ', ' ạ'];

const DEFAULT_BEHAVIOR = {
  profile_ratio: parseFloat(process.env.ENGAGE_PROFILE_RATIO || '0.14'),
  comment_view_ratio: parseFloat(process.env.ENGAGE_COMMENT_VIEW_RATIO || '0.2'),
  comment_post_ratio: parseFloat(process.env.ENGAGE_COMMENT_POST_RATIO || '0.07'),
  comment_like_ratio: parseFloat(process.env.ENGAGE_COMMENT_LIKE_RATIO || '0.1'),
  pause_ratio: parseFloat(process.env.ENGAGE_PAUSE_RATIO || '0.12'),
  passive_ratio: parseFloat(process.env.ENGAGE_PASSIVE_RATIO || '0.18'),
  max_actions_per_video: parseInt(process.env.ENGAGE_MAX_ACTIONS_PER_VIDEO || '2', 10),
  min_action_gap_sec: parseFloat(process.env.ENGAGE_MIN_ACTION_GAP_SEC || '2.5'),
  min_like_gap_sec: parseFloat(process.env.ENGAGE_MIN_LIKE_GAP_SEC || '8'),
};

function clampRatio(v, fallback) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function mergeBehaviorConfig(config) {
  return {
    profile_ratio: clampRatio(config.profile_ratio, DEFAULT_BEHAVIOR.profile_ratio),
    comment_view_ratio: clampRatio(config.comment_view_ratio, DEFAULT_BEHAVIOR.comment_view_ratio),
    comment_post_ratio: clampRatio(config.comment_post_ratio, DEFAULT_BEHAVIOR.comment_post_ratio),
    comment_like_ratio: clampRatio(config.comment_like_ratio, DEFAULT_BEHAVIOR.comment_like_ratio),
    pause_ratio: clampRatio(config.pause_ratio, DEFAULT_BEHAVIOR.pause_ratio),
    passive_ratio: clampRatio(config.passive_ratio, DEFAULT_BEHAVIOR.passive_ratio),
    max_actions_per_video: Math.min(3, Math.max(1, parseInt(config.max_actions_per_video || DEFAULT_BEHAVIOR.max_actions_per_video, 10))),
    min_action_gap_sec: Math.max(1, parseFloat(config.min_action_gap_sec || DEFAULT_BEHAVIOR.min_action_gap_sec)),
    min_like_gap_sec: Math.max(3, parseFloat(config.min_like_gap_sec || DEFAULT_BEHAVIOR.min_like_gap_sec)),
  };
}

function chance(ratio) {
  return Math.random() < ratio;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = human.randInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickRandomComment() {
  const base = COMMENT_TEMPLATES[human.randInt(0, COMMENT_TEMPLATES.length - 1)];
  const suffix = COMMENT_SUFFIX[human.randInt(0, COMMENT_SUFFIX.length - 1)];
  return `${base}${suffix}`;
}

function planVideoEngagement(config) {
  const behavior = mergeBehaviorConfig(config);
  const watchSec = human.randInt(config.watch_min_sec, config.watch_max_sec);

  if (chance(behavior.passive_ratio)) {
    return {
      watchSec,
      passive: true,
      like: false,
      profileEarly: false,
      profileLate: false,
      viewComments: false,
      postComment: false,
      likeComment: false,
      idlePause: chance(behavior.pause_ratio),
      actionOrder: [],
    };
  }

  const pool = [];
  if (chance(config.like_ratio)) pool.push('like');
  if (chance(behavior.profile_ratio)) pool.push('profile');
  if (chance(behavior.comment_view_ratio)) pool.push('comments');

  const cap = human.randInt(1, behavior.max_actions_per_video);
  const picked = shuffle(pool).slice(0, Math.min(cap, pool.length));

  const hasProfile = picked.includes('profile');
  const profileEarly = hasProfile && chance(0.38);
  const profileLate = hasProfile && !profileEarly;
  const viewComments = picked.includes('comments');
  const postComment = viewComments && chance(
    Math.min(1, behavior.comment_post_ratio / Math.max(0.05, behavior.comment_view_ratio))
  );
  const likeComment = viewComments && !postComment && chance(
    Math.min(1, behavior.comment_like_ratio / Math.max(0.05, behavior.comment_view_ratio))
  );

  const actionOrder = [];
  if (profileEarly) actionOrder.push('profile');
  if (picked.includes('like')) actionOrder.push('like');
  if (viewComments) actionOrder.push('comments');
  if (profileLate) actionOrder.push('profile');
  if (chance(behavior.pause_ratio)) actionOrder.push('pause');

  return {
    watchSec,
    passive: false,
    like: picked.includes('like'),
    profileEarly,
    profileLate,
    viewComments,
    postComment,
    likeComment,
    idlePause: actionOrder.includes('pause'),
    actionOrder,
  };
}

function createActionPacer(config) {
  const behavior = mergeBehaviorConfig(config);
  let lastActionAt = 0;
  let lastLikeAt = 0;

  return {
    async waitBeforeAction(ctx, { isLike = false } = {}) {
      const now = Date.now();
      const gapMs = behavior.min_action_gap_sec * 1000;
      const since = now - lastActionAt;
      if (since < gapMs) {
        await adb.sleep(gapMs - since + human.randInt(200, 900));
      }
      if (isLike) {
        const likeGapMs = behavior.min_like_gap_sec * 1000;
        const sinceLike = Date.now() - lastLikeAt;
        if (sinceLike < likeGapMs) {
          await adb.sleep(likeGapMs - sinceLike + human.randInt(500, 1500));
        }
      }
      ctx.checkAborted();
    },
    markAction({ isLike = false } = {}) {
      const ts = Date.now();
      lastActionAt = ts;
      if (isLike) lastLikeAt = ts;
    },
  };
}

async function maybeIdlePause(ctx) {
  await human.think(human.randInt(900, 2800));
  ctx.pulse();
}

async function tryVisitProfile(ctx) {
  if (!await nav.recoverToFeed(ctx, { maxAttempts: 4 })) {
    return { visited: false, reason: 'not_on_feed' };
  }

  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, 'engage_profile', ctx.screen);
  const authorNode = ui.findFeedAuthor(xml, ctx.screen);

  if (!authorNode) {
    const avatarZone = screen.getZone(ctx.screen, 'feed_avatar') || screen.getZone(ctx.screen, 'feed_author');
    const nameZone = screen.getZone(ctx.screen, 'feed_author_name');
    if (nameZone) {
      ctx.logger.warn('engage_loop', 'Profile: tap tên tác giả (fallback)');
      await human.tap(ctx.deviceId, nameZone.centerX, nameZone.centerY, { spread: 14 });
    } else if (avatarZone) {
      ctx.logger.warn('engage_loop', 'Profile: zone avatar fallback');
      await human.tap(ctx.deviceId, avatarZone.centerX, avatarZone.centerY, { spread: 12 });
    } else {
      return { visited: false, reason: 'no_author' };
    }
  } else {
    ctx.logger.step('engage_loop', `Xem profile: ${authorNode.desc || authorNode.text || 'avatar'}`);
    await human.tapNode(ctx.deviceId, authorNode, { spread: 8 });
  }

  await human.think(1800, 3200);

  let onProfile = false;
  for (let i = 0; i < 5; i += 1) {
    const { content: profileXml } = await adb.dumpUiValidated(ctx.deviceId, `engage_profile_wait_${i}`, ctx.screen, 2);
    if (ui.isProfileView(profileXml, ctx.screen)) {
      onProfile = true;
      break;
    }
    await human.pause(450, 900);
  }

  if (!onProfile) {
    await nav.pressBack(ctx.deviceId, 1);
    await nav.recoverToFeed(ctx, { maxAttempts: 3 });
    return { visited: false, reason: 'not_opened' };
  }

  const scrolls = human.randInt(0, 2);
  for (let s = 0; s < scrolls; s += 1) {
    const x = Math.round(ctx.screen.width * (0.4 + human.rand() * 0.2));
    const y1 = Math.round(ctx.screen.height * (0.68 + human.rand() * 0.06));
    const y2 = Math.round(ctx.screen.height * (0.32 + human.rand() * 0.06));
    await human.swipe(ctx.deviceId, x, y1, x, y2);
    await human.think(1200, 2600);
  }

  await watchProfile(ctx, human.randInt(4, 11));
  await nav.pressBack(ctx.deviceId, 1);
  await human.think(900, 1600);
  await nav.recoverToFeed(ctx, { maxAttempts: 4 });
  return { visited: true, scrolls };
}

async function watchProfile(ctx, sec) {
  const totalMs = sec * 1000;
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    ctx.checkAborted();
    await adb.sleep(Math.min(2000, totalMs - (Date.now() - start)));
    ctx.pulse();
  }
}

async function openCommentsPanel(ctx) {
  if (!await nav.recoverToFeed(ctx, { maxAttempts: 3 })) {
    return false;
  }

  await ui.dismissPopups(ctx.deviceId, ctx.screen, ctx.logger);
  const { content: xml } = await adb.dumpUiValidated(ctx.deviceId, 'engage_comment_open', ctx.screen);
  const commentZone = screen.getZone(ctx.screen, 'comment_button');

  const btn = ui.findInXml(xml, 'comment_button', { zone: commentZone, preferClickable: true });
  if (btn) {
    await human.tapNode(ctx.deviceId, btn, { spread: 6 });
  } else if (commentZone) {
    ctx.logger.warn('engage_loop', 'Comment: zone fallback');
    await human.tap(ctx.deviceId, commentZone.centerX, commentZone.centerY, { spread: 10 });
  } else {
    return false;
  }

  await human.think(1500, 2800);

  for (let i = 0; i < 6; i += 1) {
    const { content: panelXml } = await adb.dumpUi(ctx.deviceId, `engage_comment_panel_${i}`);
    if (ui.isCommentsPanel(panelXml, ctx.screen)) return true;
    await human.pause(400, 800);
  }
  return false;
}

async function scrollComments(ctx, times = 2) {
  const x = Math.round(ctx.screen.width * (0.38 + human.rand() * 0.14));
  for (let i = 0; i < times; i += 1) {
    const y1 = Math.round(ctx.screen.height * (0.62 + human.rand() * 0.08));
    const y2 = Math.round(ctx.screen.height * (0.28 + human.rand() * 0.08));
    await human.swipe(ctx.deviceId, x, y1, x, y2, human.randInt(280, 440));
    await human.think(human.randInt(800, 2000));
  }
}

async function tryLikeRandomComment(ctx) {
  const { content: xml } = await adb.dumpUi(ctx.deviceId, 'engage_comment_like');
  const nodes = ui.parseAllNodes(xml);
  const commentZone = screen.getZone(ctx.screen, 'comments_list');
  const likeRail = screen.getZone(ctx.screen, 'like_button');

  const candidates = nodes.filter((n) => {
    if (!n.clickable) return false;
    if (likeRail && ui.nodeInZone(n, likeRail)) return false;
    if (n.centerX > ctx.screen.width * 0.84) return false;
    const blob = `${n.desc} ${n.text} ${n.resourceId}`.toLowerCase();
    if (!/^thích$|^like$/i.test((n.desc || n.text || '').trim()) && !/comment.*like/i.test(blob)) {
      return false;
    }
    if (commentZone && !ui.nodeInZone(n, commentZone)) return false;
    return n.centerY > ctx.screen.height * 0.18 && n.centerY < ctx.screen.height * 0.8;
  });

  if (!candidates.length) return { liked: false };

  const pick = candidates[human.randInt(0, Math.min(candidates.length - 1, 5))];
  await human.tapNode(ctx.deviceId, pick, { spread: 6 });
  await human.think(500, 1200);
  return { liked: true };
}

async function tryPostComment(ctx) {
  const text = pickRandomComment();
  const { content: xml } = await adb.dumpUi(ctx.deviceId, 'engage_comment_input');
  const inputZone = screen.getZone(ctx.screen, 'comment_input');

  let inputNode = ui.findInXml(xml, 'comment_input', { zone: inputZone })
    || ui.findInXml(xml, 'comment_input');

  if (inputNode) {
    await human.tapNode(ctx.deviceId, inputNode, { spread: 6 });
  } else if (inputZone) {
    await human.tap(ctx.deviceId, inputZone.centerX, inputZone.centerY, { spread: 12 });
  } else {
    return { posted: false, reason: 'no_input' };
  }

  await human.think(700, 1400);

  try {
    await human.pasteText(ctx.deviceId, text);
  } catch (err) {
    ctx.logger.warn('engage_loop', `Comment paste fail: ${err.message}`);
    await human.dismissKeyboard(ctx.deviceId, ctx.screen);
    return { posted: false, reason: 'paste_fail' };
  }

  await human.think(600, 1200);
  const { content: afterXml } = await adb.dumpUi(ctx.deviceId, 'engage_comment_send');
  const sendZone = screen.getZone(ctx.screen, 'comment_send');
  const sendNode = ui.findInXml(afterXml, 'comment_send', { zone: sendZone, preferClickable: true })
    || ui.findInXml(afterXml, 'comment_send', { preferClickable: true });

  if (sendNode) {
    await human.tapNode(ctx.deviceId, sendNode, { spread: 5 });
    await human.think(1400, 2400);
    ctx.logger.step('engage_loop', `💬 Comment: "${text}"`);
    return { posted: true, text };
  }

  await human.dismissKeyboard(ctx.deviceId, ctx.screen);
  return { posted: false, reason: 'no_send' };
}

async function tryBrowseComments(ctx, config, options = {}) {
  const opened = await openCommentsPanel(ctx);
  if (!opened) {
    return { viewed: false, reason: 'panel_not_opened' };
  }

  ctx.logger.step('engage_loop', 'Đọc bình luận...');
  await scrollComments(ctx, human.randInt(1, 3));
  await human.think(human.randInt(1800, 4200));

  const result = { viewed: true, liked: false, posted: false };

  if (options.likeComment) {
    const likeRes = await tryLikeRandomComment(ctx);
    result.liked = likeRes.liked;
    if (likeRes.liked) ctx.logger.step('engage_loop', '❤ Tim 1 bình luận');
  }

  if (options.postComment) {
    const postRes = await tryPostComment(ctx);
    result.posted = postRes.posted;
    if (postRes.posted) result.commentText = postRes.text;
  }

  await nav.swipeDownDismiss(ctx.deviceId, ctx.screen);
  await nav.pressBack(ctx.deviceId, 1);
  await nav.recoverToFeed(ctx, { maxAttempts: 4 });
  return result;
}

module.exports = {
  COMMENT_TEMPLATES,
  DEFAULT_BEHAVIOR,
  mergeBehaviorConfig,
  planVideoEngagement,
  createActionPacer,
  pickRandomComment,
  maybeIdlePause,
  tryVisitProfile,
  tryBrowseComments,
};
