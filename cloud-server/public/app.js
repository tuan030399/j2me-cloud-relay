'use strict';

(function () {
  const els = {
    modeSubtitle: document.getElementById('mode-subtitle'),
    connPill: document.getElementById('conn-pill'),
    permPill: document.getElementById('perm-pill'),
    fpsPill: document.getElementById('fps-pill'),
    pingPill: document.getElementById('ping-pill'),
    btnDisconnect: document.getElementById('btn-disconnect'),

    authView: document.getElementById('auth-view'),
    authForm: document.getElementById('auth-form'),
    cloudFields: document.getElementById('cloud-fields'),
    inputRelay: document.getElementById('input-relay'),
    inputRoom: document.getElementById('input-room'),
    inputPin: document.getElementById('input-pin'),
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
    gamesList: document.getElementById('games-list')
  };

  const ctx = els.canvas.getContext('2d');
  let mode = 'cloud'; // 'lan' or 'cloud'
  let ws = null;
  let authenticated = false;
  let allowControl = true;
  let sessionToken = null; // kept strictly in memory
  let serverState = { tabs: [], games: [], activeSlot: 0, keepAlive247: false, fps: 15, quality: 72 };
  let gameWidth = 240;
  let gameHeight = 320;
  let pixelated = true;
  let pointerIsDown = false;
  let framesThisSec = 0;
  let lastFrameAt = 0;
  let pingTimer = null;
  let decodingFrame = false;
  let pendingFramePacket = null;

  els.canvas.classList.add('pixelated');
  els.btnPixelated.classList.add('active');

  async function detectMode() {
    const params = new URLSearchParams(window.location.search);
    const paramRelay = params.get('relay') || '';
    const paramRoom = params.get('room') || '';

    let relaySelfDetected = false;
    try {
      const resp = await fetch('/api/health', { cache: 'no-store' });
      if (resp.ok) {
        const info = await resp.json();
        if (info && info.mode === 'lan') {
          mode = 'lan';
          els.modeSubtitle.textContent = 'Chế độ LAN trực tiếp (Wi-Fi nội bộ)';
          els.cloudFields.classList.add('hidden');
          return;
        }
        if (info && info.service === 'j2me-cloud-relay') {
          relaySelfDetected = true;
        }
      }
    } catch (_) {
      // ignore, fallback to cloud mode (e.g. Vercel static host)
    }

    mode = 'cloud';
    els.modeSubtitle.textContent = 'Chế độ Cloud Relay (Render / Vercel)';
    els.cloudFields.classList.remove('hidden');

    if (paramRelay) {
      els.inputRelay.value = paramRelay;
    } else if (relaySelfDetected && window.location.protocol.startsWith('http')) {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      els.inputRelay.value = wsProto + '//' + window.location.host + '/ws';
    } else if (window.location.protocol.startsWith('http') && window.location.hostname !== 'localhost') {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      els.inputRelay.placeholder = wsProto + '//your-relay.onrender.com/ws';
    }
    if (paramRoom) {
      els.inputRoom.value = paramRoom;
    }
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

  function showAuthError(msg) {
    if (!msg) {
      els.authError.classList.add('hidden');
      els.authError.textContent = '';
    } else {
      els.authError.textContent = msg;
      els.authError.classList.remove('hidden');
    }
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

  function openSocket(e) {
    if (e) e.preventDefault();
    showAuthError('');
    const pin = els.inputPin.value.trim();
    if (!pin) {
      showAuthError('Vui lòng nhập mã PIN ghép nối.');
      return;
    }

    let wsUrl;
    if (mode === 'lan') {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = wsProto + '//' + window.location.host + '/ws';
    } else {
      const room = els.inputRoom.value.trim().toUpperCase();
      if (!room) {
        showAuthError('Vui lòng nhập Mã phòng (Room ID).');
        return;
      }
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
      sock.send(JSON.stringify({ type: 'auth', pin: pin, token: sessionToken || '' }));
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
        stopPingLoop();
        setConnStatus('Đã ngắt kết nối', 'pill-muted');
        updatePermPill();
        els.btnDisconnect.classList.add('hidden');
        els.consoleView.classList.add('hidden');
        els.authView.classList.remove('hidden');
      }
    };

    sock.onerror = () => {
      showAuthError('Không thể kết nối tới máy chủ WebSocket.');
    };
  }

  function closeSocket(clearCreds) {
    stopPingLoop();
    if (ws) {
      const prev = ws;
      ws = null;
      try { prev.close(); } catch (_) {}
    }
    authenticated = false;
    if (clearCreds) {
      sessionToken = null;
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
    }
  }

  function handleTextMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {
      case 'relay_status':
        if (msg.hostOnline === false) {
          setConnStatus('Máy chủ ĐT ngoại tuyến', 'pill-warn');
          showAuthError(msg.message || 'Điện thoại chủ đang ngoại tuyến.');
        } else if (msg.requiresReauth && authenticated) {
          authenticated = false;
          els.consoleView.classList.add('hidden');
          els.authView.classList.remove('hidden');
          showAuthError('Máy chủ vừa kết nối lại, vui lòng nhập lại PIN.');
        }
        break;

      case 'auth_ok':
        authenticated = true;
        allowControl = msg.allowControl !== false;
        if (msg.token) sessionToken = msg.token;
        els.btnConnect.disabled = false;
        showAuthError('');
        els.authView.classList.add('hidden');
        els.consoleView.classList.remove('hidden');
        els.btnDisconnect.classList.remove('hidden');
        setConnStatus(mode === 'lan' ? 'LAN Trực tuyến' : 'Cloud Trực tuyến', 'pill-cyan');
        updatePermPill();
        startPingLoop();
        sendCmd({ type: 'get_state' });
        break;

      case 'auth_error':
        els.btnConnect.disabled = false;
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
    }
  }

  function renderServerState() {
    const tabs = Array.isArray(serverState.tabs) ? serverState.tabs : [];
    const activeSlot = Number(serverState.activeSlot || 0);

    // Tabs list
    els.tabsList.textContent = '';
    if (tabs.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'Chưa có tab giả lập nào đang mở';
      els.tabsList.appendChild(empty);
      els.activeSlotTitle.textContent = 'Chưa có game đang chạy';
      els.stageOverlay.classList.remove('hidden');
    } else {
      let currentTab = tabs.find((t) => Number(t.slotIndex) === activeSlot) || tabs[0];
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

    // Keep-Alive button
    const keepOn = Boolean(serverState.keepAlive247);
    els.btnKeepAlive.textContent = keepOn ? 'Đang bật 24/24' : 'Đang tắt';
    els.btnKeepAlive.classList.toggle('on', keepOn);

    // Stream dropdowns
    if (serverState.fps) els.selectFps.value = String(serverState.fps);
    if (serverState.quality) els.selectQuality.value = String(serverState.quality);

    // Games library
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

      row.appendChild(info);
      row.appendChild(playBtn);
      els.gamesList.appendChild(row);
    });
  }

  function enqueueFramePacket(buf) {
    pendingFramePacket = buf;
    if (!decodingFrame) {
      processNextFrame();
    }
  }

  async function processNextFrame() {
    if (!pendingFramePacket) return;
    decodingFrame = true;
    const buf = pendingFramePacket;
    pendingFramePacket = null;

    try {
      const view = new DataView(buf);
      if (buf.byteLength <= 5) return;
      const w = view.getUint16(1);
      const h = view.getUint16(3);
      if (w > 0 && h > 0) {
        gameWidth = w;
        gameHeight = h;
      }
      const jpegSlice = buf.slice(5);
      const blob = new Blob([jpegSlice], { type: 'image/jpeg' });
      let imgWidth = w;
      let imgHeight = h;

      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        imgWidth = bmp.width;
        imgHeight = bmp.height;
        if (els.canvas.width !== imgWidth || els.canvas.height !== imgHeight) {
          els.canvas.width = imgWidth;
          els.canvas.height = imgHeight;
        }
        ctx.imageSmoothingEnabled = !pixelated;
        ctx.drawImage(bmp, 0, 0);
        if (typeof bmp.close === 'function') bmp.close();
      } else {
        await new Promise((resolve) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            imgWidth = img.naturalWidth;
            imgHeight = img.naturalHeight;
            if (els.canvas.width !== imgWidth || els.canvas.height !== imgHeight) {
              els.canvas.width = imgWidth;
              els.canvas.height = imgHeight;
            }
            ctx.imageSmoothingEnabled = !pixelated;
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          img.src = url;
        });
      }

      els.stageOverlay.classList.add('hidden');
      els.screenRes.textContent = gameWidth + ' × ' + gameHeight;
      framesThisSec += 1;
      lastFrameAt = Date.now();
    } catch (_) {
      // ignore corrupted frame
    } finally {
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
