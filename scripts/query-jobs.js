const db = require('../db');
const rows = db.db.prepare(
  "SELECT id, status, video_path, caption, error_code, device_id FROM jobs WHERE post_mode = 'auto' ORDER BY created_at DESC LIMIT 5"
).all();
console.log(JSON.stringify(rows, null, 2));
