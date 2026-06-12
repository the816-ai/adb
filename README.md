# TikTok ADB Auto

**v1.2.0** — Hệ thống tự động hóa TikTok trên Android qua **ADB** (Android Debug Bridge).

Gồm dashboard web + API REST + worker nền: điều khiển điện thoại bằng UI automation (`uiautomator`), không cần root.

| Khả năng | Mô tả ngắn |
|----------|------------|
| **Đăng video tự động** | Push video → TikTok → caption → Post → xác minh đăng thành công |
| **Chuẩn bị thủ công** | Push + verify video trên máy, operator tự đăng |
| **Treo tương tác** | Xem feed, vào profile, đọc/ghi comment, thả tim như người thật |
| **Vận hành production** | API key, rate limit, backup DB, PM2, cleanup artifact |

**TikTok VN mặc định:** `com.ss.android.ugc.trill`

---

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Ba chế độ hoạt động](#2-ba-chế-độ-hoạt-động)
3. [Cài đặt & chạy nhanh](#3-cài-đặt--chạy-nhanh)
4. [Pipeline đăng video](#4-pipeline-đăng-video)
5. [Pipeline treo tương tác](#5-pipeline-treo-tương-tác)
6. [Vòng đời job & lock thiết bị](#6-vòng-đời-job--lock-thiết-bị)
7. [Dashboard](#7-dashboard)
8. [API REST](#8-api-rest)
9. [Cấu trúc mã nguồn](#9-cấu-trúc-mã-nguồn)
10. [Triển khai production](#10-triển-khai-production)
11. [Biến môi trường](#11-biến-môi-trường)
12. [Xử lý lỗi & retry](#12-xử-lý-lỗi--retry)
13. [Lưu ý vận hành](#13-lưu-ý-vận-hành)

---

## 1. Tổng quan kiến trúc

```
┌─────────────────┐     HTTP      ┌──────────────────┐
│  Dashboard Web  │ ◄──────────► │   server.js      │
│  (public/)      │              │   Express :3001  │
└─────────────────┘              └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │   db.js (SQLite) │
                                   │   jobs/jobs.db   │
                                   └────────┬─────────┘
                                            │
┌─────────────────┐   poll 5s    ┌──────────▼─────────┐
│  Android Phone  │ ◄─────────── │   worker.js        │
│  (USB / ADB)    │   ADB shell  │   worker-lock.js   │
└─────────────────┘              └──────────┬─────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
           ┌──────────────┐      ┌──────────────────┐    ┌──────────────────┐
           │ tiktok-flow  │      │ engagement-flow  │    │ adb.js + ui-state│
           │ delivery.js  │      │ engage-behavior  │    │ human.js         │
           │ result-verif.│      │ engage-nav.js    │    │ caption.js       │
           └──────────────┘      └──────────────────┘    └──────────────────┘
```

**Luồng cơ bản:**

1. Operator tạo job qua dashboard hoặc API → hàng `pending` trong SQLite.
2. Worker poll thiết bị ADB online, acquire lock (1 job / 1 device).
3. Chạy pipeline theo `post_mode`: `auto` | `manual` | `engage`.
4. Ghi kết quả: status, screenshot, timeline events, mã lỗi.

---

## 2. Ba chế độ hoạt động

| Chế độ | `post_mode` | Worker chạy | Kết quả |
|--------|-------------|-------------|---------|
| **Tự động đăng** | `auto` | `tiktok-flow` (10 bước) | `done` |
| **Chuẩn bị thủ công** | `manual` | `tiktok-flow` (4 bước) | `ready_manual` |
| **Treo tương tác** | `engage` | `engagement-flow` (4 bước) | `done` |

### Auto — đăng video hoàn toàn tự động

- Push video PC → `/sdcard/TikTokAuto/ttjob_<id>.mp4`
- Mở TikTok, đưa video vào editor (share intent, fallback gallery)
- Nhập caption, bấm Đăng, **xác minh chặt** trước khi báo `done`
- Thành công → xóa file video trên máy

### Manual — chỉ chuẩn bị file trên điện thoại

- Push + verify MediaStore (đúng 1 file, fingerprint khớp)
- Operator mở TikTok → album **TikTokAuto** → đăng tay
- An toàn khi cần kiểm soát nội dung trước khi đăng

### Engage — treo nuôi tương tác tài khoản

- Mở feed For You, xem video ngẫu nhiên
- Hành vi giống người: vào profile, đọc comment, gửi comment, thả tim
- **Không** đi pipeline đăng — tách module riêng

---

## 3. Cài đặt & chạy nhanh

### Yêu cầu

| Thành phần | Yêu cầu |
|------------|---------|
| Máy tính | Windows / macOS / Linux, **Node.js 18+** |
| Điện thoại | Android, USB Debugging, màn hình sáng khi chạy job |
| ADB | Cài sẵn hoặc `ADB_PATH` trong `.env` |
| TikTok | Đã đăng nhập trên máy |
| Mạng | Ổn định trên điện thoại (upload video) |

```powershell
adb devices
# Phải thấy: R94Y60BCW2T    device
```

### Chạy development

```powershell
cd tiktok-adb-auto
npm install
copy .env.example .env

# Terminal 1 — Dashboard + API
npm start
# → http://127.0.0.1:3001

# Terminal 2 — Worker
npm run worker
```

> Chỉ **một** worker instance. Hệ thống chặn instance thứ hai qua `jobs/worker.lock`.

### Script kiểm tra

```powershell
npm run test:verifier          # Logic xác minh đăng (không cần máy)
npm run test:media -- <device> # MediaStore + album TikTokAuto
npm run test:share -- <device> <path>  # Share intent → TikTok
npm run backup                 # Backup DB thủ công
```

---

## 4. Pipeline đăng video

### 4.1. Mười bước auto (`FLOW_STEPS_AUTO`)

| # | Bước | Việc làm |
|---|------|----------|
| 1 | `check_device` | ADB online, file video PC tồn tại, chặn job engage nhầm pipeline |
| 2 | `wake_unlock` | Bật màn hình, vuốt mở khóa, reset TikTok nếu kẹt gallery |
| 3 | `push_video` | Push vào `/sdcard/TikTokAuto/` |
| 4 | `scan_media` | **Retry 5 lần** — MediaStore, fingerprint, đúng 1 file |
| 5 | `deliver_video` | Share intent → fallback gallery (album TikTokAuto) |
| 6 | `click_next` | Next ở màn edit video |
| 7 | `click_next_2` | Next lần 2 nếu cần |
| 8 | `input_caption` | Caption + hashtag (clipboard hoặc gõ) |
| 9 | `click_post` | Bấm Post **tối đa 3 lần**, bắt buộc xác nhận post khởi chạy |
| 10 | `wait_result` | Poll 120s, xác minh publish qua `result-verifier` |

### 4.2. Đưa video vào TikTok (`deliver_video`)

```
1. Xác minh integrity (MediaStore ID + fingerprint size)
2. Thử Share Intent (content://media/... → TikTok)
3. Share chỉ OK khi vào VIDEO_EDIT hoặc POST_EDIT
4. Fail → force-stop TikTok → gallery path
5. Bắt buộc album "TikTokAuto" — từ chối Recents/Download
6. Album phải có đúng 1 thumbnail mới chọn video
```

### 4.3. Logic `done` — không báo thành công oan

Job **chỉ** `done` khi `wait_result` + `result-verifier` xác nhận **một trong**:

| Điều kiện | `via` |
|-----------|-------|
| Đã posting → về main, không còn flow đăng | `posting_completed` |
| Poll posting ≥ `SAW_POSTING_MIN_POLLS` + thoát flow | `saw_posting` |
| `click_post` xác nhận + về main | `confirmed_posting_ui` / `confirmed_fast_complete` |
| Toast đăng thành công + đã có bằng chứng posting | `success_toast` |

**Không** `done` nếu: vẫn POST_EDIT, nút Đăng còn, chưa từng thấy posting, hoặc dialog lỗi.

```powershell
npm run test:verifier
```

---

## 5. Pipeline treo tương tác

| # | Bước | Việc làm |
|---|------|----------|
| 1 | `check_device` | ADB online |
| 2 | `wake_unlock` | Mở khóa màn hình |
| 3 | `open_feed` | Mở TikTok → feed For You |
| 4 | `engage_loop` | Xem → profile / comment / tim → vuốt tiếp |

**Hành vi ngẫu nhiên mỗi video:**

- Passive watch (~18%): chỉ xem, không tương tác
- Tối đa 1–2 hành động/video (tim, profile, đọc comment)
- Gap tối thiểu giữa tim (8s) và giữa hành động (2.5s)

**Tạo job qua dashboard:** Đăng video → chọn **Treo tương tác**

**Tạo job qua API:**

```json
POST /api/jobs/engage
{
  "device_id": "R94Y60BCW2T",
  "duration_minutes": 15,
  "like_ratio": 0.5,
  "profile_ratio": 0.14,
  "comment_view_ratio": 0.2,
  "comment_post_ratio": 0.07,
  "watch_min_sec": 5,
  "watch_max_sec": 22,
  "max_videos": 40
}
```

---

## 6. Vòng đời job & lock thiết bị

```
pending → assigned → running → [pushing_video | selecting_video | input_caption | posting | engaging]
                                    ↓
              done | ready_manual | failed | need_manual_check
```

| Status | Ý nghĩa |
|--------|---------|
| `pending` | Chờ worker |
| `running` … `posting` | Đang ở bước pipeline đăng |
| `engaging` | Đang treo tương tác |
| `done` | Hoàn tất (đăng auto hoặc engage) |
| `ready_manual` | Video sẵn sàng, đăng tay |
| `failed` | Lỗi rõ, có thể retry |
| `need_manual_check` | Cần kiểm tra máy trước retry (tránh đăng trùng) |

**Lock & heartbeat:**

- 1 device = 1 job tại một thời điểm
- Heartbeat qua ADB pulse mỗi ~10s
- Worker treo > 15 phút → recover lock → job `need_manual_check` + `WORKER_TIMEOUT`

**Cancel:** Hủy từ dashboard. Nếu đã post thành công, **không** ghi đè thành `failed`.

---

## 7. Dashboard

`http://127.0.0.1:3001` sau `npm start`

| Màn hình | Chức năng |
|----------|-----------|
| **Tổng quan** | Stats, lỗi gần đây, trạng thái worker |
| **Đăng video** | 3 mode card: Auto / Manual / Engage |
| **Hàng đợi** | Filter status/mode, pagination, retry/cancel |
| **Thiết bị** | Online/busy, live screenshot, log ADB |
| **Mã lỗi** | Catalog lỗi + gợi ý xử lý |

**Job Inspector:** Timeline từng bước, screenshot, UI dump XML, artifact download.

**Production:** Nhập API key (sidebar) → header `X-API-Key` cho mọi request.

---

## 8. API REST

Base: `http://127.0.0.1:3001/api`

Khi `API_KEY` ≥ 8 ký tự trong `.env` → gửi header `X-API-Key: <key>`.

### Public (không cần auth)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/health` | Liveness, version, flow steps, config |
| GET | `/ready` | Readiness — ADB + worker running |
| GET | `/auth/status` | Auth bật/tắt |

### Jobs

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/jobs` | Danh sách (filter status, device, post_mode, search) |
| GET | `/jobs/:id` | Chi tiết job |
| GET | `/jobs/:id/detail` | Job + events + logs device |
| POST | `/jobs` | Tạo job từ `video_path` |
| POST | `/jobs/upload` | Upload video + tạo job |
| POST | `/jobs/engage` | Tạo job treo tương tác |
| PATCH | `/jobs/:id` | Sửa job pending |
| POST | `/jobs/:id/retry` | Retry failed / need_manual_check |
| POST | `/jobs/:id/cancel` | Hủy job |

### Devices & media

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/devices` | Danh sách thiết bị |
| GET | `/devices/:id/logs` | Log ADB |
| POST | `/devices/:id/live-screenshot` | Chụp màn hình live |
| POST | `/devices/:id/live-dump` | UI dump live |
| GET | `/videos` | Video có sẵn trên server |
| POST | `/videos/upload` | Upload video (chưa tạo job) |

### Ops & khác

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/stats` | Thống kê job |
| GET | `/errors` | Catalog mã lỗi |
| POST | `/ops/backup` | Backup DB |
| POST | `/ops/cleanup` | Dọn screenshot/log cũ |
| GET | `/ops/backups` | Liệt kê backup |
| GET | `/artifacts/:file` | Tải artifact |

**Ví dụ tạo job đăng auto:**

```json
POST /api/jobs
{
  "device_id": "R94Y60BCW2T",
  "video_path": "videos/clip.mp4",
  "caption": "Caption #fyp #viral",
  "post_mode": "auto"
}
```

`device_id` có thể bỏ trống — worker gán máy rảnh.

---

## 9. Cấu trúc mã nguồn

```
tiktok-adb-auto/
├── server.js              # Express API + dashboard static
├── worker.js              # Poll device, dispatch job
├── worker-lock.js         # Lock, heartbeat, stale recovery
│
├── tiktok-flow.js         # Pipeline đăng video (auto/manual)
├── delivery.js            # Share + gallery delivery
├── result-verifier.js     # Xác minh publish success (strict)
├── caption.js             # Caption + hashtag input
│
├── engagement-flow.js       # Pipeline treo tương tác
├── engage-behavior.js       # Planner hành vi người thật
├── engage-nav.js            # Recover về feed
│
├── ui-state.js            # UI dump, detect screen, matchers
├── adb.js                 # ADB, MediaStore, fingerprint, share
├── adb-exec.js            # Async ADB + per-device pulse
├── tiktok-app.js          # Package TikTok, foreground
├── screen.js              # Tọa độ màn hình, zones
├── human.js               # Tap/swipe/delay giống người
│
├── db.js                  # SQLite jobs/devices/events
├── errors.js              # Catalog mã lỗi
├── middleware/            # Auth, rate limit
├── ops/                   # Backup, cleanup
├── ecosystem.config.js    # PM2 config
│
├── public/                # Dashboard (index.html, app.js, app.css)
├── videos/                # Video upload từ PC
├── screenshots/           # Screenshot + UI dump
├── logs/                  # Log theo device
├── jobs/jobs.db           # Database
├── backups/               # Backup DB tự động
└── scripts/               # test:verifier, test:media, test:share
```

### Module quan trọng

| File | Vai trò |
|------|---------|
| `result-verifier.js` | Quyết định `done` hay fail — **không false positive** |
| `delivery.js` | Share ưu tiên, gallery dự phòng, verify media ID |
| `ui-state.js` | Nhận diện màn hình, tap đúng nút, chọn đúng album |
| `worker-lock.js` | Tránh 2 worker cùng device, recover khi treo |
| `db.js` | Acquire job atomic, cancel, timeline events |

---

## 10. Triển khai production

### Cấu hình `.env`

```powershell
copy .env.example .env
```

Bắt buộc production:

```env
NODE_ENV=production
API_KEY=<chuỗi ngẫu nhiên ≥8 ký tự>
HOST=127.0.0.1
```

### PM2 (khuyến nghị)

```powershell
npm install -g pm2
npm run prod
pm2 status
npm run prod:logs
pm2 save && pm2 startup
```

### Checklist go-live

- [ ] `adb devices` → `device`
- [ ] `GET /api/ready` → `ready: true`
- [ ] TikTok đã đăng nhập
- [ ] Test 1 job `manual` + 1 job `auto`
- [ ] Nhập API key trên dashboard
- [ ] Biết xử lý `need_manual_check` (kiểm tra máy trước retry)

### Bảo mật

- API key bắt buộc khi `API_KEY` set
- Rate limit read/write
- `PATCH status` bị chặn khi auth bật
- Bind `127.0.0.1` mặc định
- Backup DB tự động 6h + cleanup artifact 7 ngày

---

## 11. Biến môi trường

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `NODE_ENV` | `development` | `production` → cảnh báo thiếu API_KEY |
| `API_KEY` | (trống) | ≥8 ký tự → bật auth |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3001` | Cổng server |
| `ADB_PATH` | auto | Đường dẫn adb.exe |
| `POLL_INTERVAL_MS` | `5000` | Worker poll |
| `JOB_COOLDOWN_MS` | `30000` | Nghỉ giữa 2 job/device |
| `DEVICE_STALE_MS` | `900000` | Recover lock stale (15 phút) |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat device |
| `MEDIA_CACHE_TTL_MS` | `8000` | Cache MediaStore |
| `SAW_POSTING_MIN_POLLS` | `2` | Poll posting trước success |
| `ENGAGE_DURATION_MINUTES` | `10` | Thời gian treo mặc định |
| `ENGAGE_LIKE_RATIO` | `0.55` | Tỷ lệ thả tim |
| `ENGAGE_PROFILE_RATIO` | `0.14` | Tỷ lệ xem profile |
| `ENGAGE_COMMENT_VIEW_RATIO` | `0.2` | Tỷ lệ đọc comment |
| `ENGAGE_COMMENT_POST_RATIO` | `0.07` | Tỷ lệ gửi comment |
| `BACKUP_INTERVAL_MS` | `21600000` | Backup DB (6h) |
| `ARTIFACT_RETENTION_DAYS` | `7` | Giữ screenshot/log |

Xem đầy đủ trong `.env.example`.

---

## 12. Xử lý lỗi & retry

| Mã lỗi | Ý nghĩa | Gợi ý |
|--------|---------|-------|
| `POST_NOT_STARTED` | Bấm Post không khởi chạy | Kiểm tra màn POST_EDIT, retry job |
| `POST_STUCK` | Timeout 120s chờ đăng | Kiểm tra mạng, TikTok có bị kẹt |
| `VIDEO_AMBIGUOUS` | Album TikTokAuto ≠ 1 video | Xóa file thừa trên máy |
| `VIDEO_NOT_VERIFIED` | MediaStore chưa index | Đợi hoặc retry |
| `ALBUM_NOT_FOUND` | Không thấy album TikTokAuto | Mở gallery thủ công kiểm tra |
| `WORKER_TIMEOUT` | Worker treo, lock recovered | Kiểm tra máy — có thể đã đăng một phần |
| `ENGAGE_FEED_LOST` | Không vào được feed | Mở TikTok về Trang chủ, retry |

- Catalog đầy đủ: `GET /api/errors` hoặc tab **Mã lỗi** trên dashboard
- **Retry:** Chỉ từ `failed` / `need_manual_check`, device không busy
- **`need_manual_check`:** Luôn kiểm tra TikTok trên máy trước khi retry

---

## 13. Lưu ý vận hành

1. **Một worker** — không chạy song song nhiều `npm run worker`.
2. **Màn hình sáng** — UI dump trống nếu máy khóa.
3. **Album TikTokAuto** — cố tình không chọn Recents/Download.
4. **API key** — bật khi production (`API_KEY` trong `.env`).
5. **TikTok đổi UI** — cập nhật matcher trong `ui-state.js`.
6. **Caption tiếng Việt** — dùng clipboard; cần `cmd clipboard` hoặc Clipper.
7. **Tuân thủ** — sử dụng có trách nhiệm, tuân thủ điều khoản TikTok.

---

## Changelog

| Phiên bản | Nâng cấp |
|-----------|----------|
| 1.0.x | Worker lock, share verify, grid tap UI bounds, dashboard pagination |
| 1.1.x | Production: API key, rate limit, PM2, backup, cleanup |
| 1.2.x | Publish verifier chặt, click_post retry, scan_media retry, treo engage |

---

## License

Dự án nội bộ — sử dụng có trách nhiệm, tuân thủ điều khoản TikTok và pháp luật địa phương.
