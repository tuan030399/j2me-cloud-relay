'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_PAYLOAD = 2 * 1024 * 1024; // 2 MB
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sanitizeRoomId(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function sendSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function encodeWsFrame(opcode, payloadBuf) {
  const buf = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '', 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, buf]);
}

class WsConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.lastPongAt = Date.now();
    this.onText = null;
    this.onBinary = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  sendText(text) {
    if (this.closed || typeof text !== 'string') return;
    try {
      this.socket.write(encodeWsFrame(0x1, Buffer.from(text, 'utf8')));
    } catch (_) {
      this.close();
    }
  }

  sendJson(obj) {
    this.sendText(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.closed || !buf) return;
    try {
      this.socket.write(encodeWsFrame(0x2, buf));
    } catch (_) {
      this.close();
    }
  }

  sendPing() {
    if (this.closed) return;
    try {
      this.socket.write(encodeWsFrame(0x9, Buffer.alloc(0)));
    } catch (_) {
      this.close();
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBuf = Buffer.from(String(reason || ''), 'utf8').slice(0, 100);
      const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
      closePayload.writeUInt16BE(code, 0);
      reasonBuf.copy(closePayload, 2);
      this.socket.end(encodeWsFrame(0x8, closePayload));
    } catch (_) {
      try { this.socket.destroy(); } catch (_2) {}
    }
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      cb();
    }
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      cb();
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2 && !this.closed) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const hi = this.buffer.readUInt32BE(2);
        const lo = this.buffer.readUInt32BE(6);
        len = hi * 0x100000000 + lo;
        offset = 10;
      }

      if (len < 0 || len > MAX_WS_PAYLOAD) {
        this.close(1009, 'Frame too large');
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;

      let payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        this.close(1000, 'Normal closure');
        return;
      } else if (opcode === 0x9) {
        try { this.socket.write(encodeWsFrame(0xA, payload)); } catch (_) {}
      } else if (opcode === 0xA) {
        this.lastPongAt = Date.now();
      } else if (opcode === 0x1) {
        if (this.onText) this.onText(payload.toString('utf8'));
      } else if (opcode === 0x2) {
        if (this.onBinary) this.onBinary(payload);
      }
    }
  }
}

function createRelayServer(options = {}) {
  const rooms = new Map(); // roomId -> { host: HostEntry|null, viewers: Map<clientId, ViewerEntry> }
  const authFailures = new Map(); // ipLabel -> { count, lockedUntil }
  let viewerSeq = 0;
  const startedAt = Date.now();

  function getOrCreateRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = { host: null, viewers: new Map() };
      rooms.set(roomId, room);
    }
    return room;
  }

  function cleanupRoomIfEmpty(roomId) {
    const room = rooms.get(roomId);
    if (room && !room.host && room.viewers.size === 0) {
      rooms.delete(roomId);
    }
  }

  function serveStatic(reqPath, res) {
    let rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const ext = path.extname(rel).toLowerCase();
    const mime = MIME_TYPES[ext];
    if (!mime) {
      sendSecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const resolved = path.resolve(PUBLIC_DIR, rel);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
      sendSecurityHeaders(res);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      sendSecurityHeaders(res);
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const reqPath = urlObj.pathname;

    if (req.method === 'GET' && reqPath === '/api/health') {
      sendSecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({
        ok: true,
        service: 'j2me-cloud-relay',
        rooms: rooms.size,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      }));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(reqPath, res);
      return;
    }

    sendSecurityHeaders(res);
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  });

  server.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    if (urlObj.pathname !== '/ws' && urlObj.pathname !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || typeof wsKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const role = (urlObj.searchParams.get('role') || 'viewer').toLowerCase();
    const roomId = sanitizeRoomId(urlObj.searchParams.get('room') || '');
    if (!roomId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(wsKey + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const conn = new WsConnection(socket, head);
    if (role === 'host') {
      attachHost(roomId, conn);
    } else {
      const label = String(req.headers['x-forwarded-for'] || socket.remoteAddress || 'Web Viewer')
        .split(',')[0]
        .trim()
        .slice(0, 48);
      attachViewer(roomId, conn, label);
    }
  });

  function attachHost(roomId, conn) {
    const room = getOrCreateRoom(roomId);
    let registered = false;
    let mySecret = '';

    conn.onText = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      const type = msg.type;

      if (!registered) {
        if (type !== 'host_hello') return;
        const incomingSecret = String(msg.hostSecret || '');
        if (!incomingSecret) {
          conn.sendJson({ type: 'host_error', message: 'Thiếu hostSecret' });
          conn.close(1008, 'Missing hostSecret');
          return;
        }
        if (room.host && !room.host.conn.closed && room.host.secret !== incomingSecret) {
          conn.sendJson({ type: 'host_error', message: 'Mã phòng này đang có máy chủ khác kết nối' });
          conn.close(1008, 'Room in use');
          return;
        }
        if (room.host && room.host.conn !== conn) {
          room.host.conn.close(1000, 'Replaced by reconnect');
        }
        mySecret = incomingSecret;
        registered = true;
        room.host = { conn, secret: mySecret };
        conn.sendJson({ type: 'host_ready', roomId });

        for (const [cid, v] of room.viewers.entries()) {
          v.authenticated = false;
          conn.sendJson({ type: 'viewer_joined', clientId: cid, label: v.label });
          v.conn.sendJson({
            type: 'relay_status',
            hostOnline: true,
            requiresReauth: true,
            message: 'Điện thoại máy chủ đã kết nối'
          });
        }
        return;
      }

      if (type === 'authorize_viewer') {
        const cid = String(msg.clientId || '');
        const viewer = room.viewers.get(cid);
        if (!viewer) return;
        if (msg.ok === true) {
          authFailures.delete(viewer.label);
          viewer.authenticated = true;
          viewer.conn.sendJson({
            type: 'auth_ok',
            clientId: cid,
            allowControl: msg.allowControl !== false
          });
        } else {
          const rec = authFailures.get(viewer.label) || { count: 0, lockedUntil: 0 };
          rec.count += 1;
          if (rec.count >= 5) {
            rec.lockedUntil = Date.now() + 30000;
          }
          authFailures.set(viewer.label, rec);
          viewer.authenticated = false;
          viewer.conn.sendJson({
            type: 'auth_error',
            message: 'Sai mã PIN ghép nối hoặc đã bị khóa tạm thời'
          });
        }
      } else if (type === 'to_viewer') {
        const cid = String(msg.clientId || '');
        const viewer = room.viewers.get(cid);
        if (viewer && viewer.authenticated && msg.payload) {
          viewer.conn.sendJson(msg.payload);
        }
      } else if (type === 'broadcast_viewers') {
        if (!msg.payload) return;
        const jsonStr = JSON.stringify(msg.payload);
        for (const viewer of room.viewers.values()) {
          if (viewer.authenticated) {
            viewer.conn.sendText(jsonStr);
          }
        }
      } else if (type === 'kick_viewer') {
        const cid = String(msg.clientId || '');
        const viewer = room.viewers.get(cid);
        if (viewer) {
          room.viewers.delete(cid);
          viewer.conn.sendJson({ type: 'auth_error', message: 'Bạn đã bị ngắt kết nối bởi máy chủ' });
          viewer.conn.close(1008, 'Kicked by host');
          cleanupRoomIfEmpty(roomId);
        }
      }
    };

    conn.onBinary = (buf) => {
      if (!registered) return;
      for (const viewer of room.viewers.values()) {
        if (viewer.authenticated) {
          viewer.conn.sendBinary(buf);
        }
      }
    };

    conn.onClose = () => {
      if (room.host && room.host.conn === conn) {
        room.host = null;
        for (const viewer of room.viewers.values()) {
          viewer.authenticated = false;
          viewer.conn.sendJson({
            type: 'relay_status',
            hostOnline: false,
            message: 'Điện thoại máy chủ tạm ngoại tuyến'
          });
        }
      }
      cleanupRoomIfEmpty(roomId);
    };
  }

  function attachViewer(roomId, conn, label) {
    const room = getOrCreateRoom(roomId);
    const clientId = 'cloud-' + (++viewerSeq);
    const entry = { conn, label, authenticated: false };
    room.viewers.set(clientId, entry);

    conn.sendJson({
      type: 'relay_status',
      clientId,
      roomId,
      hostOnline: !!(room.host && !room.host.conn.closed),
      message: room.host ? 'Đã kết nối Relay, nhập PIN để điều khiển' : 'Đang chờ điện thoại máy chủ vào phòng ' + roomId
    });

    if (room.host && !room.host.conn.closed) {
      room.host.conn.sendJson({ type: 'viewer_joined', clientId, label });
    }

    conn.onText = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (_) { return; }
      const type = msg.type;
      if (type === 'auth') {
        const rec = authFailures.get(label);
        if (rec && rec.lockedUntil > Date.now()) {
          conn.sendJson({ type: 'auth_error', message: 'Nhập sai quá nhiều lần, vui lòng chờ 30 giây' });
          return;
        }
        if (rec && rec.lockedUntil > 0 && rec.lockedUntil <= Date.now()) {
          authFailures.delete(label);
        }
        if (!room.host || room.host.conn.closed) {
          conn.sendJson({ type: 'auth_error', message: 'Điện thoại máy chủ chưa online' });
          return;
        }
        room.host.conn.sendJson({
          type: 'viewer_auth',
          clientId,
          pin: String(msg.pin || ''),
          label
        });
        return;
      }

      if (!entry.authenticated) {
        conn.sendJson({ type: 'auth_error', message: 'Chưa xác thực mã PIN' });
        return;
      }

      if (room.host && !room.host.conn.closed) {
        room.host.conn.sendJson({
          type: 'viewer_cmd',
          clientId,
          payload: msg
        });
      }
    };

    conn.onClose = () => {
      room.viewers.delete(clientId);
      if (room.host && !room.host.conn.closed) {
        room.host.conn.sendJson({ type: 'viewer_left', clientId });
      }
      cleanupRoomIfEmpty(roomId);
    };
  }

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.host && !room.host.conn.closed) {
        if (now - room.host.conn.lastPongAt > 75000) {
          room.host.conn.close(1001, 'Heartbeat timeout');
        } else {
          room.host.conn.sendPing();
        }
      }
      for (const viewer of room.viewers.values()) {
        if (!viewer.conn.closed) {
          if (now - viewer.conn.lastPongAt > 75000) {
            viewer.conn.close(1001, 'Heartbeat timeout');
          } else {
            viewer.conn.sendPing();
          }
        }
      }
    }
  }, 25000);
  if (typeof heartbeatInterval.unref === 'function') {
    heartbeatInterval.unref();
  }

  server.on('close', () => clearInterval(heartbeatInterval));

  return {
    server,
    rooms,
    listen(port = options.port ?? process.env.PORT ?? 3000) {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => resolve(server.address()));
      });
    },
    close() {
      clearInterval(heartbeatInterval);
      for (const room of rooms.values()) {
        if (room.host) room.host.conn.close(1001, 'Server shutdown');
        for (const v of room.viewers.values()) v.conn.close(1001, 'Server shutdown');
      }
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const relay = createRelayServer();
  relay.listen(port).then((addr) => {
    console.log(`J2ME Cloud Relay & Web Console listening on 0.0.0.0:${addr.port}`);
  });
}

module.exports = { createRelayServer, sanitizeRoomId };
