'use strict';

(function () {
  const CHUNK_BYTES = 128 * 1024;
  const MAX_JAR_BYTES = 16 * 1024 * 1024;

  const els = {
    modeSubtitle: document.getElementById('mode-subtitle'),
    connPill: document.getElementById('conn-pill'),
    permPill: document.getElementById('perm-pill'),
    fpsPill: document.getElementById('fps-pill'),
    pingPill: document.getElementById('ping-pill'),
    btnDisconnect: document.getElementById('btn-disconnect'),
    toastBanner: document.getElementById('toast-banner'),
    overlayWarningBar: document.getElementById('overlay-warning-bar'),

    authView: document.getElementById('auth-view'),
    authForm: document.getElementById('auth-form'),
    cloudFields: document.getElementById('cloud-fields'),
    inputRelay: document.getElementById('input-relay'),
    inputRoom: document.getElementById('input-room'),
    inputPin: document.getElementById('input-pin'),
    authInfo: document.getElementById('auth-info'),
    authError: document.getElementById('auth-error'),
    btnConnect: document.getElementById('btn-connect'),

    consoleView: document.getElementById('console-view'),
    tabsList: document.getElementById('tabs-list'),
    btnStopAll: document.getElementById('btn-stop-all'),
    activeSlotTitle: document.getElementById('active-slot-title'),
    screenRes: document.getElementById('screen-res'),
    btnPixelated: document.getElementById('btn-pixelated'),
    btnScreenshot: document.getElementById('btn-screenshot'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    canvasStage: document.getElementById('canvas-stage'),
    canvas: document.getElementById('game-canvas'),
    stageOverlay: document.getElementById('stage-overlay'),

    btnKeepAlive: document.getElementById('btn-keepalive'),
    btnToggleVk: document.getElementById('btn-toggle-vk'),
    btnScaleNative: document.getElementById('btn-scale-native'),
    btnScaleFit: document.getElementById('btn-scale-fit'),
    selectFps: document.getElementById('select-fps'),
    selectQuality: document.getElementById('select-quality'),
    gamesCount: document.getElementById('games-count'),
    selectLaunchSlot: document.getElementById('select-launch-slot'),
    searchGames: document.getElementById('search-games'),
    gamesList: document.getElementById('games-list'),

    btnOpenCreateModal: document.getElementById('btn-open-create-modal'),
    modalCreateGame: document.getElementById('modal-create-game'),
    btnCloseCreate: document.getElementById('btn-close-create'),
    btnCancelCreate: document.getElementById('btn-cancel-create'),
    formCreateGame: document.getElementById('form-create-game'),
    createJarFile: document.getElementById('create-jar-file'),
    createTitle: document.getElementById('create-title'),
    createResPreset: document.getElementById('create-res-preset'),
    createCustomDims: document.getElementById('create-custom-dims'),
    createWidth: document.getElementById('create-width'),
    createHeight: document.getElementById('create-height'),
    createOrientation: document.getElementById('create-orientation'),
    createGraphics: document.getElementById('create-graphics'),
    createLaunchSlot: document.getElementById('create-launch-slot'),
    createFullscreen: document.getElementById('create-fullscreen'),
    createProgressWrap: document.getElementById('create-progress-wrap'),
    createProgressFill: document.getElementById('create-progress-fill'),
    createProgressText: document.getElementById('create-progress-text'),
    createError: document.getElementById('create-error'),
    btnSubmitCreate: document.getElementById('btn-submit-create'),

    modalEditGame: document.getElementById('modal-edit-game'),
    btnCloseEdit: document.getElementById('btn-close-edit'),
    btnCancelEdit: document.getElementById('btn-cancel-edit'),
    formEditGame: document.getElementById('form-edit-game'),
    editTitle: document.getElementById('edit-title'),
    editWidth: document.getElementById('edit-width'),
    editHeight: document.getElementById('edit-height'),
    editOrientation: document.getElementById('edit-orientation'),
    editGraphics: document.getElementById('edit-graphics'),
    editFullscreen: document.getElementById('edit-fullscreen'),
    editError: document.getElementById('edit-error'),
    btnSubmitEdit: document.getElementById('btn-submit-edit'),

    modalConfirmDelete: document.getElementById('modal-confirm-delete'),
    deleteConfirmMsg: document.getElementById('delete-confirm-msg'),
    btnCancelDelete: document.getElementById('btn-cancel-delete'),
    btnConfirmDelete: document.getElementById('btn-confirm-delete')
  };

  const ctx = els.canvas.getContext('2d');
  let mode = 'cloud'; // 'lan' or 'cloud'
  let ws = null;
  let authenticated = false;
  let allowControl = true;
  let sessionToken = null; // kept strictly in memory
  let memoryPairKey = '';  // extracted from #hash and cleared from URL bar
  let lastAttemptAutoMode = false;
  let autoLinkRetryEnabled = true;
  let serverState = { tabs: [], games: [], activeSlot: 0, keepAlive247: false, overlayGranted: true, fps: 15, quality: 72 };
  let gameWidth = 240;
  let gameHeight = 320;
  let pixelated = true;
  let pointerIsDown = false;
  let framesThisSec = 0;
  let lastFrameAt = 0;
  let lastStateRefreshReqAt = 0;
  let pingTimer = null;
  let decodingFrame = false;
  let decodingStartedAt = 0;
  let pendingFramePacket = null;
  let webpSupported = false;
  let h264Supported = false;
  let h264Decoder = null;
  let h264DecoderConfigKey = '';
  let hasH264Keyframe = false;
  let h264ContentW = 0;
  let h264ContentH = 0;
  let h264Seq = -1;
  let h264Slot = -1;
  let h264Pts = 0;
  let h264ErrorStreak = 0;
  let h264CodecProfile = 'avc1.42E01E';
  let lastFrameBytes = 0;
  let lastFrameCodec = 'JPEG';
  let relayVersion = 5;
  let hasFullFrame = false;
  let lastSeq = -1;
  let lastFrameSlot = -1;
  let lastKeyframeReqAt = 0;
  let toastTimer = null;
  let activeUploadState = null;
  let editingGamePath = '';
  let deletingGame = null;

  els.canvas.classList.add('pixelated');
  els.btnPixelated.classList.add('active');

  async function probeWebpSupport() {
    try {
      const tinyWebp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
        0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00
      ]);
      const blob = new Blob([tinyWebp], { type: 'image/webp' });
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        webpSupported = bmp && bmp.width === 1;
        if (bmp && typeof bmp.close === 'function') bmp.close();
      } else {
        const c = document.createElement('canvas');
        webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
      }
    } catch (_) {
      webpSupported = false;
    }
  }

  async function probeH264Support() {
    try {
      if (!window.isSecureContext || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
        h264Supported = false;
        return;
      }
      const res = await VideoDecoder.isConfigSupported({
        codec: 'avc1.42E01E',
        optimizeForLatency: true
      });
      h264Supported = Boolean(res && res.supported);
    } catch (_) {
      h264Supported = false;
    }
  }
  const capsProbePromise = Promise.all([probeWebpSupport(), probeH264Support()]);

  function showToast(msg, isError) {
    if (!msg) return;
    els.toastBanner.textContent = msg;
    els.toastBanner.className = 'toast-banner' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toastBanner.classList.add('hidden');
    }, 4500);
  }

  function showAuthInfo(msg) {
    if (!msg) {
      els.authInfo.classList.add('hidden');
      els.authInfo.textContent = '';
    } else {
      els.authInfo.textContent = msg;
      els.authInfo.classList.remove('hidden');
    }
  }

  function showAuthError(msg) {
    if (!msg) {
      els.authError.classList.add('hidden');
      els.authError.textContent = '';
    } else {
      els.authError.textContent = msg;
      els.authError.classList.remove('hidden');
    }
  }

  function parseInitialUrlParams() {
    const searchParams = new URLSearchParams(window.location.search);
    const rawHash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
    const hashParams = new URLSearchParams(rawHash);

    const relay = hashParams.get('relay') || searchParams.get('relay') || '';
    const room = hashParams.get('room') || searchParams.get('room') || '';
    const key = hashParams.get('key') || '';

    if (key) {
      memoryPairKey = key;
    }
    if (window.location.hash) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (_) {}
    }
    return { relay, room, hasKey: Boolean(memoryPairKey) };
  }

  async function detectMode() {
    const urlInfo = parseInitialUrlParams();
    let relaySelfDetected = false;
    let defaultRoom = 'J2M-MAIN';

    try {
      const resp = await fetch('/api/health', { cache: 'no-store' });
      if (resp.ok) {
        const info = await resp.json();
        if (info && info.mode === 'lan') {
          mode = 'lan';
          els.modeSubtitle.textContent = 'Chế độ LAN trực tiếp (Wi-Fi nội bộ)';
          els.cloudFields.classList.add('hidden');
          attemptAutoConnect(true);
          return;
        }
        if (info && info.service === 'j2me-cloud-relay') {
          relaySelfDetected = true;
          if (info.version) {
            relayVersion = Number(info.version) || 5;
          }
        }
      }
    } catch (_) {}

    try {
      const cfgResp = await fetch('/api/config', { cache: 'no-store' });
      if (cfgResp.ok) {
        const cfg = await cfgResp.json();
        if (cfg && cfg.defaultRoom) defaultRoom = String(cfg.defaultRoom);
      }
    } catch (_) {}

    mode = 'cloud';
    els.modeSubtitle.textContent = relaySelfDetected
      ? ('Chế độ Cloud Relay v' + relayVersion + ' (Render / Vercel)')
      : 'Chế độ Cloud Relay v5 (Render / Vercel)';
    els.cloudFields.classList.remove('hidden');

    if (urlInfo.relay) {
      els.inputRelay.value = urlInfo.relay;
    } else if (relaySelfDetected && window.location.protocol.startsWith('http')) {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      els.inputRelay.value = wsProto + '//' + window.location.host + '/ws';
    } else if (window.location.protocol.startsWith('http') && window.location.hostname !== 'localhost') {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      els.inputRelay.placeholder = wsProto + '//your-relay.onrender.com/ws';
    }

    els.inputRoom.value = (urlInfo.room || defaultRoom).toUpperCase();

    if (els.inputRoom.value && (els.inputRelay.value || relaySelfDetected)) {
      attemptAutoConnect(false);
    }
  }

  function attemptAutoConnect(isLan) {
    autoLinkRetryEnabled = true;
    showAuthInfo(isLan
      ? 'Đang thử liên kết tự động qua LAN…'
      : 'Đang tự động liên kết với máy chủ ' + els.inputRoom.value + '…');
    connectWithAuth({ autoProbe: true });
  }

  function normalizeRelayWsUrl(raw, roomId) {
    let val = String(raw || '').trim();
    if (!val) {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      val = wsProto + '//' + window.location.host + '/ws';
    } else if (!val.includes('://')) {
      val = 'wss://' + val;
    }
    const url = new URL(val);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    url.searchParams.set('role', 'viewer');
    url.searchParams.set('room', roomId);
    return url.toString();
  }

  function setConnStatus(text, kind) {
    els.connPill.textContent = text;
    els.connPill.className = 'pill ' + (kind || 'pill-muted');
  }

  function updatePermPill() {
    if (!authenticated) {
      els.permPill.textContent = '--';
      els.permPill.className = 'pill pill-muted';
      return;
    }
    if (allowControl) {
      els.permPill.textContent = 'Toàn quyền';
      els.permPill.className = 'pill pill-ok';
    } else {
      els.permPill.textContent = 'Chỉ xem';
      els.permPill.className = 'pill pill-warn';
    }
  }

  async function sendAuthHandshake(sock, pin) {
    await capsProbePromise;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    if (pin) {
      lastAttemptAutoMode = false;
      sock.send(JSON.stringify({ type: 'auth', pin: pin, key: memoryPairKey || '', token: sessionToken || '', supportsWebp: webpSupported, supportsH264: h264Supported }));
    } else if (memoryPairKey) {
      lastAttemptAutoMode = false;
      sock.send(JSON.stringify({ type: 'auth', key: memoryPairKey, token: sessionToken || '', supportsWebp: webpSupported, supportsH264: h264Supported }));
    } else {
      lastAttemptAutoMode = true;
      sock.send(JSON.stringify({ type: 'auth', mode: 'auto', token: sessionToken || '', supportsWebp: webpSupported, supportsH264: h264Supported }));
    }
  }

  function connectWithAuth(opts) {
    const autoProbe = Boolean(opts && opts.autoProbe);
    showAuthError('');
    if (!autoProbe) showAuthInfo('');

    const pin = els.inputPin.value.trim();
    let wsUrl;
    if (mode === 'lan') {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = wsProto + '//' + window.location.host + '/ws';
    } else {
      const room = els.inputRoom.value.trim().toUpperCase() || 'J2M-MAIN';
      els.inputRoom.value = room;
      try {
        wsUrl = normalizeRelayWsUrl(els.inputRelay.value, room);
      } catch (_) {
        showAuthError('Render Relay URL không hợp lệ.');
        return;
      }
    }

    closeSocket(false);
    els.btnConnect.disabled = true;
    setConnStatus('Đang kết nối…', 'pill-warn');

    const sock = new WebSocket(wsUrl);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      sendAuthHandshake(sock, pin);
    };

    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        handleTextMessage(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        enqueueFramePacket(ev.data);
      }
    };

    sock.onclose = () => {
      els.btnConnect.disabled = false;
      if (ws === sock) {
        ws = null;
        authenticated = false;
        hasFullFrame = false;
        lastSeq = -1;
        lastFrameSlot = -1;
        pendingFramePacket = null;
        resetH264Decoder();
        stopPingLoop();
        setConnStatus('Đã ngắt kết nối', 'pill-muted');
        updatePermPill();
        els.btnDisconnect.classList.add('hidden');
        els.consoleView.classList.add('hidden');
        els.authView.classList.remove('hidden');
      }
    };

    sock.onerror = () => {
      els.btnConnect.disabled = false;
      showAuthInfo('');
      showAuthError('Không thể kết nối tới máy chủ WebSocket.');
    };
  }

  function openSocket(e) {
    if (e) e.preventDefault();
    autoLinkRetryEnabled = true;
    connectWithAuth({ autoProbe: false });
  }

  function closeSocket(clearCreds) {
    stopPingLoop();
    if (ws) {
      const prev = ws;
      ws = null;
      try { prev.close(); } catch (_) {}
    }
    authenticated = false;
    hasFullFrame = false;
    lastSeq = -1;
    lastFrameSlot = -1;
    pendingFramePacket = null;
    resetH264Decoder();
    if (clearCreds) {
      sessionToken = null;
      autoLinkRetryEnabled = false;
      els.inputPin.value = '';
    }
    setConnStatus('Chưa kết nối', 'pill-muted');
    updatePermPill();
    els.btnDisconnect.classList.add('hidden');
    els.consoleView.classList.add('hidden');
    els.authView.classList.remove('hidden');
  }

  function sendCmd(obj) {
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function handleTextMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {
      case 'relay_status':
        if (msg.hostOnline === false) {
          setConnStatus('Máy chủ ĐT ngoại tuyến', 'pill-warn');
          showAuthInfo(msg.message || 'Đang chờ điện thoại máy chủ vào phòng…');
        } else if (msg.hostOnline === true && !authenticated && autoLinkRetryEnabled) {
          showAuthInfo('Điện thoại chủ vừa online — đang liên kết…');
          sendAuthHandshake(ws, els.inputPin.value.trim());
        } else if (msg.requiresReauth && authenticated) {
          authenticated = false;
          if (memoryPairKey || autoLinkRetryEnabled) {
            sendAuthHandshake(ws, els.inputPin.value.trim());
          } else {
            els.consoleView.classList.add('hidden');
            els.authView.classList.remove('hidden');
            showAuthError('Máy chủ vừa kết nối lại, vui lòng nhập lại PIN.');
          }
        }
        break;

      case 'auth_ok':
        authenticated = true;
        allowControl = msg.allowControl !== false;
        if (msg.token) sessionToken = msg.token;
        els.btnConnect.disabled = false;
        showAuthError('');
        showAuthInfo('');
        els.authView.classList.add('hidden');
        els.consoleView.classList.remove('hidden');
        els.btnDisconnect.classList.remove('hidden');
        setConnStatus(mode === 'lan' ? 'LAN Trực tuyến' : 'Cloud Trực tuyến', 'pill-cyan');
        updatePermPill();
        startPingLoop();
        sendCmd({ type: 'get_state', supportsWebp: webpSupported, supportsH264: h264Supported });
        break;

      case 'auth_error':
        els.btnConnect.disabled = false;
        showAuthInfo('');
        if (msg.hostOffline) {
          showAuthInfo('Điện thoại máy chủ hiện chưa online. Tự động kết nối ngay khi điện thoại mở app.');
          return;
        }
        if (msg.wasAuto || (lastAttemptAutoMode && msg.requiresPin)) {
          autoLinkRetryEnabled = false;
          showAuthInfo('Máy chủ chưa bật Tự động liên kết. Hãy nhập mã PIN 6 số hoặc bật Tự động liên kết trong app Android.');
          return;
        }
        showAuthError(msg.message || 'Xác thực thất bại.');
        break;

      case 'permissions':
        allowControl = msg.allowControl !== false;
        updatePermPill();
        break;

      case 'pong': {
        const rtt = Math.max(1, Date.now() - Number(msg.t || Date.now()));
        els.pingPill.textContent = rtt + ' ms';
        els.pingPill.className = 'pill ' + (rtt < 120 ? 'pill-ok' : 'pill-warn');
        break;
      }

      case 'server_state':
        serverState = msg;
        allowControl = msg.allowControl !== false;
        updatePermPill();
        renderServerState();
        break;

      case 'game_op_result':
        handleGameOpResult(msg);
        break;
    }
  }

  function handleGameOpResult(msg) {
    const op = msg.op || '';
    if (op === 'upload_begin') {
      if (!msg.ok) {
        finishUploadUiWithError(msg.message || 'Không bắt đầu được phiên tải lên');
        return;
      }
      if (activeUploadState) {
        activeUploadState.uploadId = msg.uploadId;
        pumpNextUploadChunk();
      }
      return;
    }
    if (op === 'upload_chunk') {
      if (!msg.ok) {
        finishUploadUiWithError(msg.message || 'Lỗi gửi gói JAR');
        return;
      }
      if (activeUploadState && msg.uploadId === activeUploadState.uploadId) {
        const pct = Math.min(95, Math.round((Number(msg.receivedBytes || 0) / activeUploadState.bytes.length) * 100));
        els.createProgressFill.style.width = pct + '%';
        els.createProgressText.textContent = 'Đang tải lên máy chủ… ' + pct + '%';
        pumpNextUploadChunk();
      }
      return;
    }
    if (op === 'upload_finish') {
      els.btnSubmitCreate.disabled = false;
      activeUploadState = null;
      if (msg.ok) {
        els.createProgressFill.style.width = '100%';
        closeCreateModal();
        showToast(msg.message || 'Đã tạo & cài đặt game mới thành công', false);
      } else {
        els.createProgressWrap.classList.add('hidden');
        showCreateError(msg.message || 'Cài đặt game thất bại');
      }
      return;
    }
    if (op === 'get_game_config') {
      if (msg.ok && msg.gameConfig) {
        openEditModalWithConfig(msg.gameConfig);
      } else {
        showToast(msg.message || 'Không đọc được cấu hình game', true);
      }
      return;
    }
    if (op === 'edit_game') {
      els.btnSubmitEdit.disabled = false;
      if (msg.ok) {
        closeEditModal();
        showToast(msg.message || 'Đã lưu thay đổi game', false);
      } else {
        showEditError(msg.message || 'Lưu thất bại');
      }
      return;
    }
    if (op === 'delete_game' || op === 'launch_game' || op === 'upload_launch') {
      showToast(msg.message || (msg.ok ? 'Thành công' : 'Thao tác thất bại'), !msg.ok);
    }
  }

  function renderServerState() {
    const tabs = Array.isArray(serverState.tabs) ? serverState.tabs : [];
    const activeSlot = Number(serverState.activeSlot || 0);

    els.overlayWarningBar.classList.toggle('hidden', serverState.overlayGranted !== false);

    // Tabs list
    els.tabsList.textContent = '';
    if (tabs.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'Chưa có tab giả lập nào đang mở';
      els.tabsList.appendChild(empty);
      els.activeSlotTitle.textContent = lastFrameAt > 0 && (Date.now() - lastFrameAt) < 3000
        ? 'Đang đồng bộ tab…'
        : 'Chưa có game đang chạy';
      if (lastFrameAt === 0 || (Date.now() - lastFrameAt) > 3500) {
        els.stageOverlay.classList.remove('hidden');
      }
    } else {
      const currentTab = tabs.find((t) => Number(t.slotIndex) === activeSlot) || tabs[0];
      els.activeSlotTitle.textContent = 'Tab ' + (currentTab.slotIndex + 1) + ' • ' + (currentTab.appName || 'MIDlet');
      els.stageOverlay.classList.add('hidden');

      tabs.forEach((tab) => {
        const chip = document.createElement('div');
        chip.className = 'tab-chip' + (Number(tab.slotIndex) === activeSlot ? ' active' : '');

        const btnSelect = document.createElement('button');
        btnSelect.type = 'button';
        btnSelect.className = 'tab-select-btn';
        btnSelect.textContent = 'Tab ' + (Number(tab.slotIndex) + 1) + ': ' + (tab.appName || 'Game');
        btnSelect.addEventListener('click', () => {
          hasFullFrame = false;
          hasH264Keyframe = false;
          sendCmd({ type: 'select_tab', slotIndex: Number(tab.slotIndex) });
        });

        const btnStop = document.createElement('button');
        btnStop.type = 'button';
        btnStop.className = 'tab-stop-btn';
        btnStop.title = 'Đóng Tab';
        btnStop.textContent = '×';
        btnStop.addEventListener('click', () => {
          sendCmd({ type: 'stop_slot', slotIndex: Number(tab.slotIndex) });
        });

        chip.appendChild(btnSelect);
        chip.appendChild(btnStop);
        els.tabsList.appendChild(chip);
      });
    }

    const keepOn = Boolean(serverState.keepAlive247);
    els.btnKeepAlive.textContent = keepOn ? 'Đang bật 24/24' : 'Đang tắt';
    els.btnKeepAlive.classList.toggle('on', keepOn);

    if (serverState.fps) els.selectFps.value = String(serverState.fps);
    if (serverState.quality) els.selectQuality.value = String(serverState.quality);

    renderGamesLibrary();
  }

  function renderGamesLibrary() {
    const games = Array.isArray(serverState.games) ? serverState.games : [];
    const query = els.searchGames.value.trim().toLowerCase();
    const filtered = query
      ? games.filter((g) =>
          String(g.title || '').toLowerCase().includes(query) ||
          String(g.author || '').toLowerCase().includes(query)
        )
      : games;

    els.gamesCount.textContent = String(games.length);
    els.gamesList.textContent = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = games.length === 0 ? 'Thư viện trên điện thoại đang trống.' : 'Không tìm thấy game phù hợp.';
      els.gamesList.appendChild(empty);
      return;
    }

    filtered.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'game-row';

      const info = document.createElement('div');
      info.className = 'game-info';

      const title = document.createElement('div');
      title.className = 'game-title';
      title.textContent = g.title || 'Java Game';

      const meta = document.createElement('div');
      meta.className = 'game-meta';
      meta.textContent = (g.author || 'J2ME') + ' • v' + (g.version || '1.0');

      info.appendChild(title);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'game-actions';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn btn-primary btn-sm';
      playBtn.textContent = 'Chạy';
      playBtn.addEventListener('click', () => {
        const slotVal = els.selectLaunchSlot.value;
        const payload = { type: 'launch_game', path: g.path };
        if (slotVal !== 'auto') payload.slotIndex = Number(slotVal);
        sendCmd(payload);
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => {
        sendCmd({ type: 'get_game_config', path: g.path });
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-danger-outline btn-sm';
      delBtn.textContent = 'Xóa';
      delBtn.addEventListener('click', () => {
        openConfirmDeleteModal(g);
      });

      actions.appendChild(playBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);
      els.gamesList.appendChild(row);
    });
  }

  // Create / Upload JAR Game Modal logic
  function showCreateError(msg) {
    if (!msg) {
      els.createError.classList.add('hidden');
      els.createError.textContent = '';
    } else {
      els.createError.textContent = msg;
      els.createError.classList.remove('hidden');
    }
  }

  function closeCreateModal() {
    els.modalCreateGame.classList.add('hidden');
    activeUploadState = null;
    els.btnSubmitCreate.disabled = false;
    els.createProgressWrap.classList.add('hidden');
    showCreateError('');
  }

  function finishUploadUiWithError(msg) {
    activeUploadState = null;
    els.btnSubmitCreate.disabled = false;
    els.createProgressWrap.classList.add('hidden');
    showCreateError(msg);
  }

  function arrayBufferToBase64(uint8) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < uint8.length; i += step) {
      const sub = uint8.subarray(i, Math.min(i + step, uint8.length));
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }

  function pumpNextUploadChunk() {
    if (!activeUploadState || !ws || ws.readyState !== WebSocket.OPEN) return;
    const st = activeUploadState;
    if (st.offset >= st.bytes.length) {
      els.createProgressFill.style.width = '98%';
      els.createProgressText.textContent = 'Đang chuyển đổi JAR sang DEX trên điện thoại…';
      sendCmd({ type: 'upload_finish', uploadId: st.uploadId });
      return;
    }
    const end = Math.min(st.offset + CHUNK_BYTES, st.bytes.length);
    const slice = st.bytes.subarray(st.offset, end);
    st.offset = end;
    const b64 = arrayBufferToBase64(slice);
    sendCmd({ type: 'upload_chunk', uploadId: st.uploadId, data: b64 });
  }

  els.createResPreset.addEventListener('change', () => {
    const val = els.createResPreset.value;
    if (val === 'custom') {
      els.createCustomDims.classList.remove('hidden');
    } else {
      els.createCustomDims.classList.add('hidden');
      const parts = val.split('x');
      if (parts.length === 2) {
        els.createWidth.value = parts[0];
        els.createHeight.value = parts[1];
      }
    }
  });

  els.btnOpenCreateModal.addEventListener('click', () => {
    els.formCreateGame.reset();
    els.createResPreset.value = '240x320';
    els.createCustomDims.classList.add('hidden');
    els.createWidth.value = '240';
    els.createHeight.value = '320';
    els.createProgressWrap.classList.add('hidden');
    showCreateError('');
    els.modalCreateGame.classList.remove('hidden');
  });
  els.btnCloseCreate.addEventListener('click', closeCreateModal);
  els.btnCancelCreate.addEventListener('click', closeCreateModal);

  els.formCreateGame.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showCreateError('');
    if (!allowControl) {
      showCreateError('Máy chủ đang ở chế độ Chỉ xem.');
      return;
    }
    const file = els.createJarFile.files && els.createJarFile.files[0];
    if (!file) {
      showCreateError('Vui lòng chọn tệp .JAR.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.jar')) {
      showCreateError('Chỉ hỗ trợ định dạng .JAR.');
      return;
    }
    if (file.size <= 0 || file.size > MAX_JAR_BYTES) {
      showCreateError('Tệp .JAR không hợp lệ hoặc vượt quá 16 MB.');
      return;
    }

    try {
      els.btnSubmitCreate.disabled = true;
      els.createProgressWrap.classList.remove('hidden');
      els.createProgressFill.style.width = '4%';
      els.createProgressText.textContent = 'Đang đọc tệp JAR…';

      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        finishUploadUiWithError('Tệp không có chữ ký ZIP/JAR hợp lệ.');
        return;
      }

      const preset = els.createResPreset.value;
      let width = Number(els.createWidth.value) || 240;
      let height = Number(els.createHeight.value) || 320;
      if (preset !== 'custom') {
        const parts = preset.split('x');
        width = Number(parts[0]) || 240;
        height = Number(parts[1]) || 320;
      }

      const launchChoice = els.createLaunchSlot.value;
      const autoLaunch = launchChoice !== 'none';
      const payload = {
        type: 'upload_begin',
        fileName: file.name,
        totalBytes: bytes.length,
        title: els.createTitle.value.trim(),
        width,
        height,
        orientation: Number(els.createOrientation.value) || 0,
        graphicsMode: Number(els.createGraphics.value) || 1,
        forceFullscreen: Boolean(els.createFullscreen.checked),
        autoLaunch
      };
      if (autoLaunch && launchChoice !== 'auto') {
        payload.slotIndex = Number(launchChoice);
      }

      activeUploadState = { bytes, offset: 0, uploadId: '' };
      if (!sendCmd(payload)) {
        finishUploadUiWithError('Mất kết nối WebSocket tới máy chủ.');
      }
    } catch (_) {
      finishUploadUiWithError('Không đọc được tệp đã chọn.');
    }
  });

  // Edit Game Modal logic
  function showEditError(msg) {
    if (!msg) {
      els.editError.classList.add('hidden');
      els.editError.textContent = '';
    } else {
      els.editError.textContent = msg;
      els.editError.classList.remove('hidden');
    }
  }

  function openEditModalWithConfig(cfg) {
    editingGamePath = cfg.path || '';
    els.editTitle.value = cfg.title || '';
    els.editWidth.value = String(cfg.width || 240);
    els.editHeight.value = String(cfg.height || 320);
    els.editOrientation.value = String(cfg.orientation || 0);
    els.editGraphics.value = String(cfg.graphicsMode !== undefined ? cfg.graphicsMode : 1);
    els.editFullscreen.checked = Boolean(cfg.forceFullscreen);
    els.btnSubmitEdit.disabled = false;
    showEditError('');
    els.modalEditGame.classList.remove('hidden');
  }

  function closeEditModal() {
    els.modalEditGame.classList.add('hidden');
    editingGamePath = '';
    els.btnSubmitEdit.disabled = false;
    showEditError('');
  }

  els.btnCloseEdit.addEventListener('click', closeEditModal);
  els.btnCancelEdit.addEventListener('click', closeEditModal);

  els.formEditGame.addEventListener('submit', (ev) => {
    ev.preventDefault();
    showEditError('');
    if (!editingGamePath) return;
    els.btnSubmitEdit.disabled = true;
    sendCmd({
      type: 'edit_game',
      path: editingGamePath,
      title: els.editTitle.value.trim(),
      width: Number(els.editWidth.value) || 240,
      height: Number(els.editHeight.value) || 320,
      orientation: Number(els.editOrientation.value) || 0,
      graphicsMode: Number(els.editGraphics.value) || 1,
      forceFullscreen: Boolean(els.editFullscreen.checked)
    });
  });

  // Confirm Delete Modal logic
  function openConfirmDeleteModal(game) {
    deletingGame = game;
    els.deleteConfirmMsg.textContent =
      'Game "' + (game.title || 'Java Game') + '" và dữ liệu lưu trên máy chủ sẽ bị xóa. Nếu đang mở, tab sẽ tự đóng.';
    els.modalConfirmDelete.classList.remove('hidden');
  }

  function closeConfirmDeleteModal() {
    deletingGame = null;
    els.modalConfirmDelete.classList.add('hidden');
  }

  els.btnCancelDelete.addEventListener('click', closeConfirmDeleteModal);
  els.btnConfirmDelete.addEventListener('click', () => {
    if (deletingGame) {
      sendCmd({ type: 'delete_game', path: deletingGame.path });
    }
    closeConfirmDeleteModal();
  });

  // Binary WebP/JPEG Video Receiver (Full + Dirty-Rect Delta) + RTT seq ACK pacing
  function maybeRequestKeyframe(ackSeq) {
    const now = Date.now();
    if ((now - lastKeyframeReqAt) > 250) {
      lastKeyframeReqAt = now;
      sendCmd({ type: 'request_keyframe' });
    }
    if (ackSeq >= 0) {
      sendCmd({ type: 'frame_ack', seq: ackSeq });
    }
  }

  async function decodeImageBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      return {
        img: bmp,
        width: bmp.width,
        height: bmp.height,
        cleanup: () => { if (bmp && typeof bmp.close === 'function') bmp.close(); }
      };
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        resolve({
          img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          cleanup: () => URL.revokeObjectURL(url)
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('decode failed'));
      };
      img.src = url;
    });
  }

  function resetH264Decoder() {
    hasH264Keyframe = false;
    h264Seq = -1;
    h264Slot = -1;
    h264DecoderConfigKey = '';
    if (h264Decoder) {
      try {
        if (h264Decoder.state !== 'closed') h264Decoder.close();
      } catch (_) {}
      h264Decoder = null;
    }
  }

  function hex2(n) {
    return (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
  }

  function extractAvcCodecFromAnnexB(bytes) {
    if (!bytes || bytes.length < 8) return null;
    const limit = bytes.length - 6;
    for (let i = 0; i < limit; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) {
        let start = -1;
        if (bytes[i + 2] === 1) {
          start = i + 3;
        } else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) {
          start = i + 4;
        }
        if (start >= 0 && start + 3 < bytes.length) {
          if ((bytes[start] & 0x1F) === 7) {
            return 'avc1.' + hex2(bytes[start + 1]) + hex2(bytes[start + 2]) + hex2(bytes[start + 3]);
          }
          i = start - 1;
        }
      }
    }
    return null;
  }

  function onH264VideoFrame(frame) {
    try {
      const cw = h264ContentW > 0 ? h264ContentW : frame.displayWidth;
      const ch = h264ContentH > 0 ? h264ContentH : frame.displayHeight;
      if (cw > 0 && ch > 0) {
        gameWidth = cw;
        gameHeight = ch;
        if (els.canvas.width !== cw || els.canvas.height !== ch) {
          els.canvas.width = cw;
          els.canvas.height = ch;
        }
        ctx.imageSmoothingEnabled = !pixelated;
        const srcW = Math.min(cw, frame.displayWidth || cw);
        const srcH = Math.min(ch, frame.displayHeight || ch);
        ctx.drawImage(frame, 0, 0, srcW, srcH, 0, 0, cw, ch);
        els.stageOverlay.classList.add('hidden');
        const kb = Math.max(1, Math.round(lastFrameBytes / 1024));
        els.screenRes.textContent = cw + ' × ' + ch + ' • H.264 ' + kb + ' KB';
        framesThisSec += 1;
        lastFrameAt = Date.now();

        if ((!serverState.tabs || serverState.tabs.length === 0) && (lastFrameAt - lastStateRefreshReqAt) > 1500) {
          lastStateRefreshReqAt = lastFrameAt;
          sendCmd({ type: 'get_state', supportsWebp: webpSupported, supportsH264: h264Supported });
        }
      }
    } finally {
      frame.close();
    }
  }

  function onH264DecoderError() {
    hasH264Keyframe = false;
    h264ErrorStreak += 1;
    resetH264Decoder();
    if (h264ErrorStreak >= 3) {
      h264Supported = false;
      sendCmd({ type: 'disable_h264' });
      showToast('Trình duyệt không giải mã được H.264 — tự động chuyển về WebP/JPEG', false);
    } else {
      maybeRequestKeyframe(-1);
    }
  }

  function handleH264Packet(buf) {
    if (buf.byteLength <= 11) return;
    const view = new DataView(buf);
    const flags = view.getUint8(0);
    const slot = flags & 0x0F;
    const isDelta = (flags & 0x40) !== 0;
    const isKey = !isDelta;
    const hasSeq = (flags & 0x20) !== 0;

    const contentW = view.getUint16(1);
    const contentH = view.getUint16(3);
    const seq = view.getUint16(5);
    const encW = view.getUint16(7);
    const encH = view.getUint16(9);

    if (!h264Supported || typeof VideoDecoder !== 'function') {
      sendCmd({ type: 'disable_h264' });
      sendCmd(hasSeq ? { type: 'frame_ack', seq } : { type: 'frame_ack' });
      return;
    }

    if (isDelta) {
      const expectedSeq = (h264Seq + 1) & 0xFFFF;
      const seqInvalid = hasSeq && h264Seq >= 0 && seq !== expectedSeq;
      if (!hasH264Keyframe || slot !== h264Slot || seqInvalid) {
        hasH264Keyframe = false;
        maybeRequestKeyframe(seq);
        return;
      }
    }

    const nalBytes = new Uint8Array(buf, 11);
    if (isKey) {
      const parsedCodec = extractAvcCodecFromAnnexB(nalBytes);
      if (parsedCodec) {
        h264CodecProfile = parsedCodec;
      }
      const cfgKey = h264CodecProfile + ':' + encW + 'x' + encH;
      if (!h264Decoder || h264Decoder.state === 'closed' || h264DecoderConfigKey !== cfgKey) {
        resetH264Decoder();
        try {
          h264Decoder = new VideoDecoder({
            output: onH264VideoFrame,
            error: onH264DecoderError
          });
          h264Decoder.configure({
            codec: h264CodecProfile,
            codedWidth: encW,
            codedHeight: encH,
            optimizeForLatency: true
          });
          h264DecoderConfigKey = cfgKey;
        } catch (_) {
          onH264DecoderError();
          sendCmd(hasSeq ? { type: 'frame_ack', seq } : { type: 'frame_ack' });
          return;
        }
      }
    }

    if (!h264Decoder || h264Decoder.state !== 'configured') {
      hasH264Keyframe = false;
      maybeRequestKeyframe(seq);
      return;
    }

    try {
      h264ContentW = contentW;
      h264ContentH = contentH;
      h264Slot = slot;
      if (hasSeq) h264Seq = seq;
      if (isKey) hasH264Keyframe = true;
      h264Pts += 33333;
      lastFrameBytes = nalBytes.byteLength;
      lastFrameCodec = 'H.264';
      const chunk = new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: h264Pts,
        data: nalBytes
      });
      h264Decoder.decode(chunk);
      h264ErrorStreak = 0;
      sendCmd(hasSeq ? { type: 'frame_ack', seq } : { type: 'frame_ack' });
    } catch (_) {
      onH264DecoderError();
      sendCmd(hasSeq ? { type: 'frame_ack', seq } : { type: 'frame_ack' });
    }
  }

  function enqueueFramePacket(buf) {
    if (buf && buf.byteLength > 0) {
      const flags = new DataView(buf).getUint8(0);
      if ((flags & 0x10) !== 0) {
        handleH264Packet(buf);
        return;
      }
      if (h264Decoder) {
        resetH264Decoder();
      }
      const isDelta = (flags & 0x40) !== 0;
      // Never overwrite an unrendered full keyframe with a subsequent delta patch
      if (isDelta && pendingFramePacket && pendingFramePacket.byteLength > 0) {
        const prevFlags = new DataView(pendingFramePacket).getUint8(0);
        if ((prevFlags & 0x40) === 0) {
          return;
        }
      }
      pendingFramePacket = buf;
    }
    if (decodingFrame && (Date.now() - decodingStartedAt) > 2000) {
      decodingFrame = false;
    }
    if (!decodingFrame) {
      processNextFrame();
    }
  }

  async function processNextFrame() {
    if (!pendingFramePacket) return;
    decodingFrame = true;
    decodingStartedAt = Date.now();
    const buf = pendingFramePacket;
    pendingFramePacket = null;

    let decoded = null;
    try {
      const view = new DataView(buf);
      if (buf.byteLength <= 5) return;
      const flags = view.getUint8(0);
      const slot = flags & 0x0F;
      const isWebp = (flags & 0x80) !== 0;
      const isDelta = (flags & 0x40) !== 0;
      const hasSeq = (flags & 0x20) !== 0;

      const w = view.getUint16(1);
      const h = view.getUint16(3);
      let hdrLen = 5;
      let seq = -1;
      let dx = 0;
      let dy = 0;
      let dw = 0;
      let dh = 0;

      if (hasSeq) {
        if (buf.byteLength <= 7) return;
        seq = view.getUint16(5);
        hdrLen = 7;
        if (isDelta) {
          if (buf.byteLength <= 15) return;
          dx = view.getUint16(7);
          dy = view.getUint16(9);
          dw = view.getUint16(11);
          dh = view.getUint16(13);
          hdrLen = 15;
        }
      }

      if (w > 0 && h > 0) {
        gameWidth = w;
        gameHeight = h;
      }

      if (isDelta) {
        const expectedSeq = (lastSeq + 1) & 0xFFFF;
        const seqInvalid = hasSeq && lastSeq >= 0 && seq !== expectedSeq;
        if (!hasFullFrame || slot !== lastFrameSlot || seqInvalid || dw <= 0 || dh <= 0
            || dx + dw > els.canvas.width || dy + dh > els.canvas.height) {
          hasFullFrame = false;
          maybeRequestKeyframe(seq);
          return;
        }
      }

      const imgSlice = buf.slice(hdrLen);
      lastFrameBytes = imgSlice.byteLength;
      lastFrameCodec = isWebp ? 'WebP' : 'JPEG';
      const blob = new Blob([imgSlice], { type: isWebp ? 'image/webp' : 'image/jpeg' });
      decoded = await decodeImageBlob(blob);

      ctx.imageSmoothingEnabled = !pixelated;
      if (isDelta) {
        if (decoded.width !== dw || decoded.height !== dh) {
          hasFullFrame = false;
          maybeRequestKeyframe(seq);
          return;
        }
        ctx.drawImage(decoded.img, dx, dy);
      } else {
        if (els.canvas.width !== decoded.width || els.canvas.height !== decoded.height) {
          els.canvas.width = decoded.width;
          els.canvas.height = decoded.height;
        }
        ctx.drawImage(decoded.img, 0, 0);
        hasFullFrame = true;
      }

      lastFrameSlot = slot;
      if (hasSeq) {
        lastSeq = seq;
      }

      els.stageOverlay.classList.add('hidden');
      const kb = Math.max(1, Math.round(lastFrameBytes / 1024));
      els.screenRes.textContent = gameWidth + ' × ' + gameHeight + ' • ' + lastFrameCodec + ' ' + kb + ' KB' + (isDelta ? ' (patch)' : ' (full)');
      framesThisSec += 1;
      lastFrameAt = Date.now();

      sendCmd(hasSeq ? { type: 'frame_ack', seq: seq } : { type: 'frame_ack' });

      if ((!serverState.tabs || serverState.tabs.length === 0) && (lastFrameAt - lastStateRefreshReqAt) > 1500) {
        lastStateRefreshReqAt = lastFrameAt;
        sendCmd({ type: 'get_state', supportsWebp: webpSupported, supportsH264: h264Supported });
      }
    } catch (_) {
      // ignore corrupted frame
    } finally {
      if (decoded && decoded.cleanup) {
        try { decoded.cleanup(); } catch (_) {}
      }
      decodingFrame = false;
      if (pendingFramePacket) {
        processNextFrame();
      }
    }
  }

  function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
        sendCmd({ type: 'ping', t: Date.now() });
      }
      els.fpsPill.textContent = framesThisSec + ' FPS';
      els.fpsPill.className = 'pill ' + (framesThisSec > 0 ? 'pill-ok' : 'pill-muted');
      framesThisSec = 0;
      if (lastFrameAt > 0 && Date.now() - lastFrameAt > 4000 && (!serverState.tabs || serverState.tabs.length === 0)) {
        els.stageOverlay.classList.remove('hidden');
      }
    }, 1000);
  }

  function stopPingLoop() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  // Keypad pointer press & release
  document.querySelectorAll('.jkey[data-key]').forEach((btn) => {
    const code = Number(btn.getAttribute('data-key'));
    const press = (ev) => {
      ev.preventDefault();
      btn.classList.add('pressed');
      sendCmd({ type: 'key', action: 'down', code: code });
    };
    const release = (ev) => {
      ev.preventDefault();
      if (!btn.classList.contains('pressed')) return;
      btn.classList.remove('pressed');
      sendCmd({ type: 'key', action: 'up', code: code });
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  // Canvas pointer touch/mouse mapping
  function mapCanvasCoords(ev) {
    const rect = els.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const x = Math.round(((ev.clientX - rect.left) / rect.width) * gameWidth);
    const y = Math.round(((ev.clientY - rect.top) / rect.height) * gameHeight);
    return {
      x: Math.max(0, Math.min(gameWidth, x)),
      y: Math.max(0, Math.min(gameHeight, y))
    };
  }

  els.canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    els.canvas.focus();
    pointerIsDown = true;
    const pt = mapCanvasCoords(ev);
    sendCmd({ type: 'pointer', action: 'down', x: pt.x, y: pt.y });
  });

  els.canvas.addEventListener('pointermove', (ev) => {
    if (!pointerIsDown) return;
    ev.preventDefault();
    const pt = mapCanvasCoords(ev);
    sendCmd({ type: 'pointer', action: 'move', x: pt.x, y: pt.y });
  });

  const endCanvasPointer = (ev) => {
    if (!pointerIsDown) return;
    pointerIsDown = false;
    const pt = mapCanvasCoords(ev);
    sendCmd({ type: 'pointer', action: 'up', x: pt.x, y: pt.y });
  };
  els.canvas.addEventListener('pointerup', endCanvasPointer);
  els.canvas.addEventListener('pointercancel', endCanvasPointer);

  // PC keyboard mapping
  const PC_KEY_MAP = {
    ArrowUp: -1, KeyW: -1,
    ArrowDown: -2, KeyS: -2,
    ArrowLeft: -3, KeyA: -3,
    ArrowRight: -4, KeyD: -4,
    Enter: -5, Space: -5,
    KeyQ: -6, BracketLeft: -6, F1: -6,
    KeyE: -7, BracketRight: -7, F2: -7,
    Backspace: -8, Escape: -8,
    Digit0: 48, Numpad0: 48,
    Digit1: 49, Numpad1: 49,
    Digit2: 50, Numpad2: 50,
    Digit3: 51, Numpad3: 51,
    Digit4: 52, Numpad4: 52,
    Digit5: 53, Numpad5: 53,
    Digit6: 54, Numpad6: 54,
    Digit7: 55, Numpad7: 55,
    Digit8: 56, Numpad8: 56,
    Digit9: 57, Numpad9: 57,
    NumpadMultiply: 42
  };
  const heldPcKeys = new Set();

  function resolveMidpKey(ev) {
    if (ev.key === '*') return 42;
    if (ev.key === '#') return 35;
    return PC_KEY_MAP[ev.code] || null;
  }

  window.addEventListener('keydown', (ev) => {
    if (!authenticated) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const midp = resolveMidpKey(ev);
    if (midp === null) return;
    ev.preventDefault();
    if (!heldPcKeys.has(ev.code)) {
      heldPcKeys.add(ev.code);
      sendCmd({ type: 'key', action: 'down', code: midp });
    } else {
      sendCmd({ type: 'key', action: 'repeat', code: midp });
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (!authenticated) return;
    if (!heldPcKeys.has(ev.code)) return;
    heldPcKeys.delete(ev.code);
    const midp = resolveMidpKey(ev);
    if (midp !== null) {
      ev.preventDefault();
      sendCmd({ type: 'key', action: 'up', code: midp });
    }
  });

  // UI Listeners
  els.authForm.addEventListener('submit', openSocket);
  els.btnDisconnect.addEventListener('click', () => closeSocket(true));
  els.btnStopAll.addEventListener('click', () => sendCmd({ type: 'stop_all' }));

  els.btnKeepAlive.addEventListener('click', () => {
    sendCmd({ type: 'toggle_keepalive', enabled: !serverState.keepAlive247 });
  });
  els.btnToggleVk.addEventListener('click', () => sendCmd({ type: 'midlet_cmd', command: 'TOGGLE_VK' }));
  els.btnScaleNative.addEventListener('click', () => sendCmd({ type: 'midlet_cmd', command: 'SCALE_NATIVE' }));
  els.btnScaleFit.addEventListener('click', () => sendCmd({ type: 'midlet_cmd', command: 'SCALE_FIT' }));

  const onStreamSettingChange = () => {
    sendCmd({
      type: 'set_stream',
      fps: Number(els.selectFps.value),
      quality: Number(els.selectQuality.value)
    });
  };
  els.selectFps.addEventListener('change', onStreamSettingChange);
  els.selectQuality.addEventListener('change', onStreamSettingChange);
  els.searchGames.addEventListener('input', renderGamesLibrary);

  els.btnPixelated.addEventListener('click', () => {
    pixelated = !pixelated;
    els.canvas.classList.toggle('pixelated', pixelated);
    els.btnPixelated.classList.toggle('active', pixelated);
  });

  els.btnScreenshot.addEventListener('click', () => {
    try {
      const link = document.createElement('a');
      link.download = 'j2me-cloud-' + Date.now() + '.png';
      link.href = els.canvas.toDataURL('image/png');
      link.click();
    } catch (_) {}
  });

  els.btnFullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (els.canvasStage.requestFullscreen) {
      els.canvasStage.requestFullscreen().catch(() => {});
    }
  });

  detectMode();
})();
