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
    messageInput: $('messageInput'), messageError: $('messageError'), charCount: $('charCount'),
    activityList: $('activityList'), toasts: $('toasts'),
    logoutDialog: $('logoutDialog'), logoutForm: $('logoutForm'), logoutConfirm: $('logoutConfirm'),
    authDialog: $('authDialog'), authForm: $('authForm'), authInput: $('authInput'), authError: $('authError')
  };

  const POLL_MS = 3000;
  let apiKey = '';
  try { apiKey = sessionStorage.getItem('gatewayApiKey') || ''; } catch (_) { /* storage unavailable */ }
  let lastState = null;
  let lastRenderedKey = '';
  let lastActivityHtml = '';
  let offline = false;
  let authPending = false;
  let switchBusy = false;

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

  el.authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = el.authInput.value.trim();
    if (!key) return;
    apiKey = key;
    try { sessionStorage.setItem('gatewayApiKey', key); } catch (_) { /* ignore */ }
    el.authInput.value = '';
    el.authDialog.close();
    authPending = false;
    fetchStatus();
  });
  el.authDialog.addEventListener('cancel', (e) => e.preventDefault()); // key is required to proceed

  // ---------------------------------------------------------------------------
  // Status polling
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
    el.recipientInput.disabled = !connected;
    el.messageInput.disabled = !connected;
    el.sendDisabledNote.hidden = connected;

    // Avoid re-rendering identical content so the QR image and focus do not flicker.
    const key = [state.status, state.qrCodeDataUrl ? state.qrCodeDataUrl.length : 0, state.lastError, state.user && state.user.id, state.lastConnectedAt].join('|');
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;

    el.connectBtn.hidden = true;
    el.logoutBtn.hidden = true;

    if (connected) {
      setPill('pill-ok', 'Connected');
      const id = (state.user && state.user.id) || '';
      const phone = id.split('@')[0].split(':')[0];
      el.connBody.innerHTML =
        '<div class="conn-icon ok" aria-hidden="true">&#10003;</div>' +
        '<div class="conn-ok"><div class="conn-account">' + escapeHtml((state.user && state.user.name) || 'WhatsApp linked') + '</div>' +
        '<div class="muted">+' + escapeHtml(phone) + '</div>' +
        (state.lastConnectedAt ? '<div class="muted small">Connected since ' + escapeHtml(state.lastConnectedAt) + '</div>' : '') +
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
    if (cfg.allowedNumbersCount > 0) filters.push('only ' + cfg.allowedNumbersCount + ' allowed number' + (cfg.allowedNumbersCount === 1 ? '' : 's'));
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

  function renderActivity(messages) {
    if (!messages.length) {
      const empty = '<li class="empty">No messages yet. New WhatsApp messages and your replies will show up here.</li>';
      if (lastActivityHtml !== empty) { el.activityList.innerHTML = empty; lastActivityHtml = empty; }
      return;
    }
    const html = messages.map((m) => {
      let who, tag;
      if (m.fromMe) {
        who = '<span>To ' + escapeHtml(m.recipient) + '</span><span class="sub">from ' + escapeHtml(m.sender) + '</span>';
        tag = '<span class="tag tag-info">Sent</span>';
      } else {
        who = '<span>' + escapeHtml(m.senderName || m.sender) + '</span>' +
          (m.senderName ? '<span class="sub">' + escapeHtml(m.sender) + '</span>' : '') +
          (m.isGroup ? '<span class="tag">Group</span>' : '');
        const t = STATUS_TAGS[m.webhookStatus] || ['tag', escapeHtml(m.webhookStatus || ''), ''];
        const title = m.webhookError || t[2];
        tag = '<span class="tag ' + t[0] + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + t[1] + '</span>';
      }
      const extra = m.hermesReply
        ? '<span class="reply">&#8618; ' + escapeHtml(m.hermesReply) + '</span>'
        : (m.webhookError ? '<span class="tag-error">' + escapeHtml(m.webhookError) + '</span>' : '');
      return '<li>' +
        '<div class="who">' + who + '</div>' +
        '<div class="when">' + escapeHtml(m.timestamp) + '</div>' +
        '<div class="body">' + escapeHtml(m.content) + '</div>' +
        '<div class="meta">' + tag + extra + '</div>' +
        '</li>';
    }).join('');
    // Only touch the DOM when something changed, so text selection survives the 3 s poll.
    if (html !== lastActivityHtml) { el.activityList.innerHTML = html; lastActivityHtml = html; }
  }

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

  function validateSend() {
    const recipient = el.recipientInput.value.trim();
    const message = el.messageInput.value.trim();
    let valid = true;

    const digits = recipient.replace(/[^0-9]/g, '');
    if (!recipient) {
      setFieldError(el.recipientInput, el.recipientError, 'Enter the phone number to send to.');
      valid = false;
    } else if (!recipient.includes('@') && (digits.length < 8 || digits.length > 15)) {
      setFieldError(el.recipientInput, el.recipientError, 'That does not look like a full phone number. Include the country code, e.g. 60123456789.');
      valid = false;
    } else {
      setFieldError(el.recipientInput, el.recipientError, '');
    }

    if (!message) {
      setFieldError(el.messageInput, el.messageError, 'Enter a message to send.');
      valid = false;
    } else {
      setFieldError(el.messageInput, el.messageError, '');
    }
    return valid ? { to: recipient, message: message } : null;
  }

  function setFieldError(input, errorNode, text) {
    errorNode.textContent = text;
    errorNode.hidden = !text;
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
  }

  el.recipientInput.addEventListener('input', () => setFieldError(el.recipientInput, el.recipientError, ''));
  el.messageInput.addEventListener('input', () => {
    setFieldError(el.messageInput, el.messageError, '');
    el.charCount.textContent = String(el.messageInput.value.length);
  });
  el.messageInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !el.sendBtn.disabled) {
      e.preventDefault();
      el.sendForm.requestSubmit();
    }
  });

  el.sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.sendResult.hidden = true;
    const payload = validateSend();
    if (!payload) {
      (el.recipientError.hidden ? el.messageInput : el.recipientInput).focus();
      return;
    }

    setBusy(el.sendBtn, true, 'Sending…');
    try {
      const { data } = await api('/api/send', { method: 'POST', body: payload });
      if (data.success) {
        showResult(el.sendResult, 'Message sent.', true);
        el.messageInput.value = '';
        el.charCount.textContent = '0';
        fetchStatus();
      } else {
        showResult(el.sendResult, data.error || 'The message could not be sent.', false);
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

  fetchStatus();
  setInterval(() => { if (!document.hidden) fetchStatus(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchStatus(); });
})();
