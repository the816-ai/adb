const ERROR_CATALOG = {
  DEVICE_OFFLINE: {
    title: 'Thiết bị offline',
    severity: 'critical',
    hint: 'Kiểm tra cáp USB, chạy adb devices, bật USB Debugging và cho phép máy tính.',
    actions: ['adb kill-server && adb start-server', 'Rút/cắm lại cáp USB', 'Bật lại USB Debugging'],
  },
  TIKTOK_NOT_READY: {
    title: 'TikTok chưa sẵn sàng',
    hint: 'App chưa về Trang chủ/feed sau bước mở tự động — thường do kẹt gallery hoặc màn đăng video dở.',
    fixes: [
      'Force stop TikTok trên máy rồi retry job',
      'Mở TikTok thủ công về Trang chủ (For You)',
      'Đóng popup / thoát gallery nếu đang mở',
    ],
  },
  NOT_LOGGED_IN: {
    title: 'TikTok chưa đăng nhập',
    severity: 'critical',
    hint: 'Mở TikTok thủ công trên máy, đăng nhập tài khoản chính chủ rồi retry job.',
    actions: ['Đăng nhập TikTok thủ công', 'Tắt xác minh 2 bước popup nếu có', 'Retry job sau khi vào được home'],
  },
  ACCOUNT_NOT_FOUND: {
    title: 'Không tìm thấy tài khoản TikTok',
    severity: 'high',
    hint: 'Tên TK trong job không khớp danh sách acc đã đăng nhập sẵn trên máy.',
    actions: [
      'Kiểm tra tên hiển thị trên Hồ sơ TikTok (vd: nguyen anh)',
      'Thêm tài khoản thủ công trong TikTok trước',
      'Sửa trường TikTok account trong job cho khớp',
    ],
  },
  ACCOUNT_SWITCH_FAILED: {
    title: 'Chuyển tài khoản thất bại',
    severity: 'high',
    hint: 'Không mở được menu đổi TK hoặc chuyển xong chưa xác nhận được tên mới.',
    actions: [
      'Mở TikTok → Hồ sơ → tap tên → thử đổi tay',
      'Đảm bảo máy không khóa màn hình khi job chạy',
      'Retry job sau khi UI TikTok ổn định',
    ],
  },
  WRONG_SCREEN: {
    title: 'Sai màn hình / lẫn bước',
    severity: 'high',
    hint: 'Flow phát hiện UI không đúng bước — có thể TikTok đổi layout hoặc popup che màn hình.',
    actions: ['Xem screenshot tại bước lỗi', 'Đóng popup thủ công rồi retry', 'Kiểm tra matcher UI theo phiên bản TikTok'],
  },
  VIDEO_NOT_IN_GALLERY: {
    title: 'Không thấy video trong gallery',
    severity: 'high',
    hint: 'Video chưa được scan vào thư viện hoặc nằm ngoài vùng hiển thị.',
    actions: ['Chờ lâu hơn sau push video', 'Mở Gallery thủ công kiểm tra Download/', 'Retry job'],
  },
  ALBUM_NOT_FOUND: {
    title: 'Không tìm thấy album TikTokAuto',
    severity: 'critical',
    hint: 'TikTok gallery không hiện folder TikTokAuto — hệ thống từ chối chọn Recents để tránh đăng nhầm video.',
    actions: ['Mở gallery thủ công xem có album TikTokAuto không', 'Retry job sau khi scan media', 'Kiểm tra /sdcard/TikTokAuto/ trên máy'],
  },
  VIDEO_AMBIGUOUS: {
    title: 'Không thể xác định video trong gallery',
    severity: 'critical',
    hint: 'Album TikTokAuto có nhiều hơn 1 thumbnail — từ chối chọn để tránh đăng nhầm.',
    actions: ['Xóa file thừa trong /sdcard/TikTokAuto/', 'Retry job'],
  },
  VIDEO_META_MISMATCH: {
    title: 'Metadata video không khớp',
    severity: 'critical',
    hint: 'Dung lượng file trên máy khác file PC — có thể chọn/push sai video.',
    actions: ['Kiểm tra file trong TikTokAuto', 'Tạo job mới và upload lại video'],
  },
  VIDEO_NOT_VERIFIED: {
    title: 'Chưa xác minh được video trên máy',
    severity: 'high',
    hint: 'MediaStore hoặc thư mục TikTokAuto chưa sẵn sàng trước khi mở TikTok.',
    actions: ['Chờ thêm sau push', 'Kiểm tra adb shell ls /sdcard/TikTokAuto/', 'Retry job'],
  },
  VIDEO_NOT_FOUND: {
    title: 'Không tìm thấy file video',
    severity: 'high',
    hint: 'Đường dẫn video trên server không tồn tại hoặc bị xóa trước khi worker chạy.',
    actions: ['Kiểm tra file trong thư mục videos/', 'Tạo lại job với đúng path'],
  },
  NO_UPLOAD_BUTTON: {
    title: 'Không thấy nút Upload',
    severity: 'high',
    hint: 'UI TikTok khác phiên bản/ngôn ngữ hoặc màn hình chưa load xong.',
    actions: ['Xem screenshot lỗi', 'Cập nhật matcher trong tiktok-flow.js', 'Thử tap thủ công nút Tải lên'],
  },
  NO_NEXT_BUTTON: {
    title: 'Không thấy nút Next',
    severity: 'high',
    hint: 'Video chưa được chọn hoặc gallery chưa hiện video vừa push.',
    actions: ['Kiểm tra media scan đã chạy', 'Mở Gallery xem video có trong Download không', 'Chờ lâu hơn sau push video'],
  },
  NO_POST_BUTTON: {
    title: 'Không thấy nút Post/Đăng',
    severity: 'high',
    hint: 'Chưa qua bước edit hoặc caption chưa nhập xong.',
    actions: ['Xem UI dump tại bước lỗi', 'Kiểm tra caption có ký tự đặc biệt', 'Cập nhật matcher Post/Đăng'],
  },
  POST_FAILED: {
    title: 'Đăng video thất bại',
    severity: 'critical',
    hint: 'TikTok báo lỗi khi upload — thường do mạng, vi phạm nội dung, hoặc rate limit.',
    actions: ['Kiểm tra WiFi/4G trên máy', 'Đăng thủ công 1 video test', 'Chờ cooldown rồi retry'],
  },
  POST_NOT_STARTED: {
    title: 'Post không khởi chạy',
    severity: 'critical',
    hint: 'Đã bấm Post nhưng không vào trạng thái uploading — caption có thể sai hoặc nút Post không ăn.',
    actions: ['Kiểm tra caption/hashtag đã nhập đúng', 'Live screenshot tại bước click_post', 'Retry job'],
  },
  CAPTION_INPUT_FAILED: {
    title: 'Không nhập được caption/hashtag',
    severity: 'high',
    hint: 'Clipboard không hoạt động hoặc ô caption không nhận text.',
    actions: ['Cài app Clipper hoặc dùng Android 10+', 'Kiểm tra cmd clipboard trên máy', 'Nhập thử caption thủ công'],
  },
  CAPTION_FIELD_NOT_FOUND: {
    title: 'Không tìm thấy ô caption',
    severity: 'high',
    hint: 'Chưa vào đúng màn POST_EDIT hoặc UI TikTok khác layout.',
    actions: ['Xem UI dump tại bước input_caption', 'Cập nhật matcher caption'],
  },
  POST_STUCK: {
    title: 'Post bị kẹt / timeout',
    severity: 'critical',
    hint: 'Upload treo quá 120 giây — mạng chậm hoặc app crash ngầm.',
    actions: ['Chụp màn hình live từ Inspector', 'Force stop TikTok rồi retry', 'Kiểm tra dung lượng máy'],
  },
  WORKER_TIMEOUT: {
    title: 'Worker timeout / stale lock',
    severity: 'critical',
    hint: 'Worker không gửi heartbeat — job được đánh dấu cần kiểm tra thủ công để tránh đăng trùng.',
    actions: ['Kiểm tra TikTok trên máy có đang đăng dở không', 'Force stop TikTok', 'Retry chỉ sau khi xác nhận chưa đăng'],
  },
  SHARE_FAILED: {
    title: 'Share intent thất bại',
    severity: 'high',
    hint: 'Không đưa video vào TikTok qua share — hệ thống fallback gallery hoặc fail verify.',
    actions: ['Xem log deliver_video', 'Kiểm tra mediaId và album TikTokAuto', 'Thử share thủ công từ Gallery máy'],
  },
  UI_NOT_FOUND: {
    title: 'Không đọc được UI dump',
    severity: 'high',
    hint: 'uiautomator dump trả về rỗng — máy kẹt hoặc màn hình tắt.',
    actions: ['Mở khóa màn hình', 'Thử lại job', 'Kiểm tra TikTok foreground'],
  },
  CANCELLED: {
    title: 'Job bị hủy',
    severity: 'low',
    hint: 'Operator đã hủy job từ dashboard trước khi worker hoàn tất.',
    actions: ['Tạo job mới nếu cần đăng lại'],
  },
  READY_MANUAL: {
    title: 'Sẵn sàng đăng thủ công',
    severity: 'low',
    hint: 'Video đã push vào album TikTokAuto trên máy. Mở TikTok và đăng tay.',
    actions: ['Mở TikTok → Tải lên → album TikTokAuto', 'Kiểm tra đúng video trước khi đăng'],
  },
  WRONG_JOB_TYPE: {
    title: 'Sai loại job',
    severity: 'high',
    hint: 'Job treo tương tác (engage) bị đưa vào pipeline đăng video — worker cần restart hoặc route sai.',
    actions: ['Restart worker', 'Tạo lại job đúng chế độ'],
  },
  ENGAGE_FEED_LOST: {
    title: 'Không vào được feed TikTok',
    severity: 'medium',
    hint: 'Worker không xác nhận được màn hình For You — có thể đang ở tab khác hoặc popup che.',
    actions: ['Mở TikTok thủ công về Trang chủ', 'Đóng popup', 'Thử lại job treo'],
  },
  UNKNOWN_ERROR: {
    title: 'Lỗi không xác định',
    severity: 'medium',
    hint: 'Xem timeline và log device để xác định bước bị fail.',
    actions: ['Mở Job Inspector', 'Xem device log', 'Chụp screenshot live'],
  },
};

function getErrorInfo(code) {
  return ERROR_CATALOG[code] || {
    ...ERROR_CATALOG.UNKNOWN_ERROR,
    title: code || 'Unknown',
  };
}

function listErrors() {
  return Object.entries(ERROR_CATALOG).map(([code, info]) => ({ code, ...info }));
}

module.exports = { ERROR_CATALOG, getErrorInfo, listErrors };
