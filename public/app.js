const API = '';
const RUNNING_STATUSES = [
  'assigned', 'running', 'pushing_video', 'opening_app',
  'selecting_video', 'input_caption', 'posting', 'engaging',
];
const CANCELLABLE_STATUSES = [
  'pending', 'assigned', 'running', 'pushing_video',
  'opening_app', 'selecting_video', 'input_caption', 'posting', 'ready_manual', 'engaging',
];

const STEP_LABELS = {
  check_device: 'Kiểm tra máy',
  wake_unlock: 'Mở khóa màn hình',
  open_tiktok: 'Mở TikTok (tự động)',
  switch_account: 'Chuyển tài khoản',
  push_video: 'Push video',
  scan_media: 'Xác minh MediaStore',
  deliver_video: 'Đưa video vào TikTok',
  click_next: 'Next (edit)',
  click_next_2: 'Next (caption)',
  input_caption: 'Nhập caption',
  click_post: 'Bấm Đăng',
  wait_result: 'Chờ đăng xong',
  open_feed: 'Mở feed TikTok',
  engage_loop: 'Xem video + thả tim',
};

const WORKFLOW_COPY = {
  auto: {
    title: 'Tự động đăng',
    desc: 'Worker chạy toàn bộ pipeline: push video lên điện thoại, mở TikTok (share hoặc gallery), nhập caption và bấm Đăng. Phù hợp đăng hàng loạt khi máy đã đăng nhập TikTok.',
  },
  manual: {
    title: 'Chuẩn bị thủ công',
    desc: 'Worker chỉ push video vào album TikTokAuto và xác minh đúng file. Bạn mở TikTok trên máy, chọn video, nhập caption và đăng tay — an toàn hơn khi cần kiểm soát nội dung.',
  },
  engage: {
    title: 'Treo tương tác',
    desc: 'Worker mô phỏng người dùng thật: xem video, đôi khi vào profile creator, mở đọc bình luận, thả tim video/comment, gửi cmt ngắn ngẫu nhiên rồi vuốt feed. Tỷ lệ mỗi hành vi cấu hình được.',
  },
};

let state = {
  jobs: [],
  jobsTotal: 0,
  devices: [],
  stats: null,
  health: null,
  inspectorJobId: null,
  inspectorTab: 'timeline',
  selectedArtifact: null,
  workflowView: 'auto',
  flowSteps: { auto: [], manual: [], engage: [] },
  errors: [],
  jobsOffset: 0,
  jobsPageSize: 50,
  jobsCampaignId: null,
  selectedCampaignId: null,
};

async function fetchJSON(url, opts = {}) {
  const res = await fetch(API + url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function $(id) { return document.getElementById(id); }
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
function escJs(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function basename(p) { return (p || '').split(/[/\\]/).pop(); }
function artifactUrl(p) { return p ? `/api/artifacts/${basename(p)}` : null; }
function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('vi-VN');
}
function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}
function jobStatusBadge(job) {
  if (job.status === 'pending' && job.scheduled_at && new Date(job.scheduled_at) > new Date()) {
    return '<span class="badge scheduled">hẹn giờ</span>';
  }
  return statusBadge(job.status);
}
function scheduleLabel(job) {
  if (!job.scheduled_at) return '<span class="muted">—</span>';
  const due = new Date(job.scheduled_at) <= new Date();
  const cls = due ? '' : ' style="color:#63b3ed"';
  let label = fmtTime(job.scheduled_at);
  if (job.interval_after_sec > 0) {
    label += ` (+${Math.round(job.interval_after_sec / 60)}p)`;
  }
  if (job.batch_id) {
    label += ` · #${(job.sequence_index ?? 0) + 1}`;
  }
  return `<span class="mono"${cls}>${esc(label)}</span>`;
}
function getSchedulePayload() {
  const at = $('scheduleAt')?.value;
  const interval = Number($('postIntervalMin')?.value || 0);
  const enabled = $('scheduleEnabled')?.checked || Boolean(at) || interval > 0;
  if (!enabled) return {};
  const payload = {};
  if (at) payload.scheduled_at = new Date(at).toISOString();
  if (interval > 0) payload.interval_minutes = interval;
  return payload;
}
function syncSchedulePanel() {
  const at = $('scheduleAt')?.value;
  const interval = Number($('postIntervalMin')?.value || 0);
  const enabled = $('scheduleEnabled')?.checked || Boolean(at) || interval > 0;
  const opts = $('scheduleOptions');
  if (opts) opts.style.display = enabled ? 'block' : 'none';
  if ($('scheduleEnabled') && (at || interval > 0)) $('scheduleEnabled').checked = true;
}
function getSelectedBatchVideos() {
  return [...document.querySelectorAll('#batchVideoList input[type=checkbox]:checked')]
    .map((el) => el.value);
}
function modeBadge(mode) {
  const m = mode === 'manual' ? 'manual' : (mode === 'engage' ? 'engage' : 'auto');
  const label = m === 'manual' ? 'Thủ công' : (m === 'engage' ? 'Treo tim' : 'Tự động');
  return `<span class="badge-mode ${m}">${label}</span>`;
}

function getSelectedPostMode() {
  const checked = document.querySelector('input[name="post_mode"]:checked');
  if (checked?.value === 'manual') return 'manual';
  if (checked?.value === 'engage') return 'engage';
  return 'auto';
}

function jobVideoLabel(job) {
  if (job.post_mode === 'engage' || (job.video_path || '').startsWith('engage://')) {
    try {
      const cfg = JSON.parse(job.caption || '{}');
      const mins = cfg.duration_minutes || '?';
      const pct = cfg.like_ratio != null ? Math.round(cfg.like_ratio * 100) : '?';
      return esc(`Treo ${mins}p · tim ${pct}%`);
    } catch (_) {
      return esc('Treo tương tác');
    }
  }
  return esc(basename(job.video_path));
}

function renderPipeline(steps, { vertical = false, mode = 'auto' } = {}) {
  if (!steps?.length) return '';
  const parts = steps.map((step, i) => {
    const label = STEP_LABELS[step] || step;
    const highlight = mode === 'auto' ? 'highlight' : (i < steps.length ? 'manual-highlight' : '');
    const stepHtml = `<div class="pipe-step ${i === 0 || mode === 'auto' ? highlight : 'manual-highlight'}">
      <span class="num">${i + 1}</span>
      <span>${esc(label)}</span>
    </div>`;
    if (vertical || i === steps.length - 1) return stepHtml;
    return stepHtml + '<span class="pipe-arrow">→</span>';
  });
  return parts.join('');
}

function updateWorkflowUI() {
  const mode = state.workflowView;
  const steps = state.flowSteps[mode] || [];
  const copy = WORKFLOW_COPY[mode];
  if ($('workflowDesc')) {
    $('workflowDesc').textContent = copy?.desc || '';
  }
  if ($('pipelineSteps')) {
    $('pipelineSteps').innerHTML = renderPipeline(steps, { mode });
  }
}

function updateCreateModeUI() {
  const mode = getSelectedPostMode();
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mode === mode);
  });

  const btnSubmit = $('btnSubmitJob');
  const caption = $('captionInput');
  const optional = $('captionOptional');
  const pill = $('globalModePill');
  const engageFields = $('engageFields');
  const postVideoFields = $('postVideoFields');
  const campaignPostBlock = $('campaignPostBlock');
  const singlePostBlock = $('singlePostBlock');

  if (engageFields) engageFields.style.display = mode === 'engage' ? 'block' : 'none';
  if (postVideoFields) postVideoFields.style.display = mode === 'engage' ? 'none' : 'block';
  if (campaignPostBlock) campaignPostBlock.style.display = mode === 'engage' ? 'none' : 'block';
  if (singlePostBlock) singlePostBlock.style.display = mode === 'engage' ? 'none' : 'block';

  if (btnSubmit) {
    btnSubmit.style.display = 'block';
    btnSubmit.textContent = mode === 'manual'
      ? 'Chuẩn bị video trên máy'
      : (mode === 'engage' ? 'Bắt đầu treo tương tác' : 'Đăng lẻ — bắt đầu');
    btnSubmit.classList.toggle('manual-btn', mode === 'manual');
    btnSubmit.classList.toggle('engage-btn', mode === 'engage');
  }
  if (caption) {
    caption.required = mode === 'auto';
    if (mode === 'manual' && !caption.value.trim()) {
      caption.placeholder = 'Tùy chọn — ghi chú caption bạn sẽ dùng khi đăng tay';
    } else {
      caption.placeholder = 'Nội dung caption #hashtag';
    }
  }
  if (optional) {
    optional.textContent = mode === 'manual' ? '(tùy chọn — chỉ ghi chú)' : '(bắt buộc khi tự động đăng)';
  }
  if (pill) {
    pill.textContent = mode === 'manual' ? 'Chuẩn bị thủ công' : (mode === 'engage' ? 'Treo tương tác' : 'Tự động đăng');
    pill.classList.toggle('manual', mode === 'manual');
    pill.classList.toggle('engage', mode === 'engage');
  }
  if ($('createPipeline')) {
    $('createPipeline').innerHTML = renderPipeline(
      state.flowSteps[mode] || [],
      { vertical: true, mode }
    );
  }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  $(`view-${name}`)?.classList.add('active');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  $('pageTitle').textContent = {
    dashboard: 'Tổng quan',
    create: 'Đăng video',
    campaigns: 'Chiến dịch / Thư mục',
    jobs: 'Hàng đợi',
    devices: 'Thiết bị',
    errors: 'Mã lỗi',
  }[name] || 'Tổng quan';
  if (name === 'create') {
    updateCreateModeUI();
    if (state.selectedCampaignId) {
      selectCampaignForPost(state.selectedCampaignId).catch(() => {});
    } else {
      loadCampaignFolderSelect().catch(() => {});
    }
  }
  if (name === 'campaigns' && window.CampaignsUI) window.CampaignsUI.onViewEnter();
}

async function loadHealth() {
  let authInfo = { enabled: false };
  try {
    const pub = await fetch('/api/auth/status').then((r) => r.json());
    authInfo = pub;
  } catch (_) {}

  state.health = await fetchJSON('/api/health');
  state.auth = authInfo;
  if (state.health.flow_steps) {
    state.flowSteps = state.health.flow_steps;
    updateWorkflowUI();
    updateCreateModeUI();
  }
  const dot = $('healthDot');
  const label = $('healthLabel');
  if (state.health.adb) {
    dot.className = 'status-dot';
    const worker = state.health.worker;
    const workerLabel = worker?.running
      ? `Worker pid ${worker.pid}`
      : 'Worker chưa chạy';
    const cfg = state.health.config;
    const poll = cfg ? `${Math.round(cfg.poll_interval_ms / 1000)}s` : '5s';
    label.textContent = `${state.health.devices_online} máy online · ${workerLabel} · poll ${poll}`;
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'ADB không kết nối';
  }
}

async function loadStats() {
  state.stats = await fetchJSON('/api/stats');
  const m = Object.fromEntries(state.stats.byStatus.map((s) => [s.status, s.c]));
  const running = RUNNING_STATUSES.reduce((a, s) => a + (m[s] || 0), 0);

  $('statsGrid').innerHTML = `
    <div class="stat-card"><div class="label">Tổng jobs</div><div class="value">${state.stats.total}</div></div>
    <div class="stat-card accent"><div class="label">Chờ xử lý</div><div class="value">${m.pending || 0}</div></div>
    <div class="stat-card"><div class="label">Hẹn giờ</div><div class="value">${state.stats.scheduledWaiting || 0}</div></div>
    <div class="stat-card"><div class="label">Đang chạy</div><div class="value">${running}</div></div>
    <div class="stat-card green"><div class="label">Đã đăng</div><div class="value">${m.done || 0}</div></div>
    <div class="stat-card purple"><div class="label">Sẵn sàng tay</div><div class="value">${m.ready_manual || 0}</div></div>
    <div class="stat-card red"><div class="label">Lỗi</div><div class="value">${(m.failed || 0) + (m.need_manual_check || 0)}</div></div>
  `;

  const failures = state.stats.recentFailures || [];
  $('recentFailures').innerHTML = failures.length
    ? `<ul class="failure-list">${failures.map((f) => `
        <li onclick="openInspector('${f.id}')">
          <div>
            <div>${esc(basename(f.video_path))}</div>
            <div class="code">${esc(f.error_code || f.error || 'unknown')}</div>
          </div>
          <span class="mono">${esc(f.device_id || '-')}</span>
        </li>
      `).join('')}</ul>`
    : '<div class="empty">Không có lỗi gần đây</div>';

  const h = state.health || {};
  const w = h.worker || {};
  const cfg = h.config || {};
  const pollSec = cfg.poll_interval_ms ? Math.round(cfg.poll_interval_ms / 1000) : 5;
  const coolSec = cfg.job_cooldown_ms ? Math.round(cfg.job_cooldown_ms / 1000) : 30;
  const workerLine = w.running
    ? `<span style="color:var(--green)">● Đang chạy</span> — PID <code>${w.pid}</code> từ ${fmtTime(w.startedAt)}`
    : `<span style="color:var(--red)">○ Chưa chạy</span> — chạy <code>npm run worker</code> trong terminal riêng`;

  $('workerHints').innerHTML = `
    <p>${workerLine}</p>
    <p><strong>Poll:</strong> ${pollSec}s · <strong>Cooldown:</strong> ${coolSec}s giữa các job trên cùng máy.</p>
    <p><strong>Hẹn giờ:</strong> job <code>pending</code> có <code>scheduled_at</code> tương lai — worker tự chạy đúng giờ.</p>
    <p><strong>Tự động:</strong> pipeline 10 bước qua share/gallery.</p>
    <p><strong>Thủ công:</strong> kết thúc <code>ready_manual</code> — video trong <code>/sdcard/TikTokAuto/</code>.</p>
    <p>Thiết bị online: <strong>${h.devices_online ?? 0}</strong> — cắm USB và <code>adb devices</code>.</p>
  `;
}

async function loadErrors() {
  state.errors = await fetchJSON('/api/errors');
  renderErrorsCatalog($('errorSearch')?.value || '');
}

function renderErrorsCatalog(query) {
  const q = (query || '').toLowerCase().trim();
  const list = state.errors.filter((e) => {
    if (!q) return true;
    const blob = `${e.code} ${e.title} ${e.hint} ${(e.actions || []).join(' ')}`.toLowerCase();
    return blob.includes(q);
  });

  $('errorsCatalog').innerHTML = list.length
    ? `<div class="errors-grid">${list.map((e) => `
      <div class="error-card severity-${e.severity || 'medium'}">
        <div class="error-card-head">
          <code>${esc(e.code)}</code>
          <span class="severity-tag">${esc(e.severity || 'medium')}</span>
        </div>
        <h4>${esc(e.title)}</h4>
        <p>${esc(e.hint || '')}</p>
        ${e.actions?.length ? `<ul>${e.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      </div>
    `).join('')}</div>`
    : '<div class="empty">Không tìm thấy mã lỗi</div>';
}

async function loadCampaignFolderSelect() {
  const select = $('campaignFolderSelect');
  if (!select) return;
  try {
    const res = await fetchJSON('/api/campaigns');
    const cur = state.selectedCampaignId || select.value;
    select.innerHTML = '<option value="">— Chọn thư mục —</option>';
    (res.campaigns || []).forEach((c) => {
      const count = c.video_count ?? 0;
      select.innerHTML += `<option value="${esc(c.id)}">${esc(c.name)} (${count} video)</option>`;
    });
    if (cur && [...select.options].some((o) => o.value === cur)) {
      select.value = cur;
      state.selectedCampaignId = cur;
    }
    if ($('view-create')?.classList.contains('active') && select.value) {
      await applyCampaignLaunchDefaults(select.value);
      await loadCampaignPostPreview();
    } else if (!select.value) {
      const title = $('campaignPostTitle');
      if (title) title.textContent = 'Đăng từ thư mục chiến dịch';
    }
  } catch (_) {
    select.innerHTML = '<option value="">— Không tải được thư mục —</option>';
  }
}

async function applyCampaignLaunchDefaults(campaignId) {
  if (!campaignId) return;
  try {
    const detail = await fetchJSON(`/api/campaigns/${campaignId}`);
    const c = detail.campaign;
    if (!c) return;

    const minEl = $('postCampIntervalMin');
    const maxEl = $('postCampIntervalMax');
    if (minEl && c.interval_minutes != null) minEl.value = String(c.interval_minutes);
    if (maxEl) maxEl.value = String(c.interval_min_max ?? c.interval_minutes ?? maxEl.value);

    const deviceSel = $('deviceSelect');
    if (deviceSel && c.default_device_id) deviceSel.value = c.default_device_id;

    const accInput = $('tiktokAccountInput');
    if (accInput && c.default_tiktok_account) accInput.value = c.default_tiktok_account;

    const postMode = c.default_post_mode || 'auto';
    const radio = document.querySelector(`input[name="post_mode"][value="${postMode}"]`);
    if (radio) {
      radio.checked = true;
      updateCreateModeUI();
    }

    const title = $('campaignPostTitle');
    const count = (detail.videos || []).filter((v) => v.enabled !== 0).length;
    if (title) title.textContent = `Đăng thư mục: ${c.name} (${count} video)`;
  } catch (_) {}
}

async function selectCampaignForPost(campaignId) {
  if (campaignId) state.selectedCampaignId = campaignId;
  await loadCampaignFolderSelect();
  const select = $('campaignFolderSelect');
  if (select && campaignId) {
    if (![...select.options].some((o) => o.value === campaignId)) {
      await loadCampaignFolderSelect();
    }
    if ([...select.options].some((o) => o.value === campaignId)) {
      select.value = campaignId;
      state.selectedCampaignId = campaignId;
    }
  }
  if (select?.value) {
    await applyCampaignLaunchDefaults(select.value);
    await loadCampaignPostPreview();
  }
  $('campaignPostBlock')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadCampaignPostPreview() {
  const el = $('campaignPostPreview');
  const folderId = $('campaignFolderSelect')?.value || '';
  if (!el) return;
  if (!folderId) {
    el.innerHTML = '<span class="muted">Chọn thư mục để xem danh sách video + caption đã lưu DB.</span>';
    return;
  }
  try {
    const detail = await fetchJSON(`/api/campaigns/${folderId}`);
    const videos = (detail.videos || []).filter((v) => v.enabled !== 0);
    if (!videos.length) {
      el.innerHTML = '<span class="muted">Thư mục trống hoặc không có video bật — upload ở tab Chiến dịch trước.</span>';
      return;
    }
    const missingCap = videos.filter((v) => !String(v.caption || '').trim()).length;
    el.innerHTML = `
      <table class="campaign-post-table">
        <thead><tr><th>#</th><th>Video</th><th>Caption (DB)</th></tr></thead>
        <tbody>
          ${videos.map((v, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${esc(v.video_name)}</td>
              <td>${esc(String(v.caption || '').trim() || '— thiếu caption —')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p class="field-hint">${videos.length} video sẽ đăng · caption lấy từ DB từng video${missingCap ? ` · <span style="color:var(--red)">${missingCap} thiếu caption</span>` : ''}</p>
    `;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
  }
}

async function launchCampaignFromPost(immediate) {
  const campaignId = $('campaignFolderSelect')?.value;
  if (!campaignId) throw new Error('Chọn thư mục chiến dịch');
  const scheduleAt = $('postCampScheduleAt')?.value;
  if (!immediate && !scheduleAt) throw new Error('Chọn giờ bắt đầu để đặt lịch');
  const min = parseInt($('postCampIntervalMin')?.value || '0', 10);
  const max = parseInt($('postCampIntervalMax')?.value || String(min), 10);
  const postMode = getSelectedPostMode();
  if (postMode === 'engage') throw new Error('Chọn chế độ Tự động đăng hoặc Chuẩn bị thủ công');

  return fetchJSON(`/api/campaigns/${campaignId}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: $('deviceSelect')?.value || null,
      tiktok_account: ($('tiktokAccountInput')?.value || '').trim() || null,
      post_mode: postMode,
      interval_minutes: min,
      interval_min_max: max > min ? max : null,
      immediate,
      scheduled_at: immediate ? null : new Date(scheduleAt).toISOString(),
    }),
  });
}

async function loadVideoList() {
  try {
    const videos = await fetchJSON('/api/videos');
    const select = $('videoPathSelect');
    const batchList = $('batchVideoList');
    if (select) {
      const cur = select.value;
      select.innerHTML = '<option value="">— Không chọn —</option>';
      videos.forEach((v) => {
        const mb = (v.size / 1024 / 1024).toFixed(1);
        select.innerHTML += `<option value="${v.path}">${v.name} (${mb} MB)</option>`;
      });
      select.value = cur;
    }
    if (batchList) {
      const checked = new Set(getSelectedBatchVideos());
      batchList.innerHTML = videos.length
        ? videos.map((v) => {
          const mb = (v.size / 1024 / 1024).toFixed(1);
          const checkedAttr = checked.has(v.path) ? 'checked' : '';
          return `<label class="batch-video-item"><input type="checkbox" value="${esc(v.path)}" ${checkedAttr}><span>${esc(v.name)} (${mb} MB)</span></label>`;
        }).join('')
        : '<span class="muted">Chưa có video trong thư mục gốc videos/ — dùng thư mục chiến dịch phía trên hoặc upload file</span>';
    }
  } catch (_) {
    if ($('batchVideoList')) $('batchVideoList').textContent = 'Không tải được danh sách video';
  }
}

async function loadDevices() {
  state.devices = await fetchJSON('/api/devices');
  const select = $('deviceSelect');
  const cur = select?.value;
  if (select) {
    select.innerHTML = '<option value="">Tự động gán máy rảnh</option>';
    state.devices.forEach((d) => {
      select.innerHTML += `<option value="${d.id}">${d.id}${d.busy ? ' (busy)' : ''}</option>`;
    });
    select.value = cur || '';
  }

  $('deviceGrid').innerHTML = state.devices.length
    ? state.devices.map((d) => `
      <div class="device-card ${d.busy ? 'busy' : ''}">
        <h4><span class="status-dot"></span> ${esc(d.id)}</h4>
        <div class="device-meta">
          ${d.busy ? '<strong style="color:var(--accent)">Đang chạy job</strong>' : 'Rảnh'}<br>
          Job: ${d.current_job ? esc(basename(d.current_job.video_path)) : '-'}<br>
          Last seen: ${fmtTime(d.last_seen)}<br>
          TK mặc định: ${esc(d.tiktok_account || '—')}<br>
          ${d.last_error ? `<span style="color:var(--red)">${esc(d.last_error)}</span>` : ''}
        </div>
        <div class="device-actions">
          <button class="btn ghost small" onclick="setDeviceAccount('${d.id}')">👤 TK mặc định</button>
          <button class="btn ghost small" onclick="liveScreenshot('${d.id}')">📷 Screenshot</button>
          <button class="btn ghost small" onclick="liveDump('${d.id}')">📋 UI Dump</button>
          <button class="btn ghost small" onclick="viewDeviceLogs('${d.id}')">📜 Logs</button>
        </div>
        <div id="liveResult-${d.id}" style="margin-top:10px"></div>
      </div>
    `).join('')
    : '<div class="empty">Không có thiết bị. Chạy <code>adb devices</code>.</div>';
}

async function loadJobs(append = false) {
  const status = $('filterStatus')?.value || '';
  const search = $('filterSearch')?.value || '';
  const device_id = $('filterDevice')?.value || '';
  const modeFilter = $('filterMode')?.value || '';

  if (!append) state.jobsOffset = 0;

  const data = await fetchJSON(
    `/api/jobs?limit=${state.jobsPageSize}&offset=${state.jobsOffset}`
    + `&status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`
    + `&device_id=${encodeURIComponent(device_id)}&post_mode=${encodeURIComponent(modeFilter)}`
    + (state.jobsCampaignId ? `&campaign_id=${encodeURIComponent(state.jobsCampaignId)}` : '')
  );

  const banner = $('jobsCampaignBanner');
  if (banner) {
    if (state.jobsCampaignId) {
      banner.style.display = 'flex';
      banner.innerHTML = `
        <span>Lọc chiến dịch: <code>${esc(state.jobsCampaignId.slice(0, 8))}…</code></span>
        <button type="button" class="btn ghost small" id="btnClearCampaignFilter">Bỏ lọc</button>
      `;
      $('btnClearCampaignFilter')?.addEventListener('click', clearCampaignJobFilter);
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
    }
  }

  state.jobs = append ? [...state.jobs, ...data.jobs] : data.jobs;
  state.jobsTotal = data.total;

  $('jobsCount').textContent = `(${data.total} jobs)`;
  const loaded = state.jobs.length;
  const hasMore = loaded < data.total;
  const loadMoreRow = $('jobsLoadMoreRow');
  if (loadMoreRow) loadMoreRow.style.display = hasMore ? 'flex' : 'none';
  const loadedCount = $('jobsLoadedCount');
  if (loadedCount) loadedCount.textContent = `Đã tải ${loaded}/${data.total}`;

  $('jobsTable').innerHTML = state.jobs.length
    ? state.jobs.map((j) => `
      <tr class="clickable" onclick="openInspector('${j.id}')">
        <td class="mono" title="${esc(j.id)}">${esc(j.id.slice(0, 8))}…</td>
        <td title="${esc(j.video_path)}">${jobVideoLabel(j)}</td>
        <td>${modeBadge(j.post_mode)}</td>
        <td>${esc(j.device_id || '-')}</td>
        <td>${jobStatusBadge(j)}</td>
        <td style="color:var(--red);font-size:0.76rem">${esc(j.error_code || '-')}</td>
        <td class="mono" style="font-size:0.76rem">${scheduleLabel(j)}</td>
        <td class="mono">${fmtTime(j.created_at)}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn ghost small" onclick="openInspector('${j.id}')">Inspect</button>
          ${['failed', 'need_manual_check'].includes(j.status) ? `<button class="btn small" onclick="retryJob('${j.id}')">Retry</button>` : ''}
          ${CANCELLABLE_STATUSES.includes(j.status) ? `<button class="btn danger small" onclick="cancelJob('${j.id}')">Hủy</button>` : ''}
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="9" class="empty">Chưa có job</td></tr>';

  const filterDevice = $('filterDevice');
  if (filterDevice && filterDevice.options.length <= 1) {
    state.devices.forEach((d) => {
      filterDevice.innerHTML += `<option value="${d.id}">${d.id}</option>`;
    });
  }
}

function loadMoreJobs() {
  state.jobsOffset += state.jobsPageSize;
  return loadJobs(true);
}

async function loadAll() {
  try {
    await Promise.all([
      loadHealth(), loadStats(), loadDevices(), loadJobs(),
      loadCampaignFolderSelect(), loadVideoList(), loadErrors(),
    ]);
    $('lastRefresh').textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN');
  } catch (err) {
    $('lastRefresh').textContent = 'Lỗi: ' + err.message;
  }
}

async function openInspector(jobId) {
  state.inspectorJobId = jobId;
  state.inspectorTab = 'timeline';
  state.selectedArtifact = null;
  const detail = await fetchJSON(`/api/jobs/${jobId}/detail`);
  renderInspector(detail);
  $('inspectorOverlay').classList.add('open');
  $('inspector').classList.add('open');
}

function closeInspector() {
  $('inspectorOverlay').classList.remove('open');
  $('inspector').classList.remove('open');
  state.inspectorJobId = null;
}

function setInspectorTab(tab) {
  state.inspectorTab = tab;
  document.querySelectorAll('.inspector-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.inspector-pane').forEach((p) => {
    p.style.display = p.dataset.pane === tab ? 'block' : 'none';
  });
}

function renderInspector(detail) {
  const { job, events, artifacts, error_info, device_logs } = detail;

  $('inspectorTitle').textContent = basename(job.video_path);
  $('inspectorSub').textContent = `${job.id} · ${modeBadge(job.post_mode)} · ${job.device_id || 'chưa gán'}`;

  const actions = [];
  if (['failed', 'need_manual_check'].includes(job.status)) {
    actions.push(`<button class="btn" onclick="retryJob('${job.id}', true)">Retry</button>`);
  }
  if (CANCELLABLE_STATUSES.includes(job.status)) {
    actions.push(`<button class="btn danger" onclick="cancelJob('${job.id}')">Hủy job</button>`);
  }
  if (job.device_id) {
    actions.push(`<button class="btn ghost" onclick="liveScreenshot('${job.device_id}', true)">Live Screenshot</button>`);
  }
  $('inspectorActions').innerHTML = actions.join('');

  let extraPanel = '';
  if (job.status === 'ready_manual') {
    extraPanel = `
      <div class="manual-ready-panel">
        <strong>✋ Sẵn sàng đăng thủ công</strong><br>
        Video đã push vào album <code>TikTokAuto</code> trên máy. Mở TikTok → Tải lên → chọn video trong album TikTokAuto → nhập caption và đăng.
      </div>
    `;
  }

  let errorHtml = '';
  if (job.error_code || job.error) {
    const info = error_info || {};
    errorHtml = `
      <div class="error-panel">
        <h4>${esc(info.title || job.error_code)} · ${esc(job.error_code || '')}</h4>
        <p>${esc(job.error || info.hint || '')}</p>
        ${info.hint ? `<p style="margin-top:8px;color:var(--muted)">${esc(info.hint)}</p>` : ''}
        ${info.actions?.length ? `<ul>${info.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      </div>
    `;
  }

  const deliveryEvent = [...events].reverse().find((e) => e.step === 'deliver_video' && e.level === 'success');
  const deliveryMethod = deliveryEvent?.meta?.delivery_method
    || (deliveryEvent?.message?.includes('[share]') ? 'share' : (deliveryEvent?.message?.includes('[gallery]') ? 'gallery' : null));

  $('inspectorMeta').innerHTML = `
    ${extraPanel}
    ${errorHtml}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;margin-bottom:14px">
      <div><span style="color:var(--muted)">Status</span><br>${jobStatusBadge(job)}</div>
      <div><span style="color:var(--muted)">Lịch đăng</span><br>${scheduleLabel(job)}</div>
      <div><span style="color:var(--muted)">Chế độ</span><br>${modeBadge(job.post_mode)}</div>
      <div><span style="color:var(--muted)">Device</span><br>${esc(job.device_id || '-')}</div>
      <div><span style="color:var(--muted)">TikTok TK</span><br>${esc(job.tiktok_account || '—')}</div>
      <div><span style="color:var(--muted)">Tạo lúc</span><br>${fmtTime(job.created_at)}</div>
      <div><span style="color:var(--muted)">Kết thúc</span><br>${fmtTime(job.finished_at)}</div>
      ${deliveryMethod ? `<div><span style="color:var(--muted)">Delivery</span><br><code>${esc(deliveryMethod)}</code></div>` : ''}
    </div>
    <div style="font-size:0.82rem"><span style="color:var(--muted)">Caption:</span><br>${esc(job.caption || '(trống)')}</div>
  `;

  $('inspectorTimeline').innerHTML = events.length
    ? `<ul class="timeline">${events.map((e) => `
      <li class="${e.level}">
        <div class="step-name">${esc(e.step)}</div>
        <div class="msg">${esc(e.message || '')}</div>
        ${e.meta ? `<div class="msg" style="color:var(--muted);font-size:0.72rem;margin-top:4px">${esc(typeof e.meta === 'string' ? e.meta : JSON.stringify(e.meta))}</div>` : ''}
        <div class="time">${fmtTime(e.created_at)}</div>
        ${e.artifact_path ? `<span class="artifact-link" onclick="previewArtifact('${escJs(artifactUrl(e.artifact_path))}', '${e.artifact_type}')">${e.artifact_type === 'ui_dump' ? '📋 UI Dump' : '📷 Screenshot'}</span>` : ''}
      </li>
    `).join('')}</ul>`
    : '<div class="empty">Chưa có event</div>';

  const shots = artifacts.filter((a) => a.type === 'screenshot');
  const dumps = artifacts.filter((a) => a.type === 'ui_dump');
  if (shots.length) state.selectedArtifact = artifactUrl(shots[shots.length - 1].path);
  else if (job.screenshot) state.selectedArtifact = artifactUrl(job.screenshot);

  $('artifactThumbs').innerHTML = [
    ...shots.map((a) => `<img class="artifact-thumb ${artifactUrl(a.path) === state.selectedArtifact ? 'active' : ''}" src="${artifactUrl(a.path)}" onclick="previewArtifact('${escJs(artifactUrl(a.path))}', 'screenshot')" title="${esc(a.step)}">`),
    ...dumps.map((a) => `<div class="artifact-thumb xml" onclick="previewArtifact('${escJs(artifactUrl(a.path))}', 'ui_dump')" title="${esc(a.step)}">XML</div>`),
  ].join('') || '<div class="empty">Không có artifact</div>';

  renderArtifactViewer(state.selectedArtifact, 'screenshot');
  $('inspectorLogs').innerHTML = (device_logs || []).length
    ? device_logs.map((line) => {
      const cls = line.includes('FAILED') || line.includes('error') ? 'error' : line.includes('success') ? 'success' : '';
      return `<div class="log-line ${cls}">${esc(line)}</div>`;
    }).join('')
    : '<div class="empty">Không có log</div>';

  setInspectorTab(state.inspectorTab);
}

async function previewArtifact(url, type) {
  state.selectedArtifact = url;
  document.querySelectorAll('.artifact-thumb').forEach((t) => {
    t.classList.toggle('active', t.src === url || false);
  });
  renderArtifactViewer(url, type);
  setInspectorTab('artifacts');
  $('inspector').classList.add('open');
}

function renderArtifactViewer(url, type) {
  if (!url) {
    $('artifactViewer').innerHTML = '<div class="empty">Chọn artifact</div>';
    return;
  }
  if (type === 'ui_dump') {
    fetch(url).then((r) => r.text()).then((xml) => {
      $('artifactViewer').innerHTML = `<div class="code-block">${esc(xml.slice(0, 8000))}${xml.length > 8000 ? '\n\n... truncated' : ''}</div>`;
    });
  } else {
    $('artifactViewer').innerHTML = `<div class="artifact-viewer"><img src="${url}" onclick="openLightbox('${url}')" alt="screenshot"></div>`;
  }
}

function openLightbox(url) {
  $('lightboxImg').src = url;
  $('lightbox').classList.add('open');
}
function closeLightbox() {
  $('lightbox').classList.remove('open');
}

async function retryJob(id, fromInspector = false) {
  await fetchJSON(`/api/jobs/${id}/retry`, { method: 'POST' });
  await loadAll();
  if (fromInspector) await openInspector(id);
}

async function cancelJob(id) {
  if (!confirm('Hủy job này? Job đang chạy sẽ dừng ở bước kế tiếp.')) return;
  await fetchJSON(`/api/jobs/${id}/cancel`, { method: 'POST' });
  await loadAll();
  if (state.inspectorJobId === id) await openInspector(id);
}

async function liveScreenshot(deviceId, inInspector = false) {
  try {
    const res = await fetchJSON(`/api/devices/${deviceId}/live-screenshot`, { method: 'POST' });
    const html = `<div class="artifact-viewer"><img src="${res.url}" onclick="openLightbox('${res.url}')"></div>`;
    if (inInspector) {
      $('artifactViewer').innerHTML = html;
      setInspectorTab('artifacts');
    } else {
      $(`liveResult-${deviceId}`).innerHTML = html;
    }
  } catch (err) {
    alert('Screenshot failed: ' + err.message);
  }
}

async function liveDump(deviceId) {
  try {
    const res = await fetchJSON(`/api/devices/${deviceId}/live-dump`, { method: 'POST' });
    $(`liveResult-${deviceId}`).innerHTML = `
      <div style="font-size:0.76rem;color:var(--muted);margin-bottom:6px">${res.node_count} nodes · <a href="${res.url}" target="_blank" style="color:var(--blue)">Tải XML</a></div>
      <div class="code-block">${esc(res.preview || '')}</div>
    `;
  } catch (err) {
    alert('UI dump failed: ' + err.message);
  }
}

async function setDeviceAccount(deviceId) {
  const device = state.devices.find((d) => d.id === deviceId);
  const current = device?.tiktok_account || '';
  const acc = prompt('Tên TikTok (tên hiển thị trên Hồ sơ). Để trống = bỏ TK mặc định:', current);
  if (acc === null) return;
  try {
    await fetchJSON(`/api/devices/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiktok_account: acc.trim() || null }),
    });
    loadDevices();
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}

async function viewDeviceLogs(deviceId) {
  const res = await fetchJSON(`/api/devices/${deviceId}/logs?lines=200`);
  $(`liveResult-${deviceId}`).innerHTML = `
    <div class="log-viewer">${res.lines.map((l) => `<div class="log-line">${esc(l)}</div>`).join('')}</div>
  `;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.querySelectorAll('.inspector-tab').forEach((tab) => {
  tab.addEventListener('click', () => setInspectorTab(tab.dataset.tab));
});

document.querySelectorAll('.wf-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.wf-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.workflowView = tab.dataset.wf;
    updateWorkflowUI();
  });
});

document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    const radio = card.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    updateCreateModeUI();
  });
});

document.querySelectorAll('input[name="post_mode"]').forEach((r) => {
  r.addEventListener('change', updateCreateModeUI);
});

$('inspectorOverlay')?.addEventListener('click', closeInspector);
$('btnCloseInspector')?.addEventListener('click', closeInspector);
$('lightbox')?.addEventListener('click', closeLightbox);
$('btnRefresh')?.addEventListener('click', loadAll);
$('btnLoadMoreJobs')?.addEventListener('click', () => loadMoreJobs());
$('errorSearch')?.addEventListener('input', debounce((e) => renderErrorsCatalog(e.target.value), 300));

['filterStatus', 'filterSearch', 'filterDevice', 'filterMode'].forEach((id) => {
  $(id)?.addEventListener('change', loadJobs);
  $(id)?.addEventListener('input', debounce(loadJobs, 400));
});

$('campaignFolderSelect')?.addEventListener('change', async () => {
  state.selectedCampaignId = $('campaignFolderSelect')?.value || null;
  if (state.selectedCampaignId) {
    await applyCampaignLaunchDefaults(state.selectedCampaignId);
    await loadCampaignPostPreview();
  } else {
    const title = $('campaignPostTitle');
    if (title) title.textContent = 'Đăng từ thư mục chiến dịch';
    await loadCampaignPostPreview();
  }
});

async function handleCampaignPost(immediate) {
  const btnNow = $('btnPostCampaignNow');
  const btnSched = $('btnPostCampaignSchedule');
  const active = immediate ? btnNow : btnSched;
  try {
    if (btnNow) btnNow.disabled = true;
    if (btnSched) btnSched.disabled = true;
    if (active) active.textContent = immediate ? 'Đang đăng...' : 'Đang đặt lịch...';
    const res = await launchCampaignFromPost(immediate);
    const first = res.slots?.[0] ? new Date(res.slots[0]).toLocaleString('vi-VN') : 'ngay';
    alert(`Tạo ${res.count} job thành công · bắt đầu ${first}`);
    switchView('jobs');
    loadAll();
  } catch (err) {
    alert('Lỗi: ' + err.message);
  } finally {
    if (btnNow) { btnNow.disabled = false; btnNow.textContent = 'Đăng ngay'; }
    if (btnSched) { btnSched.disabled = false; btnSched.textContent = 'Đặt lịch'; }
  }
}

$('btnPostCampaignNow')?.addEventListener('click', () => handleCampaignPost(true));
$('btnPostCampaignSchedule')?.addEventListener('click', () => handleCampaignPost(false));

async function openPostForCampaign(campaignId) {
  if (!campaignId) {
    alert('Chưa mở thư mục chiến dịch');
    return;
  }
  state.selectedCampaignId = campaignId;
  switchView('create');
}

$('videoFile')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  const info = $('videoFileInfo');
  if (!info) return;
  if (file) {
    info.textContent = `${file.name} — ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    if ($('videoPathSelect')) $('videoPathSelect').value = '';
  } else {
    info.textContent = '';
  }
});

$('videoPathSelect')?.addEventListener('change', (e) => {
  if (e.target.value && $('videoFile')) {
    $('videoFile').value = '';
    if ($('videoFileInfo')) $('videoFileInfo').textContent = 'Dùng video có sẵn trên server';
  }
});

$('scheduleEnabled')?.addEventListener('change', syncSchedulePanel);
$('scheduleAt')?.addEventListener('change', syncSchedulePanel);
$('postIntervalMin')?.addEventListener('input', syncSchedulePanel);

$('jobForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const caption = fd.get('caption') || '';
  const deviceId = fd.get('device_id');
  const tiktokAccount = (fd.get('tiktok_account') || '').trim();
  const postMode = getSelectedPostMode();
  const file = $('videoFile')?.files?.[0];
  const existingPath = fd.get('video_path');
  const batchPaths = getSelectedBatchVideos();
  const schedulePayload = getSchedulePayload();
  const btn = $('btnSubmitJob');

  if (postMode !== 'engage' && !file && !existingPath && batchPaths.length === 0) {
    const campaignId = $('campaignFolderSelect')?.value || state.selectedCampaignId;
    if (campaignId) {
      const go = confirm('Bạn đã chọn thư mục chiến dịch.\n\nBấm OK để đăng tất cả video trong thư mục (caption từng video trong DB).\nBấm Hủy để chọn video đăng lẻ.');
      if (go) {
        try {
          btn.disabled = true;
          btn.textContent = 'Đang tạo job chiến dịch...';
          const res = await launchCampaignFromPost(!schedulePayload.scheduled_at);
          const first = res.slots?.[0] ? new Date(res.slots[0]).toLocaleString('vi-VN') : 'ngay';
          alert(`Tạo ${res.count} job thành công · bắt đầu ${first}`);
          switchView('jobs');
          loadAll();
        } catch (err) {
          alert('Lỗi: ' + err.message);
        } finally {
          btn.disabled = false;
          updateCreateModeUI();
        }
        return;
      }
    }
    alert('Chọn video từ máy tính, video server, tick nhiều video, hoặc chọn thư mục chiến dịch rồi bấm「Đăng ngay」');
    return;
  }
  if (postMode === 'auto' && !String(caption).trim()) {
    alert('Caption bắt buộc khi tự động đăng');
    return;
  }

  try {
    btn.disabled = true;
    if (postMode === 'engage') {
      btn.textContent = 'Đang tạo job treo...';
      const body = {
        device_id: deviceId || undefined,
        tiktok_account: tiktokAccount || undefined,
        duration_minutes: Number($('engageDuration')?.value || 10),
        like_ratio: Number($('engageLikeRatio')?.value || 55) / 100,
        watch_min_sec: Number($('engageWatchMin')?.value || 5),
        watch_max_sec: Number($('engageWatchMax')?.value || 22),
        max_videos: Number($('engageMaxVideos')?.value || 40),
        profile_ratio: Number($('engageProfileRatio')?.value || 14) / 100,
        comment_view_ratio: Number($('engageCommentViewRatio')?.value || 20) / 100,
        comment_post_ratio: Number($('engageCommentPostRatio')?.value || 7) / 100,
        comment_like_ratio: Number($('engageCommentLikeRatio')?.value || 10) / 100,
      };
      await fetchJSON('/api/jobs/engage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else if (batchPaths.length > 1) {
      btn.textContent = `Đang tạo ${batchPaths.length} job...`;
      await fetchJSON('/api/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_paths: batchPaths,
          caption,
          post_mode: postMode,
          device_id: deviceId || undefined,
          tiktok_account: tiktokAccount || undefined,
          ...schedulePayload,
        }),
      });
    } else if (batchPaths.length === 1 && !file && !existingPath) {
      btn.textContent = 'Đang tạo job...';
      await fetchJSON('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: batchPaths[0],
          caption,
          post_mode: postMode,
          device_id: deviceId || undefined,
          tiktok_account: tiktokAccount || undefined,
          ...schedulePayload,
        }),
      });
    } else {
      btn.textContent = file ? 'Đang upload...' : 'Đang tạo job...';

      if (file) {
        const uploadFd = new FormData();
        uploadFd.append('video', file);
        uploadFd.append('caption', caption);
        uploadFd.append('post_mode', postMode);
        if (deviceId) uploadFd.append('device_id', deviceId);
        if (tiktokAccount) uploadFd.append('tiktok_account', tiktokAccount);
        if (schedulePayload.scheduled_at) uploadFd.append('scheduled_at', schedulePayload.scheduled_at);
        if (schedulePayload.interval_minutes) uploadFd.append('interval_minutes', String(schedulePayload.interval_minutes));
        const res = await fetch('/api/jobs/upload', { method: 'POST', body: uploadFd });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }
      } else {
        const body = { video_path: existingPath, caption, post_mode: postMode, ...schedulePayload };
        if (deviceId) body.device_id = deviceId;
        if (tiktokAccount) body.tiktok_account = tiktokAccount;
        await fetchJSON('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
    }

    e.target.reset();
    if ($('videoFileInfo')) $('videoFileInfo').textContent = '';
    if ($('scheduleOptions')) $('scheduleOptions').style.display = 'none';
    if ($('scheduleEnabled')) $('scheduleEnabled').checked = false;
    document.querySelector('input[name="post_mode"][value="auto"]').checked = true;
    updateCreateModeUI();
    switchView('jobs');
    loadAll();
  } catch (err) {
    alert('Lỗi: ' + err.message);
  } finally {
    btn.disabled = false;
    updateCreateModeUI();
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function clearCampaignJobFilter() {
  state.jobsCampaignId = null;
  loadJobs();
}

function openJobsForCampaign(campaignId) {
  state.jobsCampaignId = campaignId;
  switchView('jobs');
  loadJobs();
}

window.openInspector = openInspector;
window.retryJob = retryJob;
window.cancelJob = cancelJob;
window.liveScreenshot = liveScreenshot;
window.liveDump = liveDump;
window.viewDeviceLogs = viewDeviceLogs;
window.setDeviceAccount = setDeviceAccount;
window.previewArtifact = previewArtifact;
window.openLightbox = openLightbox;
window.loadJobs = loadJobs;
window.loadCampaignFolderSelect = loadCampaignFolderSelect;
window.openPostForCampaign = openPostForCampaign;
window.setSelectedCampaignForPost = (id) => { state.selectedCampaignId = id || null; };
window.clearCampaignJobFilter = clearCampaignJobFilter;
window.openJobsForCampaign = openJobsForCampaign;

updateCreateModeUI();
loadAll();
setInterval(loadAll, 10000);
