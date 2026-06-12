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
};

const API_KEY_STORAGE = 'tiktok_api_key';

function getStoredApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

function setStoredApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const key = getStoredApiKey();
  if (key) headers['X-API-Key'] = key;
  return headers;
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(API + url, {
    ...opts,
    headers: authHeaders(opts.headers || {}),
  });
  if (res.status === 401) {
    const key = prompt('API key bắt buộc (X-API-Key). Nhập key từ file .env:');
    if (key) {
      setStoredApiKey(key.trim());
      return fetchJSON(url, opts);
    }
    throw new Error('Unauthorized — cần API key');
  }
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

  const btn = $('btnSubmitJob');
  const caption = $('captionInput');
  const optional = $('captionOptional');
  const pill = $('globalModePill');
  const engageFields = $('engageFields');
  const postVideoFields = $('postVideoFields');

  if (engageFields) engageFields.style.display = mode === 'engage' ? 'block' : 'none';
  if (postVideoFields) postVideoFields.style.display = mode === 'engage' ? 'none' : 'block';

  if (btn) {
    btn.textContent = mode === 'manual'
      ? 'Chuẩn bị video trên máy'
      : (mode === 'engage' ? 'Bắt đầu treo tương tác' : 'Bắt đầu tự động đăng');
    btn.classList.toggle('manual-btn', mode === 'manual');
    btn.classList.toggle('engage-btn', mode === 'engage');
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
    jobs: 'Hàng đợi',
    devices: 'Thiết bị',
    errors: 'Mã lỗi',
  }[name] || 'Tổng quan';
  if (name === 'create') updateCreateModeUI();
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
    const authTag = state.auth?.enabled ? ' 🔐' : '';
    label.textContent = `${state.health.devices_online} máy online · ${workerLabel} · poll ${poll}${authTag}`;
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'ADB không kết nối';
  }

  const keyStatus = $('apiKeyStatus');
  if (keyStatus) {
    if (state.auth?.enabled) {
      keyStatus.textContent = getStoredApiKey() ? 'API key đã lưu' : 'Cần nhập API key';
      keyStatus.style.color = getStoredApiKey() ? 'var(--green)' : 'var(--yellow)';
    } else {
      keyStatus.textContent = 'Auth tắt (dev)';
      keyStatus.style.color = 'var(--muted)';
    }
  }
}

async function loadStats() {
  state.stats = await fetchJSON('/api/stats');
  const m = Object.fromEntries(state.stats.byStatus.map((s) => [s.status, s.c]));
  const running = RUNNING_STATUSES.reduce((a, s) => a + (m[s] || 0), 0);

  $('statsGrid').innerHTML = `
    <div class="stat-card"><div class="label">Tổng jobs</div><div class="value">${state.stats.total}</div></div>
    <div class="stat-card accent"><div class="label">Chờ xử lý</div><div class="value">${m.pending || 0}</div></div>
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

async function loadVideoList() {
  try {
    const videos = await fetchJSON('/api/videos');
    const select = $('videoPathSelect');
    if (!select) return;
    const cur = select.value;
    select.innerHTML = '<option value="">— Không chọn —</option>';
    videos.forEach((v) => {
      const mb = (v.size / 1024 / 1024).toFixed(1);
      select.innerHTML += `<option value="${v.path}">${v.name} (${mb} MB)</option>`;
    });
    select.value = cur;
  } catch (_) {}
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
  );

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
        <td>${statusBadge(j.status)}</td>
        <td style="color:var(--red);font-size:0.76rem">${esc(j.error_code || '-')}</td>
        <td class="mono">${fmtTime(j.created_at)}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn ghost small" onclick="openInspector('${j.id}')">Inspect</button>
          ${['failed', 'need_manual_check'].includes(j.status) ? `<button class="btn small" onclick="retryJob('${j.id}')">Retry</button>` : ''}
          ${CANCELLABLE_STATUSES.includes(j.status) ? `<button class="btn danger small" onclick="cancelJob('${j.id}')">Hủy</button>` : ''}
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="8" class="empty">Chưa có job</td></tr>';

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
    await Promise.all([loadHealth(), loadStats(), loadDevices(), loadJobs(), loadVideoList(), loadErrors()]);
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

  $('inspectorMeta').innerHTML = `
    ${extraPanel}
    ${errorHtml}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;margin-bottom:14px">
      <div><span style="color:var(--muted)">Status</span><br>${statusBadge(job.status)}</div>
      <div><span style="color:var(--muted)">Chế độ</span><br>${modeBadge(job.post_mode)}</div>
      <div><span style="color:var(--muted)">Device</span><br>${esc(job.device_id || '-')}</div>
      <div><span style="color:var(--muted)">TikTok TK</span><br>${esc(job.tiktok_account || '—')}</div>
      <div><span style="color:var(--muted)">Tạo lúc</span><br>${fmtTime(job.created_at)}</div>
      <div><span style="color:var(--muted)">Kết thúc</span><br>${fmtTime(job.finished_at)}</div>
      ${deliveryMethod ? `<div><span style="color:var(--muted)">Delivery</span><br><code>${esc(deliveryMethod)}</code></div>` : ''}
    </div>
    <div style="font-size:0.82rem"><span style="color:var(--muted)">Caption:</span><br>${esc(job.caption || '(trống)')}</div>
  `;

  const deliveryEvent = [...events].reverse().find((e) => e.step === 'deliver_video' && e.level === 'success');
  const deliveryMethod = deliveryEvent?.meta?.delivery_method
    || (deliveryEvent?.message?.includes('[share]') ? 'share' : (deliveryEvent?.message?.includes('[gallery]') ? 'gallery' : null));

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
$('btnSaveApiKey')?.addEventListener('click', () => {
  const val = ($('apiKeyInput')?.value || '').trim();
  setStoredApiKey(val);
  loadAll();
});
if ($('apiKeyInput')) $('apiKeyInput').value = getStoredApiKey();
$('btnLoadMoreJobs')?.addEventListener('click', () => loadMoreJobs());
$('errorSearch')?.addEventListener('input', debounce((e) => renderErrorsCatalog(e.target.value), 300));

['filterStatus', 'filterSearch', 'filterDevice', 'filterMode'].forEach((id) => {
  $(id)?.addEventListener('change', loadJobs);
  $(id)?.addEventListener('input', debounce(loadJobs, 400));
});

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

$('jobForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const caption = fd.get('caption') || '';
  const deviceId = fd.get('device_id');
  const tiktokAccount = (fd.get('tiktok_account') || '').trim();
  const postMode = getSelectedPostMode();
  const file = $('videoFile')?.files?.[0];
  const existingPath = fd.get('video_path');
  const btn = $('btnSubmitJob');

  if (postMode !== 'engage' && !file && !existingPath) {
    alert('Chọn video từ máy tính hoặc video có sẵn trên server');
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
    } else {
      btn.textContent = file ? 'Đang upload...' : 'Đang tạo job...';

      if (file) {
        const uploadFd = new FormData();
        uploadFd.append('video', file);
        uploadFd.append('caption', caption);
        uploadFd.append('post_mode', postMode);
        if (deviceId) uploadFd.append('device_id', deviceId);
        if (tiktokAccount) uploadFd.append('tiktok_account', tiktokAccount);
        const res = await fetch('/api/jobs/upload', { method: 'POST', body: uploadFd });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }
      } else {
        const body = { video_path: existingPath, caption, post_mode: postMode };
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

window.openInspector = openInspector;
window.retryJob = retryJob;
window.cancelJob = cancelJob;
window.liveScreenshot = liveScreenshot;
window.liveDump = liveDump;
window.viewDeviceLogs = viewDeviceLogs;
window.setDeviceAccount = setDeviceAccount;
window.previewArtifact = previewArtifact;
window.openLightbox = openLightbox;

updateCreateModeUI();
loadAll();
setInterval(loadAll, 5000);
