const adb = require('./adb');

const DEFAULT_SIZE = { width: 1080, height: 2400, density: 420 };
const profileCache = new Map();

function getScreenSize(deviceId) {
  if (profileCache.has(deviceId)) {
    return profileCache.get(deviceId);
  }

  let width = DEFAULT_SIZE.width;
  let height = DEFAULT_SIZE.height;
  let density = DEFAULT_SIZE.density;

  try {
    const { output } = adb.adbSync(deviceId, 'shell wm size');
    const physical = output.match(/Physical size:\s*(\d+)x(\d+)/i);
    const override = output.match(/Override size:\s*(\d+)x(\d+)/i);
    const match = override || physical;
    if (match) {
      width = parseInt(match[1], 10);
      height = parseInt(match[2], 10);
    }
  } catch (_) {}

  try {
    const { output } = adb.adbSync(deviceId, 'shell wm density');
    const d = output.match(/(\d+)/);
    if (d) density = parseInt(d[1], 10);
  } catch (_) {}

  const profile = { width, height, density, ratio: width / height };
  profileCache.set(deviceId, profile);
  return profile;
}

function clearProfile(deviceId) {
  profileCache.delete(deviceId);
}

function point(screen, xRatio, yRatio) {
  return {
    x: Math.round(screen.width * xRatio),
    y: Math.round(screen.height * yRatio),
  };
}

function zone(screen, { x1, y1, x2, y2 }) {
  return {
    x1: Math.round(screen.width * x1),
    y1: Math.round(screen.height * y1),
    x2: Math.round(screen.width * x2),
    y2: Math.round(screen.height * y2),
    centerX: Math.round(screen.width * ((x1 + x2) / 2)),
    centerY: Math.round(screen.height * ((y1 + y2) / 2)),
  };
}

const ZONES = {
  create_button: { x1: 0.40, y1: 0.86, x2: 0.60, y2: 0.96 },
  profile_upload: { x1: 0.35, y1: 0.33, x2: 0.65, y2: 0.45 },
  upload_button: { x1: 0.55, y1: 0.72, x2: 0.95, y2: 0.92 },
  gallery_first: { x1: 0.02, y1: 0.12, x2: 0.35, y2: 0.35 },
  next_button: { x1: 0.72, y1: 0.88, x2: 0.98, y2: 0.98 },
  caption_field: { x1: 0.05, y1: 0.08, x2: 0.95, y2: 0.28 },
  post_button: { x1: 0.48, y1: 0.82, x2: 0.99, y2: 0.96 },
  profile_header: { x1: 0.28, y1: 0.04, x2: 0.82, y2: 0.11 },
  account_sheet: { x1: 0, y1: 0.18, x2: 1, y2: 0.95 },
  bottom_nav: { x1: 0, y1: 0.86, x2: 1, y2: 1 },
  feed_center: { x1: 0.25, y1: 0.22, x2: 0.75, y2: 0.72 },
  like_button: { x1: 0.82, y1: 0.48, x2: 0.99, y2: 0.62 },
  comment_button: { x1: 0.82, y1: 0.57, x2: 0.99, y2: 0.72 },
  feed_avatar: { x1: 0.82, y1: 0.40, x2: 0.99, y2: 0.54 },
  feed_author: { x1: 0.82, y1: 0.40, x2: 0.99, y2: 0.54 },
  comment_input: { x1: 0.04, y1: 0.90, x2: 0.82, y2: 0.99 },
  comment_send: { x1: 0.84, y1: 0.90, x2: 0.99, y2: 0.99 },
  comments_list: { x1: 0.02, y1: 0.12, x2: 0.82, y2: 0.88 },
  feed_author_name: { x1: 0.12, y1: 0.72, x2: 0.72, y2: 0.86 },
};

function getZone(screen, name) {
  const def = ZONES[name];
  if (!def) return null;
  return zone(screen, def);
}

function scaleFromReference(screen, refX, refY, refW = 1080, refH = 2400) {
  return {
    x: Math.round((refX / refW) * screen.width),
    y: Math.round((refY / refH) * screen.height),
  };
}

function galleryCellCenter(screen, index, cols = 3) {
  const topY = screen.height * 0.17;
  const leftX = screen.width * 0.03;
  const usableW = screen.width * 0.94;
  const cellSize = Math.floor(usableW / cols);
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    x: Math.round(leftX + col * cellSize + cellSize / 2),
    y: Math.round(topY + row * cellSize + cellSize / 2),
    row,
    col,
    cellSize,
  };
}

function galleryGridFromThumbnails(thumbnails, index = 0) {
  if (!thumbnails?.length) return null;

  const sorted = [...thumbnails].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  const firstY = sorted[0].y1;
  const rowTolerance = Math.max(24, Math.round((sorted[0].y2 - sorted[0].y1) * 0.35));
  const firstRow = sorted.filter((t) => Math.abs(t.y1 - firstY) <= rowTolerance);
  const cols = Math.max(1, firstRow.length);

  const safeIndex = Math.min(Math.max(0, index), sorted.length - 1);
  const target = sorted[safeIndex];

  return {
    x: Math.round((target.x1 + target.x2) / 2),
    y: Math.round((target.y1 + target.y2) / 2),
    cols,
    index: safeIndex,
    total: sorted.length,
    row: Math.floor(safeIndex / cols),
    col: safeIndex % cols,
    source: 'ui_bounds',
  };
}

module.exports = {
  DEFAULT_SIZE,
  getScreenSize,
  clearProfile,
  point,
  zone,
  getZone,
  scaleFromReference,
  galleryCellCenter,
  galleryGridFromThumbnails,
  ZONES,
};
