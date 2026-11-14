(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    statusPill: $('statusPill'), statusText: $('statusText'), offlineBanner: $('offlineBanner'),
    statReceived: $('statReceived'), statForwarded: $('statForwarded'), statReplies: $('statReplies'), statSent: $('statSent'),
    connBody: $('connBody'), connectBtn: $('connectBtn'), logoutBtn: $('logoutBtn'),
    webhookUrl: $('webhookUrl'), copyUrlBtn: $('copyUrlBtn'), webhookHint: $('webhookHint'),
    forwardSwitch: $('forwardSwitch'), filterInfo: $('filterInfo'), testBtn: $('testBtn'), testResult: $('testResult'),
    sendForm: $('sendForm'), sendBtn: $('sendBtn'), sendResult: $('sendResult'), sendDisabledNote: $('sendDisabledNote'),
    recipientInput: $('recipientInput'), recipientError: $('recipientError'),
    tabText: $('tabText'), tabImage: $('tabImage'), tabDoc: $('tabDoc'), tabSticker: $('tabSticker'),
    panelText: $('panelText'), panelImage: $('panelImage'), panelDoc: $('panelDoc'), panelSticker: $('panelSticker'),
    messageInput: $('messageInput'), messageError: $('messageError'), charCount: $('charCount'),
    imageUrlInput: $('imageUrlInput'), imageUrlError: $('imageUrlError'), imageFileInput: $('imageFileInput'), imagePickBtn: $('imagePickBtn'), imageFileBadge: $('imageFileBadge'), imageCaptionInput: $('imageCaptionInput'),
    docUrlInput: $('docUrlInput'), docUrlError: $('docUrlError'), docFileInput: $('docFileInput'), docPickBtn: $('docPickBtn'), docFileBadge: $('docFileBadge'), docFileNameInput: $('docFileNameInput'), docCaptionInput: $('docCaptionInput'),
    stickerUrlInput: $('stickerUrlInput'), stickerUrlError: $('stickerUrlError'), stickerFileInput: $('stickerFileInput'), stickerPickBtn: $('stickerPickBtn'), stickerFileBadge: $('stickerFileBadge'), stickerPackInput: $('stickerPackInput'), stickerAuthorInput: $('stickerAuthorInput'),
    activityNote: $('activityNote'), activitySearchInput: $('activitySearchInput'), activityFilterSelect: $('activityFilterSelect'),
    activityList: $('activityList'), toasts: $('toasts'),
    logoutDialog: $('logoutDialog'), logoutForm: $('logoutForm'), logoutConfirm: $('logoutConfirm'),
    authDialog: $('authDialog'), authForm: $('authForm'), authInput: $('authInput'), authError: $('authError')
  };

  const MAX_CLIENT_MEDIA_BYTES = 25 * 1024 * 1024;
  const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  });

  let apiKey = '';
  try { apiKey = sessionStorage.getItem('gatewayApiKey') || ''; } catch (_) { /* storage unavailable */ }
  let lastState = null;
  let lastRenderedKey = '';
  let lastActivityHtml = '';
  let offline = false;
  let authPending = false;
  let switchBusy = false;
  let currentSendMode = 'text';
  const selectedFiles = { image: null, doc: null, sticker: null };
  let replyContext = null;
  let streamAbort = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let streamActive = false;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message, isError) {
    const node = document.createElement('div');
    node.className = 'toast' + (isError ? ' err' : '');
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), isError ? 7000 : 4000);
  }

  function showResult(node, message, ok) {
    node.textContent = message;
    node.className = 'inline-result ' + (ok ? 'ok' : 'err');
    node.hidden = false;
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (busy) {
      button.dataset.label = button.textContent;
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + escapeHtml(label || button.textContent);
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }

  async function api(path, options) {
    const opts = Object.assign({ method: 'GET' }, options || {});
    opts.headers = Object.assign({ 'x-source': 'dashboard' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    if (apiKey) opts.headers['x-api-key'] = apiKey;

    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { data = { success: false, error: 'Unexpected response from server (HTTP ' + res.status + ')' }; }
    if (res.status === 401 && data && data.authRequired) {
      requestApiKey();
      throw new Error('Access key required');
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  function requestApiKey() {
    if (authPending) return;
    authPending = true;
    el.authError.hidden = !apiKey; // a stored key was rejected
    if (!el.authDialog.open) el.authDialog.showModal();
    el.authInput.focus();
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatWhenHtml(m) {
    if (m.isoTimestamp) {
      const d = new Date(m.isoTimestamp);
      if (!Number.isNaN(d.getTime())) {
        const timeStr = TIME_FMT.format(d);
        const dateStr = DATE_FMT.format(d).replace(/\//g, '-');
        return '<span class="when-time">' + escapeHtml(timeStr) + '</span><span class="when-date">' + escapeHtml(dateStr) + '</span>';
      }
    }
    const raw = String(m.timestamp || '');
    const parts = raw.split(' ');
    if (parts.length >= 2) {
      return '<span class="when-time">' + escapeHtml(parts.slice(1).join(' ')) + '</span><span class="when-date">' + escapeHtml(parts[0]) + '</span>';
    }
    return '<span class="when-time">' + escapeHtml(raw) + '</span>';
  }

  function disconnectEventStream() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (streamAbort) {
      streamAbort.abort();
      streamAbort = null;
    }
    streamActive = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer || authPending || document.hidden) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, reconnectAttempt)) + Math.floor(Math.random() * 400);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectEventStream(false);
    }, delay);
  }

  function parseSseFrame(frameText) {
    const lines = frameText.split('\n');
    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (eventName === 'status' && dataLines.length > 0) {
      try {
        const parsed = JSON.parse(dataLines.join('\n'));
        lastState = parsed;
        render(parsed);
      } catch (_) {
        // Ignore malformed SSE payload frame.
      }
    }
  }

  async function connectEventStream(resetBackoff) {
    disconnectEventStream();
    if (resetBackoff) reconnectAttempt = 0;

    const controller = new AbortController();
    streamAbort = controller;

    try {
      const headers = { Accept: 'text/event-stream' };
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch('/api/events', {
        method: 'GET',
        headers: headers,
        signal: controller.signal,
        cache: 'no-store'
      });

      if (res.status === 401) {
        let data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        if (offline) { offline = false; el.offlineBanner.hidden = true; }
        el.activityNote.textContent = 'Access key required';
        if (data && data.authRequired) {
          requestApiKey();
        } else {
          requestApiKey();
        }
        return;
      }

      if (res.status === 429) {
        streamActive = false;
        if (offline) { offline = false; el.offlineBanner.hidden = true; }
        el.activityNote.textContent = 'Rate limited — retrying…';
        toast('Too many authentication attempts. Retrying shortly…', true);
        scheduleReconnect();
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error('HTTP ' + res.status);
      }

      streamActive = true;
      reconnectAttempt = 0;
      if (offline) { offline = false; el.offlineBanner.hidden = true; }
      el.activityNote.textContent = 'Live updates';

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let sepIndex = buffer.indexOf('\n\n');
        while (sepIndex !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          parseSseFrame(frame);
          sepIndex = buffer.indexOf('\n\n');
        }
      }

      streamActive = false;
      if (!controller.signal.aborted) {
        el.activityNote.textContent = 'Reconnecting…';
        scheduleReconnect();
      }
    } catch (err) {
      streamActive = false;
      if (controller.signal.aborted) return;
      if (!offline) {
        offline = true;
        el.offlineBanner.hidden = false;
        setPill('pill-error', 'Server unreachable');
      }
      el.activityNote.textContent = 'Reconnecting…';
      scheduleReconnect();
    }
  }

  el.authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = el.authInput.value.trim();
    if (!key) return;
    apiKey = key;
    try { sessionStorage.setItem('gatewayApiKey', key); } catch (_) { /* ignore */ }
    el.authInput.value = '';
    el.authDialog.close();
    authPending = false;
    void connectEventStream(true);
  });
  el.authDialog.addEventListener('cancel', (e) => e.preventDefault()); // key is required to proceed

  // ---------------------------------------------------------------------------
  // Status updates (SSE + on-demand fallback after explicit actions)
  // ---------------------------------------------------------------------------

  async function fetchStatus() {
    try {
      const { ok, data } = await api('/api/status');
      if (ok && data && data.success && data.data) {
        if (offline) { offline = false; el.offlineBanner.hidden = true; }
        lastState = data.data;
        render(lastState);
      }
    } catch (err) {
      if (err.message === 'Access key required') return;
      if (!offline) {
        offline = true;
        el.offlineBanner.hidden = false;
        setPill('pill-error', 'Server unreachable');
      }
    }
  }

  function setPill(cls, text) {
    el.statusPill.className = 'pill ' + cls;
    el.statusText.textContent = text;
  }

  function render(state) {
    el.statReceived.textContent = state.stats.receivedCount;
    el.statForwarded.textContent = state.stats.forwardedToHermesCount;
    el.statReplies.textContent = state.stats.hermesRepliesCount;
    el.statSent.textContent = state.stats.sentCount;

    renderConnection(state);
    renderHermes(state);
    renderActivity(state.recentMessages || []);
  }

  function renderConnection(state) {
    const connected = state.status === 'connected';
    if (!el.sendBtn.dataset.label) el.sendBtn.disabled = !connected; // leave a busy button alone
    const formFields = [
      el.recipientInput, el.messageInput, el.imageUrlInput, el.imageFileInput, el.imagePickBtn, el.imageCaptionInput,
      el.docUrlInput, el.docFileInput, el.docPickBtn, el.docFileNameInput, el.docCaptionInput,
      el.stickerUrlInput, el.stickerFileInput, el.stickerPickBtn, el.stickerPackInput, el.stickerAuthorInput
    ];
    formFields.forEach((field) => { field.disabled = !connected; });
    el.sendDisabledNote.hidden = connected;

    // Avoid re-rendering identical content so the QR image and focus do not flicker.
    const key = [state.status, state.qrCodeDataUrl ? state.qrCodeDataUrl.length : 0, state.lastError, state.user && state.user.id, state.lastConnectedIso || state.lastConnectedAt].join('|');
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;

    el.connectBtn.hidden = true;
    el.logoutBtn.hidden = true;

    if (connected) {
      setPill('pill-ok', 'Connected');
      const id = (state.user && state.user.id) || '';
      const phone = id.split('@')[0].split(':')[0];
      let connectedSinceHtml = '';
      const iso = state.lastConnectedIso ? new Date(state.lastConnectedIso) : null;
      if (iso && !Number.isNaN(iso.getTime())) {
        const cTime = TIME_FMT.format(iso);
        const cDate = DATE_FMT.format(iso).replace(/\//g, '-');
        connectedSinceHtml = '<div class="small">Connected since ' + escapeHtml(cTime) + ' <span class="when-date">' + escapeHtml(cDate) + '</span></div>';
      } else if (state.lastConnectedAt) {
        connectedSinceHtml = '<div class="muted small">Connected since ' + escapeHtml(state.lastConnectedAt) + '</div>';
      }
      el.connBody.innerHTML =
        '<div class="conn-icon ok" aria-hidden="true">&#10003;</div>' +
        '<div class="conn-ok"><div class="conn-account">' + escapeHtml((state.user && state.user.name) || 'WhatsApp linked') + '</div>' +
        '<div class="muted">+' + escapeHtml(phone) + '</div>' +
        connectedSinceHtml +
        '</div>';
      el.logoutBtn.hidden = false;
    } else if (state.status === 'qr_ready' && state.qrCodeDataUrl) {
      setPill('pill-info', 'Scan QR code');
      el.connBody.innerHTML =
        '<img class="qr" src="' + state.qrCodeDataUrl + '" alt="WhatsApp QR code" width="220" height="220">' +
        '<ol class="qr-steps"><li>Open WhatsApp on your phone</li><li>Tap <strong>Menu</strong> or <strong>Settings</strong> &rarr; <strong>Linked devices</strong></li><li>Tap <strong>Link a device</strong> and scan this code</li></ol>';
    } else if (state.status === 'connecting' || state.status === 'qr_ready') {
      setPill('pill-warn', 'Connecting');
      el.connBody.innerHTML = '<div class="spinner" aria-hidden="true"></div><p class="muted">Connecting to WhatsApp&hellip;</p>';
    } else {
      setPill('pill-error', 'Not connected');
      el.connBody.innerHTML =
        '<div class="conn-icon err" aria-hidden="true">!</div>' +
        '<p class="conn-error">' + escapeHtml(state.lastError || 'WhatsApp is not connected.') + '</p>';
      el.connectBtn.textContent = state.lastError ? 'Reconnect' : 'Connect';
      el.connectBtn.hidden = false;
    }
  }

  function renderHermes(state) {
    const cfg = state.webhookConfig || {};
    const url = cfg.url || '';
    if (el.webhookUrl.textContent !== (url || 'Not configured')) {
      el.webhookUrl.textContent = url || 'Not configured';
      el.webhookUrl.classList.toggle('muted', !url);
    }
    el.copyUrlBtn.hidden = !url;
    if (!el.testBtn.dataset.label) el.testBtn.disabled = !url;
    if (!url) {
      el.webhookHint.textContent = 'Set HERMES_WEBHOOK_URL in .env and restart the gateway. Until then, messages are only shown here.';
    }

    // While a toggle request is in flight, keep the optimistic state instead of the server's old one.
    if (!switchBusy) {
      if (el.forwardSwitch.getAttribute('aria-checked') !== String(cfg.forwardingEnabled)) {
        el.forwardSwitch.setAttribute('aria-checked', String(cfg.forwardingEnabled));
      }
      el.forwardSwitch.disabled = !url;
    }

    const filters = [];
    if (cfg.allowedNumbersCount > 0) filters.push('only ' + cfg.allowedNumbersCount + ' allowed sender' + (cfg.allowedNumbersCount === 1 ? '' : 's'));
    if (cfg.forwardGroups === false) filters.push('group chats are skipped');
    el.filterInfo.hidden = filters.length === 0;
    el.filterInfo.textContent = filters.length ? 'Filters from .env: ' + filters.join(', ') + '.' : '';
  }

  const STATUS_TAGS = {
    forwarded: ['tag-purple', 'Sent to Hermes', 'Waiting for Hermes to answer'],
    processing: ['tag-info', 'Hermes is working', 'Hermes will reply later through the API'],
    replied: ['tag-ok', 'Replied by Hermes', ''],
    ignored: ['tag', 'No reply', 'Hermes chose not to answer'],
    failed: ['tag-error', 'Failed', ''],
    disabled: ['tag-warn', 'Not forwarded', 'HERMES_WEBHOOK_URL is not set'],
    paused: ['tag-warn', 'Paused', 'Forwarding is switched off'],
    filtered: ['tag', 'Filtered', 'Blocked by ALLOWED_NUMBERS / FORWARD_GROUPS']
  };

  function matchesActivityFilter(m, query, statusFilter) {
    if (statusFilter === 'inbound' && m.fromMe) return false;
    if (statusFilter === 'outbound' && !m.fromMe) return false;
    if (statusFilter === 'replied' && (m.fromMe || m.webhookStatus !== 'replied')) return false;
    if (statusFilter === 'processing' && (m.fromMe || m.webhookStatus !== 'processing')) return false;
    if (statusFilter === 'failed') {
      const isFailed = m.fromMe ? Boolean(m.deliveryError) : m.webhookStatus === 'failed';
      if (!isFailed) return false;
    }
    if (statusFilter === 'filtered' && (m.fromMe || (m.webhookStatus !== 'filtered' && m.webhookStatus !== 'paused'))) {
      return false;
    }

    if (!query) return true;
    const haystack = [
      m.sender, m.senderName, m.senderUsername, m.recipient, m.chatJid,
      m.content, m.hermesReply, m.webhookError, m.deliveryError, m.messageType
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return haystack.includes(query);
  }

  function renderActivity(messages) {
    if (!messages.length) {
      const empty = '<li class="empty">No messages yet. New WhatsApp messages and your replies will show up here.</li>';
      if (lastActivityHtml !== empty) { el.activityList.innerHTML = empty; lastActivityHtml = empty; }
      return;
    }
    const query = el.activitySearchInput.value.trim().toLowerCase();
    const statusFilter = el.activityFilterSelect.value;
    const visible = messages.filter((m) => matchesActivityFilter(m, query, statusFilter));
    if (!visible.length) {
      const noMatch = '<li class="empty">No messages match the current search or filter.</li>';
      if (lastActivityHtml !== noMatch) { el.activityList.innerHTML = noMatch; lastActivityHtml = noMatch; }
      return;
    }
    const html = visible.map((m) => {
      let who, tag;
      if (m.fromMe) {
        who = '<span>To ' + escapeHtml(m.recipient) + '</span><span class="sub">from ' + escapeHtml(m.sender) + '</span>';
        tag = m.deliveryError
          ? '<span class="tag tag-error" title="' + escapeHtml(m.deliveryError) + '">Failed</span>'
          : '<span class="tag tag-info">Sent</span>';
      } else {
        const handleLabel = m.senderUsername ? ('@' + m.senderUsername) : '';
        const subParts = [];
        if (handleLabel) subParts.push(handleLabel);
        if (m.senderName || handleLabel) subParts.push(m.sender);
        who = '<span>' + escapeHtml(m.senderName || handleLabel || m.sender) + '</span>' +
          (subParts.length ? '<span class="sub">' + escapeHtml(subParts.join(' · ')) + '</span>' : '') +
          (m.isGroup ? '<span class="tag">Group</span>' : '');
        const t = STATUS_TAGS[m.webhookStatus] || ['tag', escapeHtml(m.webhookStatus || ''), ''];
        const title = m.webhookError || t[2];
        tag = '<span class="tag ' + t[0] + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + t[1] + '</span>';
      }
      const extra = m.hermesReply
        ? '<span class="reply">&#8618; ' + escapeHtml(m.hermesReply) + '</span>'
        : (m.webhookError || m.deliveryError
          ? '<span class="tag-error">' + escapeHtml(m.webhookError || m.deliveryError) + '</span>'
          : '');
      let actions = '';
      if (!m.fromMe) {
        const replyTarget = m.chatJid || (m.senderUsername ? '@' + m.senderUsername : m.sender);
        const replyLabel = m.senderName || (m.senderUsername ? '@' + m.senderUsername : m.sender);
        actions = '<span class="activity-actions">' +
          '<button type="button" class="btn-inline" data-action="reply" data-id="' + escapeHtml(m.id) + '" data-target="' + escapeHtml(replyTarget) + '" data-label="' + escapeHtml(replyLabel) + '">Reply</button>' +
          (m.hasMedia ? '<button type="button" class="btn-inline" data-action="download" data-id="' + escapeHtml(m.id) + '">Download</button>' : '') +
          '</span>';
      }
      return '<li>' +
        '<div class="who">' + who + '</div>' +
        '<div class="when">' + formatWhenHtml(m) + '</div>' +
        '<div class="body">' + escapeHtml(m.content) + '</div>' +
        '<div class="meta">' + tag + extra + actions + '</div>' +
        '</li>';
    }).join('');
    // Only touch the DOM when visible items actually changed, preserving text selection.
    if (html !== lastActivityHtml) { el.activityList.innerHTML = html; lastActivityHtml = html; }
  }

  el.activitySearchInput.addEventListener('input', () => {
    renderActivity((lastState && lastState.recentMessages) || []);
  });
  el.activityFilterSelect.addEventListener('change', () => {
    renderActivity((lastState && lastState.recentMessages) || []);
  });

  async function downloadMediaFile(messageId, btn) {
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = 'Downloading…';
    try {
      const headers = {};
      if (apiKey) headers['x-api-key'] = apiKey;
      const res = await fetch('/api/media/' + encodeURIComponent(messageId), { headers: headers });
      if (res.status === 401) {
        requestApiKey();
        return;
      }
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) msg = errData.error;
        } catch (_) { /* ignore non-json error */ }
        toast('Download failed: ' + msg, true);
        return;
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const utf8Match = disp.match(/filename\*=UTF-8''([^;]+)/i);
      const asciiMatch = disp.match(/filename="([^"]+)"/i);
      const filename = utf8Match
        ? decodeURIComponent(utf8Match[1])
        : (asciiMatch ? asciiMatch[1] : ('media-' + messageId));
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      toast('Download failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }

  el.activityList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'reply') {
      const target = btn.dataset.target || '';
      const label = btn.dataset.label || target;
      el.recipientInput.value = target;
      replyContext = { recipient: target, messageId: btn.dataset.id || undefined };
      setFieldError(el.recipientInput, el.recipientError, '');
      el.sendForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (currentSendMode === 'text' && !el.messageInput.disabled) {
        el.messageInput.focus();
      } else if (!el.recipientInput.disabled) {
        el.recipientInput.focus();
      }
      toast('Replying to ' + label);
    } else if (action === 'download') {
      const id = btn.dataset.id;
      if (id) void downloadMediaFile(id, btn);
    }
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  el.connectBtn.addEventListener('click', async () => {
    setBusy(el.connectBtn, true, 'Connecting…');
    try {
      await api('/api/connect', { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      toast('Could not start the connection: ' + err.message, true);
    } finally {
      setBusy(el.connectBtn, false);
    }
  });

  el.logoutBtn.addEventListener('click', () => el.logoutDialog.showModal());
  el.logoutForm.addEventListener('submit', async (e) => {
    if (e.submitter !== el.logoutConfirm) return; // "Cancel" just closes the dialog
    e.preventDefault();
    setBusy(el.logoutConfirm, true, 'Logging out…');
    try {
      const { data } = await api('/api/logout', { method: 'POST' });
      if (data.success) toast('Logged out. Scan the QR code to link WhatsApp again.');
      else toast(data.error || 'Could not log out', true);
      await fetchStatus();
    } catch (err) {
      toast('Could not log out: ' + err.message, true);
    } finally {
      setBusy(el.logoutConfirm, false);
      el.logoutDialog.close();
    }
  });

  el.copyUrlBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.webhookUrl.textContent);
      toast('Webhook address copied');
    } catch (_) {
      toast('Copy is not available here. Select the text and copy it manually.', true);
    }
  });

  el.forwardSwitch.addEventListener('click', async () => {
    const enabled = el.forwardSwitch.getAttribute('aria-checked') !== 'true';
    el.forwardSwitch.setAttribute('aria-checked', String(enabled));
    el.forwardSwitch.disabled = true;
    switchBusy = true;
    try {
      const { data } = await api('/api/forwarding', { method: 'POST', body: { enabled: enabled } });
      if (!data.success) throw new Error(data.error || 'Request failed');
      toast(enabled ? 'Messages are being forwarded to Hermes.' : 'Forwarding paused. Hermes will not receive new messages.');
    } catch (err) {
      el.forwardSwitch.setAttribute('aria-checked', String(!enabled));
      toast('Could not change forwarding: ' + err.message, true);
    } finally {
      switchBusy = false;
      el.forwardSwitch.disabled = false;
    }
  });

  el.testBtn.addEventListener('click', async () => {
    setBusy(el.testBtn, true, 'Testing…');
    el.testResult.hidden = true;
    try {
      const { data } = await api('/api/webhook/test', { method: 'POST' });
      if (data.success) {
        showResult(el.testResult, 'Hermes is reachable (HTTP ' + data.status + ', ' + data.latencyMs + ' ms).', true);
      } else {
        showResult(el.testResult, data.error || ('Hermes answered HTTP ' + data.status), false);
      }
    } catch (err) {
      showResult(el.testResult, 'Test failed: ' + err.message, false);
    } finally {
      setBusy(el.testBtn, false);
    }
  });

  // Send mode switching
  const MODES = {
    text: { tab: el.tabText, panel: el.panelText, label: 'Send message' },
    image: { tab: el.tabImage, panel: el.panelImage, label: 'Send image' },
    doc: { tab: el.tabDoc, panel: el.panelDoc, label: 'Send document' },
    sticker: { tab: el.tabSticker, panel: el.panelSticker, label: 'Send sticker' }
  };

  function setSendMode(mode) {
    currentSendMode = mode;
    for (const [key, item] of Object.entries(MODES)) {
      const active = key === mode;
      item.tab.classList.toggle('active', active);
      item.tab.setAttribute('aria-selected', String(active));
      item.panel.hidden = !active;
    }
    el.sendBtn.textContent = MODES[mode].label;
    el.sendResult.hidden = true;
  }
  for (const [key, item] of Object.entries(MODES)) item.tab.addEventListener('click', () => setSendMode(key));

  function renderFileBadge(mode, badgeNode, fileInput, urlInput) {
    const file = selectedFiles[mode];
    if (!file) {
      badgeNode.hidden = true;
      badgeNode.innerHTML = '';
      return;
    }
    badgeNode.innerHTML =
      '<span class="file-badge-info">' + escapeHtml(file.name) + ' (' + escapeHtml(formatBytes(file.size)) + ')</span>' +
      '<button type="button" class="file-badge-remove">Remove</button>';
    badgeNode.hidden = false;
    badgeNode.querySelector('.file-badge-remove').addEventListener('click', () => {
      selectedFiles[mode] = null;
      fileInput.value = '';
      renderFileBadge(mode, badgeNode, fileInput, urlInput);
    });
  }

  function bindFilePicker(mode, btn, fileInput, textInput, badgeNode, errNode, onSelected) {
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size === 0) {
        selectedFiles[mode] = null;
        fileInput.value = '';
        renderFileBadge(mode, badgeNode, fileInput, textInput);
        setFieldError(textInput, errNode, 'Selected file is empty.');
        return;
      }
      if (file.size > MAX_CLIENT_MEDIA_BYTES) {
        selectedFiles[mode] = null;
        fileInput.value = '';
        renderFileBadge(mode, badgeNode, fileInput, textInput);
        setFieldError(textInput, errNode, 'File (' + formatBytes(file.size) + ') exceeds the 25 MB limit.');
        return;
      }
      if (onSelected) onSelected(file);
      const reader = new FileReader();
      reader.onload = () => {
        selectedFiles[mode] = { name: file.name, size: file.size, dataUrl: reader.result };
        textInput.value = '';
        setFieldError(textInput, errNode, '');
        renderFileBadge(mode, badgeNode, fileInput, textInput);
      };
      reader.onerror = () => {
        selectedFiles[mode] = null;
        fileInput.value = '';
        renderFileBadge(mode, badgeNode, fileInput, textInput);
        setFieldError(textInput, errNode, 'Could not read the selected file.');
      };
      reader.readAsDataURL(file);
    });
  }

  bindFilePicker('image', el.imagePickBtn, el.imageFileInput, el.imageUrlInput, el.imageFileBadge, el.imageUrlError);
  bindFilePicker('doc', el.docPickBtn, el.docFileInput, el.docUrlInput, el.docFileBadge, el.docUrlError, (file) => {
    if (!el.docFileNameInput.value.trim()) el.docFileNameInput.value = file.name;
  });
  bindFilePicker('sticker', el.stickerPickBtn, el.stickerFileInput, el.stickerUrlInput, el.stickerFileBadge, el.stickerUrlError);

  function isValidRecipientInput(recipient) {
    if (/^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/i.test(recipient)) return '';
    if (recipient.includes('@') && !recipient.startsWith('@')) {
      return 'Invalid WhatsApp ID. Use a phone number (60123456789), @username, or JID.';
    }
    if (recipient.startsWith('@') || /[a-zA-Z]/.test(recipient)) {
      const withoutAt = recipient.replace(/^@+/, '');
      const hashIdx = withoutAt.indexOf('#');
      const handle = (hashIdx === -1 ? withoutAt : withoutAt.slice(0, hashIdx)).toLowerCase();
      const pin = hashIdx === -1 ? '' : withoutAt.slice(hashIdx + 1).trim();
      if (recipient.startsWith('@') && /^\d+$/.test(handle)) {
        return 'WhatsApp @usernames must contain at least one letter. For phone numbers, omit "@".';
      }
      if (hashIdx !== -1 && !/^\d{4}$/.test(pin)) {
        return 'Username PIN after "#" must be 4 digits (e.g. @username#1234).';
      }
      if (!/^[a-z0-9._]{3,35}$/.test(handle) || !/[a-z]/.test(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) {
        return 'Enter a valid WhatsApp @username (3-35 letters, digits, "." or "_").';
      }
      return '';
    }
    const digits = recipient.replace(/[^0-9]/g, '');
    if (digits.length < 8 || digits.length > 15) {
      return 'Include the country code for phone numbers (e.g. 60123456789), or enter a @username.';
    }
    return '';
  }

  function validateSend() {
    const recipient = el.recipientInput.value.trim();
    let valid = true;

    if (!recipient) {
      setFieldError(el.recipientInput, el.recipientError, 'Enter a phone number or @username to send to.');
      valid = false;
    } else {
      const recipientErr = isValidRecipientInput(recipient);
      if (recipientErr) {
        setFieldError(el.recipientInput, el.recipientError, recipientErr);
        valid = false;
      } else {
        setFieldError(el.recipientInput, el.recipientError, '');
      }
    }

    const replyToId =
      replyContext && replyContext.recipient === recipient ? replyContext.messageId : undefined;

    if (currentSendMode === 'text') {
      const message = el.messageInput.value.trim();
      if (!message) {
        setFieldError(el.messageInput, el.messageError, 'Enter a message to send.');
        valid = false;
      } else {
        setFieldError(el.messageInput, el.messageError, '');
      }
      return valid
        ? { endpoint: '/api/send', body: { to: recipient, message: message, ...(replyToId ? { replyToMessageId: replyToId } : {}) } }
        : null;
    }

    if (currentSendMode === 'image') {
      const url = (selectedFiles.image && selectedFiles.image.dataUrl) || el.imageUrlInput.value.trim();
      if (!url) {
        setFieldError(el.imageUrlInput, el.imageUrlError, 'Enter an image URL or choose a file.');
        valid = false;
      } else {
        setFieldError(el.imageUrlInput, el.imageUrlError, '');
      }
      const caption = el.imageCaptionInput.value.trim();
      return valid
        ? {
            endpoint: '/api/send-image',
            body: { to: recipient, url: url, ...(caption ? { caption: caption } : {}), ...(replyToId ? { replyToMessageId: replyToId } : {}) }
          }
        : null;
    }

    if (currentSendMode === 'doc') {
      const url = (selectedFiles.doc && selectedFiles.doc.dataUrl) || el.docUrlInput.value.trim();
      if (!url) {
        setFieldError(el.docUrlInput, el.docUrlError, 'Enter a document URL or choose a file.');
        valid = false;
      } else {
        setFieldError(el.docUrlInput, el.docUrlError, '');
      }
      const fileName = el.docFileNameInput.value.trim();
      const caption = el.docCaptionInput.value.trim();
      return valid
        ? {
            endpoint: '/api/send-document',
            body: {
              to: recipient,
              url: url,
              ...(fileName ? { fileName: fileName } : {}),
              ...(caption ? { caption: caption } : {}),
              ...(replyToId ? { replyToMessageId: replyToId } : {})
            }
          }
        : null;
    }

    if (currentSendMode === 'sticker') {
      const url = (selectedFiles.sticker && selectedFiles.sticker.dataUrl) || el.stickerUrlInput.value.trim();
      if (!url) {
        setFieldError(el.stickerUrlInput, el.stickerUrlError, 'Enter a sticker image URL or choose a file.');
        valid = false;
      } else {
        setFieldError(el.stickerUrlInput, el.stickerUrlError, '');
      }
      const pack = el.stickerPackInput.value.trim();
      const author = el.stickerAuthorInput.value.trim();
      return valid
        ? {
            endpoint: '/api/send-sticker',
            body: {
              to: recipient,
              url: url,
              ...(pack ? { pack: pack } : {}),
              ...(author ? { author: author } : {}),
              ...(replyToId ? { replyToMessageId: replyToId } : {})
            }
          }
        : null;
    }

    return null;
  }

  function setFieldError(input, errorNode, text) {
    errorNode.textContent = text;
    errorNode.hidden = !text;
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
  }

  el.recipientInput.addEventListener('input', () => {
    setFieldError(el.recipientInput, el.recipientError, '');
    if (replyContext && el.recipientInput.value.trim() !== replyContext.recipient) {
      replyContext = null;
    }
  });
  el.messageInput.addEventListener('input', () => {
    setFieldError(el.messageInput, el.messageError, '');
    el.charCount.textContent = String(el.messageInput.value.length);
  });
  el.imageUrlInput.addEventListener('input', () => {
    setFieldError(el.imageUrlInput, el.imageUrlError, '');
    if (selectedFiles.image) {
      selectedFiles.image = null;
      el.imageFileInput.value = '';
      renderFileBadge('image', el.imageFileBadge, el.imageFileInput, el.imageUrlInput);
    }
  });
  el.docUrlInput.addEventListener('input', () => {
    setFieldError(el.docUrlInput, el.docUrlError, '');
    if (selectedFiles.doc) {
      selectedFiles.doc = null;
      el.docFileInput.value = '';
      renderFileBadge('doc', el.docFileBadge, el.docFileInput, el.docUrlInput);
    }
  });
  el.stickerUrlInput.addEventListener('input', () => {
    setFieldError(el.stickerUrlInput, el.stickerUrlError, '');
    if (selectedFiles.sticker) {
      selectedFiles.sticker = null;
      el.stickerFileInput.value = '';
      renderFileBadge('sticker', el.stickerFileBadge, el.stickerFileInput, el.stickerUrlInput);
    }
  });

  const onCtrlEnter = (e) => {
    if (!e.isComposing && (e.ctrlKey || e.metaKey) && e.key === 'Enter' && !el.sendBtn.disabled) {
      e.preventDefault();
      el.sendForm.requestSubmit();
    }
  };
  el.messageInput.addEventListener('keydown', onCtrlEnter);
  el.imageCaptionInput.addEventListener('keydown', onCtrlEnter);
  el.docCaptionInput.addEventListener('keydown', onCtrlEnter);
  el.stickerPackInput.addEventListener('keydown', onCtrlEnter);
  el.stickerAuthorInput.addEventListener('keydown', onCtrlEnter);

  el.sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.sendResult.hidden = true;
    const payload = validateSend();
    if (!payload) {
      if (!el.recipientError.hidden) {
        el.recipientInput.focus();
      } else if (currentSendMode === 'text') {
        el.messageInput.focus();
      } else if (currentSendMode === 'image') {
        el.imageUrlInput.focus();
      } else if (currentSendMode === 'doc') {
        el.docUrlInput.focus();
      } else if (currentSendMode === 'sticker') {
        el.stickerUrlInput.focus();
      }
      return;
    }

    const actionName = currentSendMode === 'text' ? 'message' : (currentSendMode === 'image' ? 'image' : (currentSendMode === 'doc' ? 'document' : 'sticker'));
    setBusy(el.sendBtn, true, 'Sending…');
    try {
      const { data } = await api(payload.endpoint, { method: 'POST', body: payload.body });
      if (data.success) {
        replyContext = null;
        showResult(el.sendResult, (currentSendMode === 'text' ? 'Message' : (currentSendMode === 'image' ? 'Image' : (currentSendMode === 'doc' ? 'Document' : 'Sticker'))) + ' sent.', true);
        if (currentSendMode === 'text') {
          el.messageInput.value = '';
          el.charCount.textContent = '0';
        } else if (currentSendMode === 'image') {
          el.imageUrlInput.value = el.imageCaptionInput.value = el.imageFileInput.value = '';
          selectedFiles.image = null;
          renderFileBadge('image', el.imageFileBadge, el.imageFileInput, el.imageUrlInput);
        } else if (currentSendMode === 'doc') {
          el.docUrlInput.value = el.docFileNameInput.value = el.docCaptionInput.value = el.docFileInput.value = '';
          selectedFiles.doc = null;
          renderFileBadge('doc', el.docFileBadge, el.docFileInput, el.docUrlInput);
        } else if (currentSendMode === 'sticker') {
          el.stickerUrlInput.value = el.stickerPackInput.value = el.stickerAuthorInput.value = el.stickerFileInput.value = '';
          selectedFiles.sticker = null;
          renderFileBadge('sticker', el.stickerFileBadge, el.stickerFileInput, el.stickerUrlInput);
        }
        if (!streamActive) void fetchStatus();
      } else {
        showResult(el.sendResult, data.error || ('The ' + actionName + ' could not be sent.'), false);
      }
    } catch (err) {
      showResult(el.sendResult, 'Could not send: ' + err.message, false);
    } finally {
      setBusy(el.sendBtn, false);
      if (lastState) el.sendBtn.disabled = lastState.status !== 'connected';
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  void connectEventStream(true);
  window.addEventListener('pagehide', disconnectEventStream);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !streamActive && !authPending) {
      void connectEventStream(true);
    }
  });
})();
