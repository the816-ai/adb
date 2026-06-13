(function () {
  const API_KEY_STORAGE = 'tiktok_api_key';

  const campState = {
    list: [],
    currentId: null,
    campaign: null,
    videos: [],
    jobStats: null,
    campaignJobs: [],
    videoJobMap: {},
    selectedIds: new Set(),
    dirty: false,
    logLines: [],
    pollTimer: null,
  };

  const STATUS_LABELS = {
    draft: 'Nháp',
    scheduled: 'Đã hẹn',
    running: 'Đang chạy',
    launching: 'Đang khởi chạy',
    completed: 'Hoàn thành',
    completed_with_errors: 'Xong (có lỗi)',
    failed: 'Thất bại',
    cancelled: 'Đã hủy',
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getStoredApiKey() {
    return localStorage.getItem(API_KEY_STORAGE) || '';
  }

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    const key = getStoredApiKey();
    if (key) headers['X-API-Key'] = key;
    return headers;
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: authHeaders(opts.headers || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  function logCampaign(msg, level = 'info') {
    const ts = new Date().toLocaleTimeString('vi-VN');
    campState.logLines.unshift(`<div class="log-${level}">[${ts}] ${esc(msg)}</div>`);
    campState.logLines = campState.logLines.slice(0, 80);
    const el = $('campaignLog');
    if (el) el.innerHTML = campState.logLines.join('');
  }

  function statusBadge(status) {
    const s = status || 'draft';
    return `<span class="campaign-status ${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
  }

  function stopCampaignPoll() {
    if (campState.pollTimer) {
      clearInterval(campState.pollTimer);
      campState.pollTimer = null;
    }
  }

  function startCampaignPoll() {
    stopCampaignPoll();
    if (!campState.currentId) return;
    campState.pollTimer = setInterval(() => {
      refreshCampaignStats(true).catch(() => {});
    }, 8000);
  }

  async function refreshCampaignStats(silent = false) {
    if (!campState.currentId) return;
    const [detail, jobsRes] = await Promise.all([
      fetchJSON(`/api/campaigns/${campState.currentId}`),
      fetchJSON(`/api/campaigns/${campState.currentId}/jobs?limit=100`),
    ]);
    campState.campaign = detail.campaign;
    campState.jobStats = detail.job_stats || null;
    campState.campaignJobs = jobsRes.jobs || [];
    campState.videoJobMap = buildVideoJobMap(campState.campaignJobs);
    if (detail.job_stats?.posted_paths) {
      campState.postedPaths = new Set(detail.job_stats.posted_paths);
    }
    renderCampaignStats();
    renderVideoTable();
    if (!silent) logCampaign('Đã cập nhật thống kê job', 'info');
  }

  function buildVideoJobMap(jobs) {
    const map = {};
    for (const j of jobs) {
      const prev = map[j.video_path];
      if (!prev || new Date(j.created_at) > new Date(prev.created_at)) {
        map[j.video_path] = j;
      }
    }
    return map;
  }

  function videoPostBadge(videoPath) {
    const job = campState.videoJobMap[videoPath];
    if (!job) return '<span class="video-posted-badge none">—</span>';
    if (job.status === 'done') return '<span class="video-posted-badge">Đã đăng</span>';
    if (['failed', 'need_manual_check'].includes(job.status)) {
      return '<span class="video-posted-badge failed">Lỗi</span>';
    }
    if (job.status === 'pending' && job.scheduled_at && new Date(job.scheduled_at) > new Date()) {
      return '<span class="video-posted-badge pending">Hẹn giờ</span>';
    }
    return '<span class="video-posted-badge pending">Đang chờ</span>';
  }

  function renderCampaignStats() {
    const jobs = campState.campaignJobs;
    const done = jobs.filter((j) => j.status === 'done').length;
    const failed = jobs.filter((j) => ['failed', 'need_manual_check'].includes(j.status)).length;
    const pending = jobs.filter((j) => j.status === 'pending').length;
    const active = jobs.filter((j) => !['done', 'failed', 'need_manual_check', 'ready_manual', 'pending'].includes(j.status)).length
      + jobs.filter((j) => j.status === 'pending' && (!j.scheduled_at || new Date(j.scheduled_at) <= new Date())).length;

    const statusEl = $('campStatStatus');
    if (statusEl) statusEl.innerHTML = statusBadge(campState.campaign?.status);
    if ($('campStatActive')) $('campStatActive').textContent = String(campState.jobStats?.active ?? active);
    if ($('campStatDone')) $('campStatDone').textContent = String(done);
    if ($('campStatPending')) $('campStatPending').textContent = String(pending);
    if ($('campStatFailed')) $('campStatFailed').textContent = String(failed);

    const mini = $('campaignJobsMini');
    if (!mini) return;
    const recent = [...jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6);
    if (!recent.length) {
      mini.style.display = 'none';
      return;
    }
    mini.style.display = 'block';
    mini.innerHTML = `
      <table>
        <thead><tr><th>Video</th><th>Status</th><th>Lịch</th></tr></thead>
        <tbody>
          ${recent.map((j) => `
            <tr>
              <td title="${esc(j.video_path)}">${esc(j.video_path.split('/').pop())}</td>
              <td>${esc(j.status)}</td>
              <td>${j.scheduled_at ? esc(new Date(j.scheduled_at).toLocaleString('vi-VN')) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function showListPane() {
    stopCampaignPoll();
    $('campaignListPane').style.display = '';
    $('campaignDetailPane').style.display = 'none';
    campState.currentId = null;
    campState.videos = [];
    campState.dirty = false;
  }

  function showDetailPane() {
    $('campaignListPane').style.display = 'none';
    $('campaignDetailPane').style.display = '';
  }

  async function loadCampaignList() {
    const res = await fetchJSON('/api/campaigns');
    campState.list = res.campaigns || [];
    renderCampaignList();
  }

  function renderCampaignList() {
    const body = $('campaignTableBody');
    if (!body) return;
    if (!campState.list.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">Chưa có thư mục — bấm「Tạo thư mục」để bắt đầu</td></tr>`;
      return;
    }
    body.innerHTML = campState.list.map((c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><input type="checkbox" class="camp-row-check" data-id="${esc(c.id)}"></td>
        <td><strong>${esc(c.name)}</strong><div style="font-size:0.72rem;color:var(--muted)">${esc(c.folder_slug)}</div></td>
        <td>${c.enabled_count ?? c.video_count ?? 0} / ${c.video_count ?? 0}</td>
        <td>${statusBadge(c.status)}</td>
        <td><button type="button" class="btn primary small btn-view-campaign" data-id="${esc(c.id)}">Xem danh sách</button></td>
      </tr>
    `).join('');

    body.querySelectorAll('.btn-view-campaign').forEach((btn) => {
      btn.addEventListener('click', () => openCampaign(btn.dataset.id));
    });
    body.querySelectorAll('.camp-row-check').forEach((cb) => {
      cb.addEventListener('change', updateDeleteButton);
    });
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const checks = [...document.querySelectorAll('.camp-row-check:checked')];
    const btn = $('btnDeleteCampaigns');
    if (btn) btn.disabled = checks.length === 0;
  }

  async function openCampaign(id) {
    const detail = await fetchJSON(`/api/campaigns/${id}`);
    campState.currentId = id;
    campState.campaign = detail.campaign;
    campState.videos = detail.videos || [];
    campState.jobStats = detail.job_stats || null;
    campState.dirty = false;
    campState.selectedIds.clear();
    showDetailPane();
    renderCampaignDetail();
    await fillDeviceSelect();
    await refreshCampaignStats(true);
    startCampaignPoll();
    logCampaign(`Mở thư mục「${detail.campaign.name}」— ${campState.videos.length} video`);
  }

  function renderCampaignDetail() {
    const c = campState.campaign;
    if (!c) return;
    $('campaignDetailName').textContent = c.name;
    const posted = campState.jobStats?.posted_paths?.length || 0;
    $('campaignDetailMeta').innerHTML = `
      ${esc(c.folder_slug)} · ${campState.videos.length} video
      · ${statusBadge(c.status)}
      ${posted ? ` · <span style="color:var(--green)">${posted} đã đăng</span>` : ''}
    `;
    if ($('campAccount')) $('campAccount').value = c.default_tiktok_account || '';
    if ($('campPostMode')) $('campPostMode').value = c.default_post_mode || 'auto';
    if ($('campIntervalMin')) $('campIntervalMin').value = c.interval_minutes || 20;
    if ($('campIntervalMax')) $('campIntervalMax').value = c.interval_min_max || c.interval_minutes || 25;
    if ($('campScheduleAt') && c.scheduled_start_at) {
      const d = new Date(c.scheduled_start_at);
      $('campScheduleAt').value = toDatetimeLocal(d);
    }
    renderVideoTable();
  }

  function toDatetimeLocal(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderVideoTable() {
    const body = $('campaignVideosBody');
    if (!body) return;
    if (!campState.videos.length) {
      body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Thư mục trống — tải video lên hoặc copy file vào <code>videos/${esc(campState.campaign?.folder_slug || '')}</code></td></tr>`;
      return;
    }
    body.innerHTML = campState.videos.map((v, i) => `
      <tr data-vid="${esc(v.id)}">
        <td>${i + 1}</td>
        <td><input type="checkbox" class="video-row-check" data-id="${esc(v.id)}" ${v.enabled ? 'checked' : ''}></td>
        <td><div class="video-thumb">▶</div></td>
        <td><div class="video-name-cell">📁 ${esc(v.video_name)}</div></td>
        <td>${videoPostBadge(v.video_path)}</td>
        <td><input type="text" class="vid-title" data-id="${esc(v.id)}" value="${esc(v.title || '')}"></td>
        <td><textarea class="vid-caption" data-id="${esc(v.id)}" rows="2">${esc(v.caption || '')}</textarea></td>
      </tr>
    `).join('');

    body.querySelectorAll('.vid-title, .vid-caption').forEach((el) => {
      el.addEventListener('input', () => { campState.dirty = true; });
    });
    body.querySelectorAll('.video-row-check').forEach((cb) => {
      cb.addEventListener('change', () => { campState.dirty = true; });
    });
  }

  function collectVideoItems() {
    return campState.videos.map((v) => {
      const titleEl = document.querySelector(`.vid-title[data-id="${v.id}"]`);
      const capEl = document.querySelector(`.vid-caption[data-id="${v.id}"]`);
      const enEl = document.querySelector(`.video-row-check[data-id="${v.id}"]`);
      return {
        id: v.id,
        title: titleEl ? titleEl.value : v.title,
        caption: capEl ? capEl.value : v.caption,
        enabled: enEl ? enEl.checked : v.enabled,
        sort_order: v.sort_order,
      };
    });
  }

  async function saveVideos() {
    if (!campState.currentId) return;
    const items = collectVideoItems();
    const res = await fetchJSON(`/api/campaigns/${campState.currentId}/videos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    campState.videos = res.videos || items;
    campState.dirty = false;
    logCampaign(`Đã lưu ${items.length} video + caption`, 'ok');
    renderVideoTable();
  }

  async function bulkCaption(mode, text) {
    if (!campState.currentId) return;
    if (campState.dirty) await saveVideos();
    const res = await fetchJSON(`/api/campaigns/${campState.currentId}/bulk-caption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, text, use_spin: true }),
    });
    campState.videos = res.videos || [];
    logCampaign(`Bulk「${mode}」— cập nhật ${res.updated} video`, 'ok');
    renderVideoTable();
  }

  async function fillDeviceSelect() {
    const sel = $('campDevice');
    if (!sel) return;
    try {
      const devices = await fetchJSON('/api/devices');
      const list = Array.isArray(devices) ? devices : (devices.devices || []);
      sel.innerHTML = '<option value="">— Tự chọn worker —</option>' + list.map((d) => {
        const acc = d.tiktok_account ? ` · ${d.tiktok_account}` : '';
        const busy = d.busy ? ' (busy)' : '';
        return `<option value="${esc(d.id)}" ${campState.campaign?.default_device_id === d.id ? 'selected' : ''}>${esc(d.label || d.id)}${esc(acc)}${busy}</option>`;
      }).join('');
    } catch (err) {
      sel.innerHTML = '<option value="">Không tải được devices</option>';
    }
  }

  function getLaunchPayload(scheduled) {
    const scheduleAt = scheduled ? $('campScheduleAt')?.value : null;
    if (scheduled && !scheduleAt) {
      throw new Error('Chọn giờ bắt đầu để đặt lịch');
    }
    const min = parseInt($('campIntervalMin')?.value || '0', 10);
    const max = parseInt($('campIntervalMax')?.value || String(min), 10);
    return {
      device_id: $('campDevice')?.value || null,
      tiktok_account: ($('campAccount')?.value || '').trim() || null,
      post_mode: $('campPostMode')?.value || 'auto',
      interval_minutes: min,
      interval_min_max: max > min ? max : null,
      immediate: !scheduled,
      scheduled_at: scheduled && scheduleAt ? new Date(scheduleAt).toISOString() : null,
    };
  }

  async function launchCampaign(scheduled) {
    if (!campState.currentId) return;
    if (campState.dirty) await saveVideos();
    const payload = getLaunchPayload(scheduled);
    logCampaign(scheduled ? 'Đang tạo lịch đăng...' : 'Đang đưa vào hàng đợi (đăng ngay)...', 'info');
    const res = await fetchJSON(`/api/campaigns/${campState.currentId}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const first = res.slots?.[0] ? new Date(res.slots[0]).toLocaleString('vi-VN') : 'ngay';
    const last = res.slots?.length ? new Date(res.slots[res.slots.length - 1]).toLocaleString('vi-VN') : '';
    logCampaign(`Tạo ${res.count} job · batch ${res.batch_id?.slice(0, 8)}… · ${first}${last ? ' → ' + last : ''}`, 'ok');
    if (window.loadJobs) window.loadJobs();
    await refreshCampaignStats(true);
    renderCampaignDetail();
  }

  async function uploadVideos(files) {
    if (!campState.currentId || !files?.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('videos', f));
    const res = await fetch(`/api/campaigns/${campState.currentId}/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    campState.videos = data.videos || [];
    logCampaign(`Tải lên ${data.uploaded?.length || 0} file`, 'ok');
    renderVideoTable();
  }

  function rangeSelect() {
    const from = parseInt($('campSelFrom')?.value || '1', 10);
    const to = parseInt($('campSelTo')?.value || '1', 10);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    document.querySelectorAll('.video-row-check').forEach((cb, idx) => {
      const n = idx + 1;
      cb.checked = n >= lo && n <= hi;
    });
    campState.dirty = true;
  }

  function bindEvents() {
    $('btnNewCampaign')?.addEventListener('click', async () => {
      const name = prompt('Tên thư mục / chiến dịch mới:');
      if (!name?.trim()) return;
      try {
        const c = await fetchJSON('/api/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        await loadCampaignList();
        openCampaign(c.id);
      } catch (err) {
        alert(err.message);
      }
    });

    $('btnRefreshCampaigns')?.addEventListener('click', loadCampaignList);
    $('btnBackCampaigns')?.addEventListener('click', () => {
      if (campState.dirty && !confirm('Có thay đổi chưa lưu. Rời đi?')) return;
      showListPane();
      loadCampaignList();
    });

    $('btnSaveCampaignVideos')?.addEventListener('click', () => saveVideos().catch((e) => alert(e.message)));
    $('btnSyncCampaign')?.addEventListener('click', async () => {
      if (!campState.currentId) return;
      const res = await fetchJSON(`/api/campaigns/${campState.currentId}/sync`, { method: 'POST' });
      campState.videos = res.videos || [];
      logCampaign('Đồng bộ file từ thư mục', 'ok');
      renderVideoTable();
    });

    $('btnBulkReplace')?.addEventListener('click', () => {
      const text = $('bulkReplaceText')?.value;
      bulkCaption('replace', text).catch((e) => alert(e.message));
    });
    $('btnBulkAppend')?.addEventListener('click', () => {
      const text = $('bulkAppendText')?.value;
      bulkCaption('append', text).catch((e) => alert(e.message));
    });
    document.querySelectorAll('[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', () => {
        bulkCaption(btn.dataset.bulk).catch((e) => alert(e.message));
      });
    });

    $('btnCampPostNow')?.addEventListener('click', () => {
      launchCampaign(false).catch((e) => { logCampaign(e.message, 'err'); alert(e.message); });
    });
    $('btnCampSchedule')?.addEventListener('click', () => {
      launchCampaign(true).catch((e) => { logCampaign(e.message, 'err'); alert(e.message); });
    });

    $('btnCampViewJobs')?.addEventListener('click', () => {
      if (campState.currentId && window.openJobsForCampaign) {
        window.openJobsForCampaign(campState.currentId);
      }
    });
    $('btnCampRefreshStats')?.addEventListener('click', () => {
      refreshCampaignStats().catch((e) => alert(e.message));
    });

    $('campaignUploadInput')?.addEventListener('change', (e) => {
      uploadVideos(e.target.files).catch((err) => alert(err.message));
      e.target.value = '';
    });

    $('btnCampRangeSelect')?.addEventListener('click', rangeSelect);

    $('campaignSelectAll')?.addEventListener('change', (e) => {
      document.querySelectorAll('.camp-row-check').forEach((cb) => { cb.checked = e.target.checked; });
      updateDeleteButton();
    });

    $('btnDeleteCampaigns')?.addEventListener('click', async () => {
      const ids = [...document.querySelectorAll('.camp-row-check:checked')].map((cb) => cb.dataset.id);
      if (!ids.length || !confirm(`Xóa ${ids.length} thư mục? (không xóa file video trên đĩa)`)) return;
      for (const id of ids) {
        await fetchJSON(`/api/campaigns/${id}`, { method: 'DELETE' });
      }
      await loadCampaignList();
    });
  }

  window.CampaignsUI = {
    onViewEnter() {
      if (campState.currentId) {
        openCampaign(campState.currentId).catch((e) => logCampaign(e.message, 'err'));
      } else {
        loadCampaignList().catch((e) => logCampaign(e.message, 'err'));
      }
    },
  };

  document.addEventListener('DOMContentLoaded', bindEvents);
})();
