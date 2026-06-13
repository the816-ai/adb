const adb = require('./adb');
const screen = require('./screen');
const human = require('./human');

const SCREENS = {
  MAIN: 'main',
  HOME: 'home',
  PROFILE: 'profile',
  CREATE_SHEET: 'create_sheet',
  GALLERY: 'gallery',
  VIDEO_EDIT: 'video_edit',
  POST_EDIT: 'post_edit',
  POSTING: 'posting',
  LOGIN: 'login',
  KEYGUARD: 'keyguard',
  UNKNOWN: 'unknown',
};

const MAIN_SCREENS = [SCREENS.MAIN, SCREENS.HOME, SCREENS.PROFILE];

/** Resource-id nghiêm cấm tap trên màn preview */
const FORBIDDEN_EDIT_RESOURCE_IDS = [
  /:id\/gyk$/i,
  /:id\/xhj$/i,
  /:id\/gy5$/i,
  /:id\/s5u$/i,
  /:id\/zkm$/i,
];

/** Nghiêm cấm tap theo nhãn trên màn preview */
const FORBIDDEN_EDIT_LABELS = [
  /autocut/i,
  /auto\s*cut/i,
  /tự động.*cắt/i,
  /^sửa$/i,
  /chỉnh\s*sửa/i,
  /hiệu\s*ứng/i,
  /\beffects?\b/i,
  /bộ\s*lọc/i,
  /\bfilters?\b/i,
  /nhãn\s*dán/i,
  /\bstickers?\b/i,
  /văn\s*bản/i,
  /\btext\b/i,
  /âm\s*thanh/i,
  /\bsound\b/i,
  /\bmusic\b/i,
  /nhạc\s*nền/i,
  /template/i,
  /\bmẫu\b/i,
  /cắt\s*ghép/i,
  /trim/i,
  /speed/i,
  /tốc\s*độ/i,
];

const MATCHERS = {
  login: [
    { field: 'text', regex: /^log in$/i },
    { field: 'text', regex: /^đăng nhập$/i },
    { field: 'text', regex: /^sign up$/i },
    { field: 'text', regex: /^đăng ký$/i },
  ],
  create: [
    { field: 'desc', regex: /^quay$/i },
    { field: 'desc', regex: /create|tạo/i },
    { field: 'text', regex: /^\+$/ },
    { field: 'resourceId', regex: /tab.*create|create.*tab|bottom.*create|shoot|nhl/i },
  ],
  profile_upload: [
    { field: 'text', regex: /^tải lên$/i },
    { field: 'resourceId', regex: /upload_work/i },
    { field: 'desc', regex: /^tải lên$/i },
  ],
  upload: [
    { field: 'text', regex: /^upload$/i },
    { field: 'text', regex: /^tải lên$/i },
    { field: 'desc', regex: /^upload$|^tải lên$/i },
  ],
  home_tab: [
    { field: 'text', regex: /trang chủ/i },
    { field: 'desc', regex: /trang chủ/i },
  ],
  feed_tab: [
    { field: 'text', regex: /^đề xuất$/i },
    { field: 'desc', regex: /^đề xuất$/i },
  ],
  gallery_close: [
    { field: 'desc', regex: /^đóng$/i },
    { field: 'text', regex: /^đóng$/i },
    { field: 'desc', regex: /^close$/i },
  ],
  gallery_picker: [
    { field: 'text', regex: /^chọn nhiều$/i },
    { field: 'desc', regex: /^chọn nhiều$/i },
  ],
  gallery_video_tab: [
    { field: 'text', regex: /^video$/i },
    { field: 'desc', regex: /^video$/i },
  ],
  profile_tab: [
    { field: 'text', regex: /^hồ sơ$/i },
    { field: 'desc', regex: /^hồ sơ$/i },
  ],
  profile_menu: [
    { field: 'desc', regex: /^menu hồ sơ$/i },
    { field: 'text', regex: /^menu$/i },
  ],
  account_add: [
    { field: 'text', regex: /^thêm tài khoản$/i },
    { field: 'text', regex: /^add account$/i },
    { field: 'desc', regex: /thêm tài khoản|add account/i },
  ],
  account_switch_title: [
    { field: 'text', regex: /chuyển.*tài khoản/i },
    { field: 'text', regex: /^switch account$/i },
    { field: 'desc', regex: /chuyển.*tài khoản|switch account/i },
  ],
  next: [
    { field: 'text', regex: /^next$/i },
    { field: 'text', regex: /^tiếp$/i },
    { field: 'text', regex: /^tiếp theo$/i },
    { field: 'desc', regex: /^next$|^tiếp$/i },
    { field: 'resourceId', regex: /:id\/osw|:id\/osz/i },
  ],
  post: [
    { field: 'text', regex: /^post$/i },
    { field: 'text', regex: /^đăng$/i },
    { field: 'desc', regex: /^post$|^đăng$|^publish$/i },
  ],
  caption: [
    { field: 'text', regex: /caption|mô tả|describe|thêm mô tả|nói gì đó/i },
    { field: 'desc', regex: /caption|mô tả|describe/i },
    { field: 'hint', regex: /caption|mô tả|describe|thêm mô tả/i },
    { field: 'resourceId', regex: /caption|description|desc|gl9|video_header_layout/i },
    { field: 'className', regex: /EditText/i },
  ],
  video_edit_screen: [
    { field: 'resourceId', regex: /video_record_gesture_layout/i },
    { field: 'resourceId', regex: /:id\/ad9$/i },
    { field: 'resourceId', regex: /:id\/osw$/i },
  ],
  edit_timeline: [
    { field: 'desc', regex: /thêm âm thanh/i },
    { field: 'text', regex: /thêm âm thanh/i },
  ],
  editor_next_arrow: [
    { field: 'resourceId', regex: /:id\/ad9$/i },
  ],
  post_edit_screen: [
    { field: 'resourceId', regex: /:id\/ryw|:id\/rz5/i },
  ],
  hashtag_button: [
    { field: 'text', regex: /^#?\s*hashtag$/i },
    { field: 'text', regex: /^hashtag$/i },
    { field: 'desc', regex: /hashtag/i },
    { field: 'resourceId', regex: /hashtag|tag.*btn|b4l/i },
  ],
  gallery: [
    { field: 'text', regex: /^album$/i },
    { field: 'text', regex: /^gallery$/i },
    { field: 'text', regex: /^thư viện$/i },
    { field: 'resourceId', regex: /gallery|album|media|picker/i },
  ],
  download_album: [
    { field: 'text', regex: /^download$/i },
    { field: 'text', regex: /^tải xuống$/i },
    { field: 'text', regex: /^downloads$/i },
    { field: 'desc', regex: /download|tải xuống/i },
  ],
  recents_album: [
    { field: 'text', regex: /^mới nhất$/i },
    { field: 'text', regex: /^recents$/i },
    { field: 'text', regex: /^gần đây$/i },
    { field: 'text', regex: /^tất cả$/i },
    { field: 'desc', regex: /mới nhất|recents|gần đây/i },
  ],
  job_album: [
    { field: 'text', regex: /^tiktokauto$/i },
    { field: 'text', regex: /^tiktok auto$/i },
    { field: 'desc', regex: /tiktokauto|tiktok auto/i },
    { field: 'text', regex: /^ttjob_/i },
    { field: 'desc', regex: /ttjob_/i },
  ],
  posting: [
    { field: 'text', regex: /^posting\.\.\.$/i },
    { field: 'text', regex: /^đang đăng/i },
    { field: 'text', regex: /^uploading/i },
    { field: 'text', regex: /^đang tải lên/i },
    { field: 'desc', regex: /posting|uploading|đang đăng|đang tải/i },
  ],
  error: [
    { field: 'text', regex: /^failed$/i },
    { field: 'text', regex: /^couldn't upload/i },
    { field: 'text', regex: /^không thể đăng/i },
    { field: 'text', regex: /^try again$/i },
    { field: 'text', regex: /^thử lại$/i },
    { field: 'text', regex: /^no internet/i },
    { field: 'text', regex: /^không có kết nối/i },
  ],
  popup_allow: [
    { field: 'text', regex: /^allow$/i },
    { field: 'text', regex: /^cho phép$/i },
    { field: 'text', regex: /^while using/i },
    { field: 'text', regex: /^khi sử dụng/i },
    { field: 'text', regex: /^đồng ý$/i },
  ],
  tiktok_share: [
    { field: 'text', regex: /chia sẻ lên tiktok/i },
    { field: 'desc', regex: /chia sẻ lên tiktok/i },
    { field: 'text', regex: /^tiktok$/i },
    { field: 'desc', regex: /^tiktok$/i },
  ],
  upload_success: [
    { field: 'text', regex: /đăng thành công|uploaded|your video is live|video đã được đăng/i },
    { field: 'desc', regex: /đăng thành công|uploaded|your video is live/i },
  ],
  share_video_tab: [
    { field: 'text', regex: /^video$/i },
    { field: 'desc', regex: /^video$/i },
  ],
  like_button: [
    { field: 'desc', regex: /^thích$/i },
    { field: 'desc', regex: /^like$/i },
    { field: 'text', regex: /^thích$/i },
    { field: 'text', regex: /^like$/i },
    { field: 'resourceId', regex: /\/fnw$|\/fmw$|\/fnf$/i },
    { field: 'resourceId', regex: /like|digg/i },
    { field: 'desc', regex: /thích video|like video/i },
  ],
  already_liked: [
    { field: 'desc', regex: /đã thích video|bỏ thích video|unlike video/i },
    { field: 'desc', regex: /bỏ thích|unlike|đã thích/i },
    { field: 'text', regex: /bỏ thích|unlike|đã thích/i },
    { field: 'resourceId', regex: /liked/i },
  ],
  comment_button: [
    { field: 'desc', regex: /đọc hoặc viết bình luận/i },
    { field: 'desc', regex: /bình luận/i },
    { field: 'desc', regex: /comments?/i },
    { field: 'text', regex: /bình luận/i },
    { field: 'text', regex: /comments?/i },
    { field: 'resourceId', regex: /comment_(icon|btn|button|count)|\/e_3$/i },
  ],
  comment_input: [
    { field: 'text', regex: /thêm bình luận|add comment|nhập bình luận/i },
    { field: 'desc', regex: /thêm bình luận|add comment|nhập bình luận/i },
    { field: 'resourceId', regex: /comment.*input|input.*comment/i },
  ],
  comment_send: [
    { field: 'text', regex: /^đăng$|^gửi$|^send$|^post$/i },
    { field: 'desc', regex: /^đăng$|^gửi$|^send$|^post$/i },
    { field: 'resourceId', regex: /send|publish|post/i },
  ],
  feed_author: [
    { field: 'resourceId', regex: /user_avatar/i },
    { field: 'desc', regex: /^hồ sơ\s/i },
    { field: 'resourceId', regex: /avatar|author.*head|user.*avatar/i },
    { field: 'desc', regex: /^ảnh đại diện$|^profile photo$/i },
  ],
  feed_author_name: [
    { field: 'resourceId', regex: /\/title$/i },
    { field: 'text', regex: /.{2,40}/ },
  ],
  profile_followers: [
    { field: 'text', regex: /followers|người theo dõi|đang follow|đã follow/i },
    { field: 'desc', regex: /followers|người theo dõi/i },
  ],
  profile_follow_btn: [
    { field: 'text', regex: /^follow$|^theo dõi$/i },
    { field: 'desc', regex: /^follow$|^theo dõi$/i },
  ],
  popup_dismiss: [
    { field: 'text', regex: /^not now$/i },
    { field: 'text', regex: /^để sau$/i },
    { field: 'text', regex: /^cancel$/i },
    { field: 'text', regex: /^hủy$/i },
    { field: 'text', regex: /^close$/i },
    { field: 'text', regex: /^đóng$/i },
    { field: 'text', regex: /^skip$/i },
    { field: 'text', regex: /^bỏ qua$/i },
  ],
};

function parseAllNodes(xml) {
  if (!xml) return [];
  const nodeRegex = /<node[^>]*>/g;
  const nodes = [];
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const tag = match[0];
    const text = (tag.match(/text="([^"]*)"/) || [])[1] || '';
    const desc = (tag.match(/content-desc="([^"]*)"/) || [])[1] || '';
    const hint = (tag.match(/hint="([^"]*)"/) || [])[1] || '';
    const resourceId = (tag.match(/resource-id="([^"]*)"/) || [])[1] || '';
    const className = (tag.match(/class="([^"]*)"/) || [])[1] || '';
    const bounds = (tag.match(/bounds="([^"]*)"/) || [])[1] || '';
    const clickable = tag.includes('clickable="true"');
    const focused = tag.includes('focused="true"');
    const selected = tag.includes('selected="true"');
    const checked = tag.includes('checked="true"');
    const parsed = adb.parseBounds(bounds);
    if (!parsed) continue;
    nodes.push({ text, desc, hint, resourceId, className, bounds, clickable, focused, selected, checked, ...parsed });
  }
  return nodes;
}

function nodeInZone(node, zone) {
  return node.centerX >= zone.x1 && node.centerX <= zone.x2
    && node.centerY >= zone.y1 && node.centerY <= zone.y2;
}

function findInXml(xml, matcherKey, options = {}) {
  const matchers = MATCHERS[matcherKey];
  if (!matchers) return null;
  const nodes = parseAllNodes(xml);
  const { zone, preferClickable = true, pick = 'first' } = options;

  let candidates = [];
  for (const matcher of matchers) {
    for (const node of nodes) {
      const value = node[matcher.field] || '';
      if (!matcher.regex.test(value)) continue;
      if (zone && !nodeInZone(node, zone)) continue;
      candidates.push({ ...node, matchedBy: matcher.field, score: scoreNode(node, matcher.field) });
    }
  }

  if (!candidates.length) return null;
  if (preferClickable) {
    const clickable = candidates.filter((n) => n.clickable);
    if (clickable.length) candidates = clickable;
  }

  if (pick === 'largest') {
    candidates.sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
  } else if (pick === 'top-left') {
    candidates.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  } else {
    candidates.sort((a, b) => b.score - a.score);
  }

  return candidates[0];
}

function scoreNode(node, matchedField) {
  let score = 0;
  if (node.clickable) score += 10;
  if (matchedField === 'text') score += 5;
  if (matchedField === 'desc') score += 4;
  if (matchedField === 'resourceId') score += 3;
  return score;
}

function scoreFeedAuthorNode(node, screenProfile) {
  const avatarZone = screen.getZone(screenProfile, 'feed_avatar') || screen.getZone(screenProfile, 'feed_author');
  const nameZone = screen.getZone(screenProfile, 'feed_author_name');
  const onRightRail = avatarZone && nodeInZone(node, avatarZone) && node.centerX > screenProfile.width * 0.8;
  const onNameRail = nameZone && nodeInZone(node, nameZone) && node.centerX < screenProfile.width * 0.75;

  if (!onRightRail && !onNameRail) return -1;

  const w = node.x2 - node.x1;
  const h = node.y2 - node.y1;
  const size = w * h;

  let score = 10;
  if (node.clickable) score += 8;

  if (onRightRail) {
    const squareish = Math.abs(w - h) < Math.max(20, w * 0.25);
    if (!squareish || size < 900 || size > 18000) return -1;
    if (/user_avatar/i.test(node.resourceId)) score += 20;
    if (/^hồ sơ\s/i.test(node.desc)) score += 16;
    if (/avatar|author|head/i.test(node.resourceId)) score += 10;
    score += Math.max(0, 18 - Math.abs(w - 72) / 4);
    return score;
  }

  if (/title/i.test(node.resourceId)) score += 18;
  if ((node.text || '').length >= 2 && (node.text || '').length <= 40) score += 8;
  if ((node.desc || '').length > 40) score -= 6;
  return score;
}

function findFeedAuthor(xml, screenProfile) {
  const avatarZone = screen.getZone(screenProfile, 'feed_avatar') || screen.getZone(screenProfile, 'feed_author');
  const fromMatcher = findInXml(xml, 'feed_author', { zone: avatarZone, preferClickable: true });
  if (fromMatcher && fromMatcher.centerX > screenProfile.width * 0.8) return fromMatcher;

  const nameZone = screen.getZone(screenProfile, 'feed_author_name');
  const nameNode = findInXml(xml, 'feed_author_name', { zone: nameZone, preferClickable: true });
  if (nameNode && nameNode.text && nameNode.text.length >= 2) return nameNode;

  const nodes = parseAllNodes(xml);
  const ranked = nodes
    .map((n) => ({ n, score: scoreFeedAuthorNode(n, screenProfile) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.n || null;
}

function hasFeedActionRail(xml, screenProfile) {
  const likeZone = screen.getZone(screenProfile, 'like_button');
  const commentZone = screen.getZone(screenProfile, 'comment_button');
  return Boolean(
    findInXml(xml, 'like_button', { zone: likeZone })
    || findInXml(xml, 'already_liked', { zone: likeZone })
    || findInXml(xml, 'comment_button', { zone: commentZone })
  );
}

function isProfileView(xml, screenProfile) {
  if (!xml) return false;
  if (isCommentsPanel(xml, screenProfile)) return false;
  if (hasFeedActionRail(xml, screenProfile)) return false;

  if (findInXml(xml, 'profile_follow_btn') && findInXml(xml, 'profile_followers')) return true;

  const detected = detectScreen(xml, screenProfile);
  if (detected === SCREENS.PROFILE && findInXml(xml, 'profile_follow_btn')) return true;

  const nodes = parseAllNodes(xml);
  const gridThumbs = nodes.filter((n) => {
    const w = n.x2 - n.x1;
    const h = n.y2 - n.y1;
    return w >= 55 && h >= 55 && n.y1 > screenProfile.height * 0.38 && n.y1 < screenProfile.height * 0.9;
  });
  return gridThumbs.length >= 6 && findInXml(xml, 'profile_follow_btn');
}

function isCommentsPanel(xml, screenProfile) {
  if (!xml) return false;
  if (hasFeedActionRail(xml, screenProfile)) return false;

  const inputZone = screen.getZone(screenProfile, 'comment_input');
  if (findInXml(xml, 'comment_input', { zone: inputZone })) return true;
  if (findInXml(xml, 'comment_input')) return true;

  const listZone = screen.getZone(screenProfile, 'comments_list');
  const nodes = parseAllNodes(xml);
  const replies = nodes.filter((n) => {
    const blob = `${n.text} ${n.desc}`.toLowerCase();
    if (!/trả lời|reply|phản hồi/i.test(blob)) return false;
    return listZone ? nodeInZone(n, listZone) : n.centerX < screenProfile.width * 0.82;
  });
  return replies.length >= 2;
}

function isFeedScreen(xml, screenProfile) {
  if (!xml) return false;
  if (isCommentsPanel(xml, screenProfile) || isProfileView(xml, screenProfile)) return false;

  const detected = detectScreen(xml, screenProfile);
  if (detected === SCREENS.LOGIN) return false;
  if ([SCREENS.GALLERY, SCREENS.VIDEO_EDIT, SCREENS.POST_EDIT, SCREENS.POSTING, SCREENS.CREATE_SHEET].includes(detected)) {
    return false;
  }
  if (!MAIN_SCREENS.includes(detected)) return false;
  return hasFeedActionRail(xml, screenProfile);
}

function isVideoLiked(xml, screenProfile) {
  const likeZone = screen.getZone(screenProfile, 'like_button');
  if (findInXml(xml, 'already_liked', { zone: likeZone })
    || findInXml(xml, 'already_liked', { preferClickable: true })) {
    return true;
  }

  const nodes = parseAllNodes(xml).filter((n) => likeZone && nodeInZone(n, likeZone));
  return nodes.some((n) => /đã thích video|bỏ thích video|unlike video/i.test(n.desc || ''));
}

function readLikeDesc(xml, screenProfile) {
  const likeZone = screen.getZone(screenProfile, 'like_button');
  const node = findInXml(xml, 'like_button', { zone: likeZone, preferClickable: true });
  return node?.desc || null;
}

function hasBottomNav(xml, screenProfile) {
  const bottomNav = screen.getZone(screenProfile, 'bottom_nav');
  return Boolean(
    findInXml(xml, 'create', { zone: bottomNav })
    || findInXml(xml, 'home_tab', { zone: bottomNav })
    || findInXml(xml, 'profile_tab', { zone: bottomNav })
  );
}

function detectScreen(xml, screenProfile) {
  if (!xml) return SCREENS.UNKNOWN;
  if (adb.isKeyguardUiXml(xml)) return SCREENS.KEYGUARD;
  if (findInXml(xml, 'login')) return SCREENS.LOGIN;
  if (findInXml(xml, 'posting')) return SCREENS.POSTING;

  const postZone = screen.getZone(screenProfile, 'post_button');
  const nextZone = screen.getZone(screenProfile, 'next_button');
  const captionZone = screen.getZone(screenProfile, 'caption_field');
  const bottomNav = screen.getZone(screenProfile, 'bottom_nav');

  const hasBottom = hasBottomNav(xml, screenProfile);
  const onFeed = hasFeedActionRail(xml, screenProfile);

  // Feed + bottom nav trước caption matcher — mô tả video trên feed hay match nhầm post_edit
  if (hasBottom && onFeed) {
    if (findInXml(xml, 'profile_upload')) return SCREENS.PROFILE;
    if (findInXml(xml, 'profile_tab', { zone: bottomNav })) return SCREENS.PROFILE;
    if (findInXml(xml, 'home_tab', { zone: bottomNav })) return SCREENS.HOME;
    if (findInXml(xml, 'create', { zone: bottomNav })) return SCREENS.MAIN;
    return SCREENS.MAIN;
  }

  if (findInXml(xml, 'post_edit_screen') && findPostButton(xml, screenProfile)) {
    return SCREENS.POST_EDIT;
  }
  if (findInXml(xml, 'video_edit_screen') && findInXml(xml, 'next', { zone: nextZone })) {
    return SCREENS.VIDEO_EDIT;
  }
  if (isAutocutEditorScreen(xml, screenProfile)) {
    return SCREENS.VIDEO_EDIT;
  }

  const hasPost = Boolean(findPostButton(xml, screenProfile));
  const hasCaptionInZone = findInXml(xml, 'caption', { zone: captionZone });
  const hasNextBottom = findInXml(xml, 'next', { zone: nextZone });

  const isMediaPicker = findInXml(xml, 'gallery_picker')
    || (findInXml(xml, 'recents_album') && findInXml(xml, 'gallery_video_tab'))
    || (findInXml(xml, 'gallery') && findInXml(xml, 'gallery_close'));
  if (isMediaPicker) return SCREENS.GALLERY;

  if (hasPost || (hasCaptionInZone && hasNextBottom)) return SCREENS.POST_EDIT;
  if (hasCaptionInZone) return SCREENS.POST_EDIT;
  if (hasNextBottom && !findInXml(xml, 'recents_album')) return SCREENS.VIDEO_EDIT;

  const nodes = parseAllNodes(xml);
  const galleryZone = screen.getZone(screenProfile, 'gallery_first');
  const thumbs = nodes.filter((n) => {
    const inGallery = nodeInZone(n, galleryZone) || (n.y1 < screenProfile.height * 0.55 && n.x1 < screenProfile.width * 0.65);
    const looksLikeMedia = /thumbnail|video|media|image|frame|gallery/i.test(n.resourceId + n.desc)
      || (n.clickable && (n.x2 - n.x1) > 60 && (n.y2 - n.y1) > 60);
    return inGallery && looksLikeMedia;
  });
  const hasGalleryHeader = findInXml(xml, 'gallery') || findJobAlbumTab(nodes);
  if (hasGalleryHeader && thumbs.length >= 2) return SCREENS.GALLERY;

  if (hasBottomNav(xml, screenProfile)) {
    if (findInXml(xml, 'profile_upload')) return SCREENS.PROFILE;
    if (findInXml(xml, 'profile_tab', { zone: bottomNav })) return SCREENS.PROFILE;
    if (findInXml(xml, 'home_tab', { zone: bottomNav })) return SCREENS.HOME;
    if (findInXml(xml, 'create', { zone: bottomNav })) return SCREENS.MAIN;
    return SCREENS.MAIN;
  }

  const createSheetUpload = findInXml(xml, 'upload');
  if (createSheetUpload) return SCREENS.CREATE_SHEET;

  return SCREENS.UNKNOWN;
}

function isStillInPublishFlow(xml, screenProfile) {
  const detected = detectScreen(xml, screenProfile);
  if ([SCREENS.POST_EDIT, SCREENS.VIDEO_EDIT, SCREENS.GALLERY, SCREENS.CREATE_SHEET, SCREENS.POSTING].includes(detected)) {
    return true;
  }
  if (findPostButton(xml, screenProfile)) return true;
  if (findInXml(xml, 'posting')) return true;
  return false;
}

function isPublishSuccess(xml, screenProfile, { sawPosting = false } = {}) {
  if (findInXml(xml, 'error')) return false;
  if (findInXml(xml, 'posting') || detectScreen(xml, screenProfile) === SCREENS.POSTING) return false;
  if (!sawPosting) return false;
  const detected = detectScreen(xml, screenProfile);
  if (detected === SCREENS.LOGIN) return false;
  if (isStillInPublishFlow(xml, screenProfile)) return false;
  if (findPostButton(xml, screenProfile)) return false;
  return MAIN_SCREENS.includes(detected);
}

async function dumpAndDetect(deviceId, screenProfile) {
  const { content, path: uiPath } = await adb.dumpUiValidated(deviceId, 'state', screenProfile);
  return { xml: content, uiPath, screen: detectScreen(content, screenProfile) };
}

async function dismissPopups(deviceId, screenProfile, logger) {
  const { content: xml } = await adb.dumpUiValidated(deviceId, 'popup', screenProfile, 2);
  if (!xml) return false;

  for (const key of ['popup_allow', 'popup_dismiss']) {
    const node = findInXml(xml, key, { preferClickable: true });
    if (node) {
      if (logger) logger.step('popup', `Đóng popup: ${node.text || node.desc}`);
      await human.tapNode(deviceId, node);
      await human.pause(800, 1500);
      return true;
    }
  }
  return false;
}

async function waitForScreen(deviceId, screenProfile, expected, options = {}) {
  const { timeout = 20000, logger, allowUnknown = false, onAbort } = options;
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (onAbort) onAbort();
    await dismissPopups(deviceId, screenProfile, logger);
    const { xml, screen: current } = await dumpAndDetect(deviceId, screenProfile);

    if (expectedList.includes(current)) {
      if (logger) logger.step('state', `Màn hình đúng: ${current}`);
      return { xml, screen: current };
    }

    if (allowUnknown && current === SCREENS.UNKNOWN && expectedList.includes(SCREENS.UNKNOWN)) {
      return { xml, screen: current };
    }

    if (current === SCREENS.LOGIN) {
      throw Object.assign(new Error('TikTok chưa đăng nhập'), { code: 'NOT_LOGGED_IN', screen: current });
    }

    await human.pause(800, 1500);
  }

  await dismissPopups(deviceId, screenProfile, logger);
  const { xml, screen: current } = await dumpAndDetect(deviceId, screenProfile);
  throw Object.assign(
    new Error(`Sai màn hình: cần ${expectedList.join('|')}, đang ${current}`),
    { code: 'WRONG_SCREEN', expected: expectedList, actual: current, xml }
  );
}

function findPostButton(xml, screenProfile) {
  const postZone = screen.getZone(screenProfile, 'post_button');
  const nextZone = screen.getZone(screenProfile, 'next_button');
  return findInXml(xml, 'post', { zone: postZone })
    || findInXml(xml, 'post', { zone: nextZone })
    || findInXml(xml, 'post');
}

function nodeLabel(node) {
  return `${node.text || ''} ${node.desc || ''} ${node.hint || ''}`.trim();
}

function isForbiddenEditNode(node) {
  if (FORBIDDEN_EDIT_RESOURCE_IDS.some((re) => re.test(node.resourceId || ''))) return true;
  const label = nodeLabel(node);
  if (!label) return false;
  return FORBIDDEN_EDIT_LABELS.some((re) => re.test(label));
}

function isInForbiddenEditZone(node, screenProfile) {
  const autocut = screen.getZone(screenProfile, 'autocut_button');
  const story = screen.getZone(screenProfile, 'story_button');
  const sidebar = screen.getZone(screenProfile, 'edit_sidebar');
  const toolbar = screen.getZone(screenProfile, 'editor_toolbar');
  if (autocut && nodeInZone(node, autocut)) return true;
  if (story && nodeInZone(node, story)) return true;
  if (sidebar && nodeInZone(node, sidebar)) return true;
  if (toolbar && nodeInZone(node, toolbar)) return true;
  return false;
}

function isAutocutEditorScreen(xml, screenProfile = null) {
  if (findEditorNextArrow(xml, screenProfile)) return true;
  if (findInXml(xml, 'edit_timeline')) return true;
  const nodes = parseAllNodes(xml);
  return nodes.some((n) => /:id\/ad9$/i.test(n.resourceId))
    || nodes.some((n) => /thêm âm thanh/i.test(`${n.desc} ${n.text}`));
}

function findEditorNextArrow(xml, screenProfile = null) {
  const nodes = parseAllNodes(xml);
  const direct = nodes.find((n) => /:id\/ad9$/i.test(n.resourceId) && n.clickable);
  if (direct) return direct;
  const sp = screenProfile || { width: 1080, height: 2340 };
  const topRight = nodes
    .filter((n) => n.clickable && n.centerY < sp.height * 0.14 && n.centerX > sp.width * 0.76)
    .sort((a, b) => b.centerX - a.centerX);
  return topRight[0] || null;
}

function getEditorArrowTapPoint(node, screenProfile) {
  if (node) {
    return { x: node.centerX, y: node.centerY };
  }
  const zone = screen.getZone(screenProfile, 'editor_next_arrow');
  // Mũi tên đỏ hồng — tap tâm vùng góc phải trên (ad9 ~990,175 trên 1080×2340)
  return {
    x: Math.round(zone.x1 + (zone.x2 - zone.x1) * 0.55),
    y: Math.round(zone.y1 + (zone.y2 - zone.y1) * 0.5),
  };
}

function resolveVideoEditTap(xml, screenProfile) {
  const arrow = findEditorNextArrow(xml, screenProfile);
  if (arrow) {
    return {
      kind: 'arrow',
      pt: getEditorArrowTapPoint(arrow, screenProfile),
      label: `mũi tên đỏ [${arrow.resourceId?.split('/').pop() || 'ad9'}]`,
    };
  }
  if (isAutocutEditorScreen(xml)) {
    const pt = getEditorArrowTapPoint(null, screenProfile);
    return { kind: 'arrow_fallback', pt, label: 'mũi tên đỏ (zone)' };
  }
  const tiepBtn = findTiepButton(xml, screenProfile);
  if (tiepBtn) {
    const safe = assertSafeNextTarget(tiepBtn, screenProfile);
    return {
      kind: 'tiep',
      pt: getTiepTapPoint(safe, screenProfile),
      label: `Tiếp [${safe.resourceId?.split('/').pop() || safe.text}]`,
    };
  }
  return null;
}

function findTiepButton(xml, screenProfile) {
  const nodes = parseAllNodes(xml);
  const nextZone = screen.getZone(screenProfile, 'next_button');

  const osw = nodes.find((n) => /:id\/osw$/i.test(n.resourceId) && n.clickable);
  if (osw && nodeInZone(osw, nextZone)) return osw;

  const osz = nodes.find((n) => /:id\/osz$/i.test(n.resourceId) && /^tiếp$/i.test(n.text || ''));
  if (osz && nodeInZone(osz, nextZone)) return osz;

  const candidates = collectNextCandidates(xml, screenProfile)
    .filter((n) => /^tiếp$/i.test(n.text || '') || /:id\/os[wz]$/i.test(n.resourceId || ''));
  return candidates[0] || null;
}

function getTiepTapPoint(node, screenProfile) {
  const nextZone = screen.getZone(screenProfile, 'next_button');
  if (node && /:id\/osw$/i.test(node.resourceId)) {
    const biasX = Math.round(node.x1 + (node.x2 - node.x1) * 0.62);
    const biasY = Math.round((node.y1 + node.y2) / 2);
    return { x: biasX, y: biasY };
  }
  if (node) {
    return { x: node.centerX, y: node.centerY };
  }
  const margin = Math.round(screenProfile.width * 0.03);
  return {
    x: nextZone.x2 - margin,
    y: nextZone.centerY,
  };
}

function assertSafeNextTarget(node, screenProfile) {
  if (!node) {
    throw Object.assign(new Error('Không có nút Tiếp an toàn'), { code: 'NO_NEXT_BUTTON' });
  }
  if (isForbiddenEditNode(node)) {
    throw Object.assign(
      new Error(`Nghiêm cấm tap chỉnh sửa: "${nodeLabel(node)}"`),
      { code: 'FORBIDDEN_EDIT_TAP', node: nodeLabel(node) }
    );
  }
  if (isInForbiddenEditZone(node, screenProfile)) {
    throw Object.assign(
      new Error(`Nút nằm vùng cấm (AutoCut/Sidebar): "${nodeLabel(node)}"`),
      { code: 'FORBIDDEN_EDIT_TAP', node: nodeLabel(node) }
    );
  }
  const nextZone = screen.getZone(screenProfile, 'next_button');
  if (nextZone && !nodeInZone(node, nextZone) && node.centerX < screenProfile.width * 0.55) {
    throw Object.assign(
      new Error('Nút Tiếp không ở góc phải — có thể là AutoCut'),
      { code: 'FORBIDDEN_EDIT_TAP', node: nodeLabel(node) }
    );
  }
  return node;
}

function collectNextCandidates(xml, screenProfile) {
  const matchers = MATCHERS.next;
  const nodes = parseAllNodes(xml);
  const nextZone = screen.getZone(screenProfile, 'next_button');
  const candidates = [];

  for (const matcher of matchers) {
    for (const node of nodes) {
      const value = node[matcher.field] || '';
      if (!matcher.regex.test(value)) continue;
      if (isForbiddenEditNode(node) || isInForbiddenEditZone(node, screenProfile)) continue;
      candidates.push({
        ...node,
        matchedBy: matcher.field,
        score: scoreNode(node, matcher.field),
        inNextZone: nextZone ? nodeInZone(node, nextZone) : false,
      });
    }
  }

  const clickable = candidates.filter((n) => n.clickable);
  const pool = clickable.length ? clickable : candidates;
  const inZone = pool.filter((n) => n.inNextZone);
  const shortlist = inZone.length ? inZone : pool.filter((n) => n.centerX >= screenProfile.width * 0.55);
  shortlist.sort((a, b) => b.centerX - a.centerX || b.score - a.score);
  return shortlist;
}

function findNextButton(xml, screenProfile) {
  return findTiepButton(xml, screenProfile);
}

function getNextButtonFallbackPoint(screenProfile) {
  return getTiepTapPoint(null, screenProfile);
}

async function skipVideoEditAndTapNext(deviceId, screenProfile, logger, { logStep = 'click_next' } = {}) {
  const deadline = Date.now() + 28000;
  let blindTried = 0;

  while (Date.now() < deadline) {
    const { content: xml, screen: current } = await dumpAndDetect(deviceId, screenProfile);
    if (current === SCREENS.POST_EDIT) return current;

    const onEdit = current === SCREENS.VIDEO_EDIT
      || isAutocutEditorScreen(xml, screenProfile)
      || findEditorNextArrow(xml, screenProfile)
      || findTiepButton(xml, screenProfile);

    if (!onEdit && current !== SCREENS.UNKNOWN) {
      throw Object.assign(
        new Error(`Không ở màn chỉnh/preview video (${current})`),
        { code: 'WRONG_SCREEN', actual: current }
      );
    }

    const action = resolveVideoEditTap(xml, screenProfile);
    if (action) {
      if (logger) {
        logger.step(logStep, `Bấm ${action.label} (${action.pt.x},${action.pt.y}) — cấm Sửa/AutoCut toolbar`);
      }
      await human.tap(deviceId, action.pt.x, action.pt.y, { spread: 0 });
      await human.think(action.kind.startsWith('arrow') ? 700 : 400, action.kind.startsWith('arrow') ? 1100 : 800);
      continue;
    }

    if (blindTried < 2 && (current === SCREENS.VIDEO_EDIT || current === SCREENS.UNKNOWN)) {
      const pts = [
        getEditorArrowTapPoint(null, screenProfile),
        getTiepTapPoint(null, screenProfile),
      ];
      const pt = pts[blindTried];
      blindTried += 1;
      if (logger) {
        logger.warn(logStep, `Chưa đọc được nút — thử tap blind #${blindTried} (${pt.x},${pt.y})`);
      }
      await human.tap(deviceId, pt.x, pt.y, { spread: 0 });
      await human.think(800, 1200);
      continue;
    }

    if (logger) logger.warn(logStep, 'Chưa thấy mũi tên đỏ / Tiếp — đợi UI load...');
    await human.pause(900, 1400);
  }

  const { screen: detected } = await dumpAndDetect(deviceId, screenProfile);
  if (detected === SCREENS.POST_EDIT) return detected;
  if (detected === SCREENS.GALLERY) {
    throw Object.assign(new Error('Quay lại gallery sau Tiếp'), { code: 'VIDEO_NOT_IN_GALLERY' });
  }
  throw Object.assign(
    new Error(`Không vào màn đăng sau Tiếp (đang ${detected})`),
    { code: 'NO_NEXT_BUTTON', actual: detected }
  );
}

async function tapElement(deviceId, matcherKey, screenProfile, options = {}) {
  const { label, fallbackZone, logger, required = true } = options;
  const zoneDef = fallbackZone ? screen.getZone(screenProfile, fallbackZone) : null;

  if (matcherKey === 'next') {
    const { content: xml } = await adb.dumpUiValidated(deviceId, 'find_next', screenProfile);
    let node = findTiepButton(xml, screenProfile);
    if (!node && zoneDef) {
      const pt = getTiepTapPoint(null, screenProfile);
      if (logger) logger.warn('ui', `${label || 'Next'}: fallback Tiếp (${pt.x},${pt.y}) — tránh AutoCut`);
      await human.tap(deviceId, pt.x, pt.y, { spread: 0 });
      return { fallback: true, zone: fallbackZone };
    }
    if (!node) {
      if (!required) return null;
      throw Object.assign(new Error(`Không tìm thấy: ${label || matcherKey}`), { code: 'UI_NOT_FOUND', matcherKey });
    }
    node = assertSafeNextTarget(node, screenProfile);
    const pt = getTiepTapPoint(node, screenProfile);
    if (logger) {
      logger.step('ui', `Tap ${label || matcherKey} (${pt.x},${pt.y}) [${node.resourceId?.split('/').pop() || node.text}]`);
    }
    await human.tap(deviceId, pt.x, pt.y, { spread: 0 });
    return node;
  }

  await dismissPopups(deviceId, screenProfile, logger);
  const { content: xml } = await adb.dumpUiValidated(deviceId, `find_${matcherKey}`, screenProfile);
  let node = matcherKey === 'post'
    ? findPostButton(xml, screenProfile)
    : findInXml(xml, matcherKey, { zone: zoneDef, pick: options.pick });

  if (!node) {
    node = findInXml(xml, matcherKey, { pick: options.pick });
  }

  if (!node && zoneDef) {
    if (logger) logger.warn('ui', `${label || matcherKey}: dùng zone fallback`);
    await human.tap(deviceId, zoneDef.centerX, zoneDef.centerY);
    return { fallback: true, zone: fallbackZone };
  }

  if (!node) {
    if (!required) return null;
    throw Object.assign(new Error(`Không tìm thấy: ${label || matcherKey}`), { code: 'UI_NOT_FOUND', matcherKey });
  }

  if (logger) {
    logger.step('ui', `Tap ${label || matcherKey} [${node.matchedBy}] ${node.text || node.desc || node.resourceId}`);
  }
  await human.tapNode(deviceId, node);
  return node;
}

async function findCaptionField(deviceId, screenProfile) {
  const { content: xml } = await adb.dumpUiValidated(deviceId, 'find_caption', screenProfile);
  const zoneDef = screen.getZone(screenProfile, 'caption_field');
  return findInXml(xml, 'caption', { zone: zoneDef, preferClickable: true })
    || findInXml(xml, 'caption', { preferClickable: true })
    || parseAllNodes(xml).find((n) => /EditText/i.test(n.className) && nodeInZone(n, zoneDef))
    || parseAllNodes(xml).find((n) => /:id\/gl9/i.test(n.resourceId));
}

async function findHashtagButton(deviceId, screenProfile) {
  const { content: xml } = await adb.dumpUi(deviceId, 'find_hashtag_btn');
  if (!xml) return null;
  const zoneDef = screen.getZone(screenProfile, 'hashtag_bar');
  return findInXml(xml, 'hashtag_button', { zone: zoneDef, preferClickable: true })
    || findInXml(xml, 'hashtag_button', { preferClickable: true });
}

function findHashtagSuggestion(xml, tagName) {
  if (!xml || !tagName) return null;
  const name = String(tagName).replace(/^#/, '');
  const hashTag = `#${name}`;
  const candidates = [
    { field: 'text', regex: new RegExp(`^${escapeRegex(hashTag)}\\b`, 'i') },
    { field: 'text', regex: new RegExp(`^${escapeRegex(name)}\\b`, 'i') },
    { field: 'desc', regex: new RegExp(escapeRegex(hashTag), 'i') },
  ];
  return adb.findNodeInXml(xml, candidates);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listGalleryThumbnails(nodes, screenProfile) {
  const galleryZone = screen.getZone(screenProfile, 'gallery_first');
  return nodes
    .filter((n) => {
      const sizeOk = (n.x2 - n.x1) >= 60 && (n.y2 - n.y1) >= 60;
      const inZone = nodeInZone(n, galleryZone)
        || (n.y1 >= screenProfile.height * 0.08 && n.y1 < screenProfile.height * 0.62
          && n.x1 < screenProfile.width * 0.98);
      const looksLikeMedia = /thumbnail|video|media|image|frame|gallery/i.test(n.resourceId + n.desc)
        || (n.clickable && sizeOk);
      return inZone && looksLikeMedia && sizeOk;
    })
    .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
}

function findJobAlbumTab(nodes) {
  const byMatcher = findInXmlFromNodes(nodes, 'job_album', { preferClickable: true });
  if (byMatcher) return byMatcher;

  return nodes.find((n) => {
    if (!n.clickable) return false;
    const blob = `${n.text} ${n.desc} ${n.resourceId}`.toLowerCase();
    return blob.includes('tiktokauto') || blob.includes('ttjob_');
  }) || null;
}

function findInXmlFromNodes(nodes, matcherKey, options = {}) {
  const matchers = MATCHERS[matcherKey];
  if (!matchers) return null;
  const { preferClickable = true } = options;
  let candidates = [];
  for (const matcher of matchers) {
    for (const node of nodes) {
      const value = node[matcher.field] || '';
      if (!matcher.regex.test(value)) continue;
      candidates.push({ ...node, matchedBy: matcher.field, score: scoreNode(node, matcher.field) });
    }
  }
  if (!candidates.length) return null;
  if (preferClickable) {
    const clickable = candidates.filter((n) => n.clickable);
    if (clickable.length) candidates = clickable;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

async function requireJobAlbum(deviceId, screenProfile, logger) {
  const tabY = Math.round(screenProfile.height * 0.12);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { content: xml } = await adb.dumpUiValidated(deviceId, `open_album_${attempt}`, screenProfile);
    const nodes = parseAllNodes(xml);
    const jobTab = findJobAlbumTab(nodes);

    if (jobTab) {
      if (logger) {
        logger.step(
          'select_video',
          `Mở album TikTokAuto [${jobTab.text || jobTab.desc || jobTab.resourceId}]`
        );
      }
      await human.tapNode(deviceId, jobTab);
      await human.think(1200, 2000);
      return 'TikTokAuto';
    }

    if (logger) logger.warn('select_video', `Chưa thấy album TikTokAuto — swipe tab (${attempt + 1}/8)`);
    await human.swipe(
      deviceId,
      Math.round(screenProfile.width * 0.82),
      tabY,
      Math.round(screenProfile.width * 0.18),
      tabY
    );
    await human.think(700, 1300);
  }

  throw Object.assign(
    new Error('Không tìm thấy album TikTokAuto trong gallery — từ chối chọn Recents/Download'),
    { code: 'ALBUM_NOT_FOUND', album: 'TikTokAuto' }
  );
}

async function selectVideo(deviceId, screenProfile, videoTarget, logger) {
  const target = typeof videoTarget === 'string'
    ? { remoteName: videoTarget }
    : (videoTarget || {});
  const { remoteName, remotePath } = target;

  await requireJobAlbum(deviceId, screenProfile, logger);

  let xml;
  let nodes;
  let thumbnails = [];
  const baseName = (remoteName || '').replace(/\.[^.]+$/, '');
  const ttjobToken = baseName.replace(/^ttjob_/, '').slice(0, 12);

  for (let loadTry = 0; loadTry < 6; loadTry += 1) {
    ({ content: xml } = await adb.dumpUiValidated(deviceId, `select_video_${loadTry}`, screenProfile));
    nodes = parseAllNodes(xml);
    thumbnails = listGalleryThumbnails(nodes, screenProfile);
    if (thumbnails.length > 0) break;
    if (logger) logger.warn('select_video', `Album TikTokAuto chưa load thumbnail (${loadTry + 1}/6)`);
    await human.think(1000, 1800);
  }

  const byName = nodes.find((n) => {
    const blob = `${n.text} ${n.desc} ${n.resourceId}`;
    return n.clickable && (
      (remoteName && blob.includes(remoteName))
      || (baseName && blob.includes(baseName))
      || (ttjobToken && blob.includes(ttjobToken))
    );
  });

  if (thumbnails.length !== 1) {
    throw Object.assign(
      new Error(
        `Album TikTokAuto phải có đúng 1 video, đang thấy ${thumbnails.length} thumbnail — từ chối chọn`
      ),
      {
        code: 'VIDEO_AMBIGUOUS',
        remoteName,
        remotePath,
        thumbCount: thumbnails.length,
      }
    );
  }

  if (byName) {
    if (logger) logger.step('select_video', `Chọn video theo tên UI: ${remoteName}`);
    await human.tapNode(deviceId, byName, { spread: 6 });
    return { method: 'name', node: byName, remoteName, thumbCount: thumbnails.length };
  }

  const gridIndex = target.grid?.index >= 0 ? target.grid.index : 0;
  const uiCell = screen.galleryGridFromThumbnails(thumbnails, gridIndex);
  if (uiCell) {
    if (logger) {
      logger.step(
        'select_video',
        `Chọn theo UI bounds [${uiCell.index + 1}/${uiCell.total}] tại (${uiCell.x},${uiCell.y}) cols=${uiCell.cols}`
      );
    }
    await human.tap(deviceId, uiCell.x, uiCell.y, { spread: 4 });
    return { method: 'ui_bounds', remoteName, thumbCount: thumbnails.length, grid: uiCell };
  }

  if (target.grid && target.grid.index >= 0) {
    const cols = target.grid.cols || 3;
    const cell = screen.galleryCellCenter(screenProfile, target.grid.index, cols);
    if (logger) {
      logger.step(
        'select_video',
        `Fallback grid index ${target.grid.index + 1}/${target.grid.total} tại (${cell.x},${cell.y})`
      );
    }
    await human.tap(deviceId, cell.x, cell.y);
    return { method: 'grid_fallback', remoteName, thumbCount: thumbnails.length, grid: target.grid };
  }

  const pick = thumbnails[0];
  if (logger) {
    logger.step('select_video', `Album TikTokAuto có 1 video — chọn: ${remoteName}`);
  }
  await human.tapNode(deviceId, pick, { spread: 5 });
  return { method: 'single_verified', node: pick, remoteName, thumbCount: 1 };
}

async function confirmShareChooser(deviceId, screenProfile, logger) {
  let acted = false;
  const { content: xml } = await adb.dumpUi(deviceId, 'share_chooser');
  const tiktokBtn = findInXml(xml, 'tiktok_share', { preferClickable: true });
  if (tiktokBtn) {
    if (logger) logger.step('share_to_tiktok', `Share sheet: ${tiktokBtn.text || tiktokBtn.desc}`);
    await human.tapNode(deviceId, tiktokBtn);
    await human.think(1200, 2200);
    acted = true;
  }

  const { content: xml2 } = await adb.dumpUi(deviceId, 'share_video_tab');
  const videoTab = findInXml(xml2, 'share_video_tab', { preferClickable: true });
  if (videoTab) {
    if (logger) logger.step('share_to_tiktok', 'Chọn tab Video (không phải Tin nhắn)');
    await human.tapNode(deviceId, videoTab);
    await human.think(1500, 2800);
    acted = true;
  }

  return acted;
}

async function pollEditScreenQuick(deviceId, screenProfile, timeout = 6000, onAbort = null) {
  const targets = [SCREENS.VIDEO_EDIT, SCREENS.POST_EDIT];
  const tiktokApp = require('./tiktok-app');
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (onAbort) onAbort();
    if (await tiktokApp.isTikTokOpen(deviceId)) {
      const { screen: current } = await dumpAndDetect(deviceId, screenProfile);
      if (targets.includes(current)) {
        return { ok: true, screen: current };
      }
    }
    await human.pause(450, 850);
  }
  return { ok: false };
}

async function waitForEditAfterShare(deviceId, screenProfile, logger, timeout = 18000, onAbort = null) {
  const targets = [SCREENS.VIDEO_EDIT, SCREENS.POST_EDIT];
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (onAbort) onAbort();
    await adb.dismissNotificationShade(deviceId);
    await dismissPopups(deviceId, screenProfile, logger);
    await confirmShareChooser(deviceId, screenProfile, logger);
    const { xml, screen: current } = await dumpAndDetect(deviceId, screenProfile);

    if (targets.includes(current)) {
      if (logger) logger.step('share_to_tiktok', `Share OK — màn hình: ${current}`);
      return { screen: current, xml };
    }

    if (current === SCREENS.LOGIN) {
      throw Object.assign(new Error('TikTok chưa đăng nhập'), { code: 'NOT_LOGGED_IN' });
    }

    await human.pause(500, 900);
  }

  const { screen: current } = await dumpAndDetect(deviceId, screenProfile);
  return { screen: current, timedOut: true };
}

async function verifyVideoMetadata(deviceId, videoTarget, localFingerprint, logger, options = {}) {
  const { remotePath, remoteName, mediaId, duration } = videoTarget || {};
  if (!remotePath || !localFingerprint) {
    return { ok: false, reason: 'missing_context' };
  }

  adb.clearMediaCache(deviceId);
  const remoteFp = await adb.getRemoteVideoFingerprint(deviceId, remotePath);
  const match = adb.compareVideoFingerprints(localFingerprint, remoteFp, {
    expectedMediaId: options.expectedMediaId ?? mediaId ?? null,
    expectedDuration: options.expectedDuration ?? duration ?? null,
  });

  if (logger) {
    logger.step(
      'select_video',
      `Đối chiếu metadata: local=${match.localSize} remote=${match.remoteSize} diff=${match.diff} → ${match.ok ? 'OK' : 'FAIL'}`
    );
  }

  if (!match.ok) {
    throw Object.assign(
      new Error(`Video metadata không khớp: ${remoteName} (${match.reason})`),
      { code: 'VIDEO_META_MISMATCH', match, remoteName, remotePath }
    );
  }

  return { ok: true, match, remoteFp };
}

async function confirmVideoSelected(deviceId, screenProfile, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { xml } = await dumpAndDetect(deviceId, screenProfile);
    const s = detectScreen(xml, screenProfile);
    if (s === SCREENS.VIDEO_EDIT || s === SCREENS.POST_EDIT) return s;
    if (s === SCREENS.GALLERY) {
      await human.pause(600, 1200);
      continue;
    }
    const nextZone = screen.getZone(screenProfile, 'next_button');
    if (findInXml(xml, 'next', { zone: nextZone })) return SCREENS.VIDEO_EDIT;
    await human.pause(600, 1200);
  }
  return null;
}

async function tapProfileUpload(deviceId, screenProfile, logger) {
  const { content: xml } = await adb.dumpUi(deviceId, 'profile_upload');
  const node = findInXml(xml, 'profile_upload');
  if (node) {
    if (logger) logger.step('profile_upload', 'Bấm Tải lên trên Hồ sơ');
    await human.tapNode(deviceId, node, { spread: 6 });
    return node;
  }
  const zone = { centerX: Math.round(screenProfile.width * 0.5), centerY: Math.round(screenProfile.height * 0.41) };
  if (logger) logger.warn('profile_upload', 'Fallback nút Tải lên profile');
  await human.tap(deviceId, zone.centerX, zone.centerY);
  return { fallback: true };
}

module.exports = {
  SCREENS,
  MAIN_SCREENS,
  MATCHERS,
  parseAllNodes,
  findInXml,
  findPostButton,
  findNextButton,
  isAutocutEditorScreen,
  findEditorNextArrow,
  assertSafeNextTarget,
  isForbiddenEditNode,
  skipVideoEditAndTapNext,
  detectScreen,
  isStillInPublishFlow,
  isPublishSuccess,
  dumpAndDetect,
  dismissPopups,
  waitForScreen,
  pollEditScreenQuick,
  tapElement,
  findCaptionField,
  findHashtagButton,
  findHashtagSuggestion,
  selectVideo,
  requireJobAlbum,
  confirmShareChooser,
  waitForEditAfterShare,
  verifyVideoMetadata,
  confirmVideoSelected,
  tapProfileUpload,
  hasBottomNav,
  isFeedScreen,
  isProfileView,
  isCommentsPanel,
  isVideoLiked,
  readLikeDesc,
  hasFeedActionRail,
  findFeedAuthor,
  nodeInZone,
};
