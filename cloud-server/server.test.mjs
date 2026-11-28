import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRelayServer, sanitizeRoomId } = require('./server.js');

function connectWs(port, pathWithQuery) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    let headerDone = false;
    let buf = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    function dispatch(item) {
      if (waiters.length > 0) {
        waiters.shift()(item);
      } else {
        messages.push(item);
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headerDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const headerStr = buf.subarray(0, idx).toString('ascii');
        if (!headerStr.includes('101 Switching Protocols')) {
          reject(new Error('WS handshake failed: ' + headerStr));
          socket.destroy();
          return;
        }
        buf = buf.subarray(idx + 4);
        headerDone = true;
        resolve(client);
      }

      while (headerDone && buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = buf.readUInt32BE(6);
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (opcode === 0x1) {
          dispatch({ type: 'text', data: JSON.parse(payload.toString('utf8')) });
        } else if (opcode === 0x2) {
          dispatch({ type: 'binary', data: payload });
        } else if (opcode === 0x8) {
          dispatch({ type: 'close' });
        }
      }
    });

    socket.on('error', reject);

    function sendFrame(opcode, payloadBuf, fin = true) {
      const mask = crypto.randomBytes(4);
      const len = payloadBuf.length;
      let hdr;
      const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
      if (len < 126) {
        hdr = Buffer.allocUnsafe(2);
        hdr[0] = firstByte;
        hdr[1] = 0x80 | len;
      } else if (len <= 0xffff) {
        hdr = Buffer.allocUnsafe(4);
        hdr[0] = firstByte;
        hdr[1] = 0x80 | 126;
        hdr.writeUInt16BE(len, 2);
      } else {
        hdr = Buffer.allocUnsafe(10);
        hdr[0] = firstByte;
        hdr[1] = 0x80 | 127;
        hdr.writeUInt32BE(0, 2);
        hdr.writeUInt32BE(len, 6);
      }
      const masked = Buffer.from(payloadBuf);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      socket.write(Buffer.concat([hdr, mask, masked]));
    }

    const client = {
      sendJson(obj) {
        sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
      },
      sendBinary(bytes) {
        sendFrame(0x2, Buffer.from(bytes));
      },
      sendFragmentedBinary(chunks) {
        for (let i = 0; i < chunks.length; i++) {
          const isFirst = i === 0;
          const isLast = i === chunks.length - 1;
          sendFrame(isFirst ? 0x2 : 0x0, chunks[i], isLast);
          if (i === 0) {
            // Also interleave a ping frame mid-fragment per RFC 6455
            sendFrame(0x9, Buffer.from('ping'), true);
          }
        }
      },
      nextMessage(timeoutMs = 2000) {
        if (messages.length > 0) return Promise.resolve(messages.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('Timed out waiting for WS message')), timeoutMs);
          waiters.push((item) => {
            clearTimeout(timer);
            res(item);
          });
        });
      },
      close() {
        socket.end();
      }
    };
  });
}

test('sanitizeRoomId restricts unsafe characters', () => {
  assert.equal(sanitizeRoomId('j2m-ab12/../x!'), 'J2M-AB12X');
});

test('Relay enforces PIN auth, binary gating, room hijack protection, and kick', async () => {
  const relay = createRelayServer();
  const addr = await relay.listen(0);
  const port = addr.port;

  try {
    // 1. Health + static + traversal block + v4 no-store headers
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.match(healthRes.headers.get('cache-control') || '', /no-store/);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'j2me-cloud-relay');
    assert.equal(healthJson.version, 5);

    const indexRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('cache-control') || '', /no-store/);
    const html = await indexRes.text();
    assert.ok(html.includes('J2ME Cloud Console'));
    assert.ok(html.includes('/app.js?v=5'));

    const travRes = await fetch(`http://127.0.0.1:${port}/../server.js`);
    assert.equal(travRes.status, 404);

    // 2. Host connects and registers room
    const host = await connectWs(port, '/ws?role=host&room=TEST-101');
    host.sendJson({ type: 'host_hello', roomId: 'TEST-101', hostSecret: 'sec-alpha' });
    const ready = await host.nextMessage();
    assert.equal(ready.data.type, 'host_ready');

    // 3. Second host with different secret is rejected
    const rogueHost = await connectWs(port, '/ws?role=host&room=TEST-101');
    rogueHost.sendJson({ type: 'host_hello', roomId: 'TEST-101', hostSecret: 'sec-rogue' });
    const rogueErr = await rogueHost.nextMessage();
    assert.equal(rogueErr.data.type, 'host_error');
    rogueHost.close();

    // 4. Viewer joins and is blocked before PIN auth
    const viewer = await connectWs(port, '/ws?role=viewer&room=TEST-101');
    const relayStatus = await viewer.nextMessage();
    assert.equal(relayStatus.data.type, 'relay_status');
    assert.equal(relayStatus.data.hostOnline, true);

    const joined = await host.nextMessage();
    assert.equal(joined.data.type, 'viewer_joined');
    const cid = joined.data.clientId;

    viewer.sendJson({ type: 'key', action: 'down', code: -5 });
    const unauthErr = await viewer.nextMessage();
    assert.equal(unauthErr.data.type, 'auth_error');

    // Binary frames sent before auth must not reach unauthenticated viewer
    host.sendBinary(Buffer.from([0, 0, 240, 1, 64, 0xff, 0xd8]));

    // 5. Viewer submits PIN -> host authorizes -> commands + binary flow cleanly
    viewer.sendJson({ type: 'auth', pin: '123456' });
    const authReq = await host.nextMessage();
    assert.equal(authReq.data.type, 'viewer_auth');
    assert.equal(authReq.data.pin, '123456');

    host.sendJson({ type: 'authorize_viewer', clientId: cid, ok: true, allowControl: true });
    const authOk = await viewer.nextMessage();
    assert.equal(authOk.data.type, 'auth_ok');

    viewer.sendJson({ type: 'key', action: 'down', code: -5 });
    const cmdToHost = await host.nextMessage();
    assert.equal(cmdToHost.data.type, 'viewer_cmd');
    assert.equal(cmdToHost.data.payload.code, -5);

    const sampleFrame = Buffer.from([0, 0, 240, 1, 64, 0x11, 0x22]);
    host.sendBinary(sampleFrame);
    const frameMsg = await viewer.nextMessage();
    assert.equal(frameMsg.type, 'binary');
    assert.deepEqual(frameMsg.data, sampleFrame);

    // 6. Host kicks viewer
    host.sendJson({ type: 'kick_viewer', clientId: cid });
    const kickNotice = await viewer.nextMessage();
    assert.equal(kickNotice.data.type, 'auth_error');

    host.close();
    viewer.close();
  } finally {
    await relay.close();
  }
});

test('Relay serves /api/config and forwards key/auto auth without locking auto probes', async () => {
  const relay = createRelayServer();
  const addr = await relay.listen(0);
  const port = addr.port;

  try {
    const cfgRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.ok, true);
    assert.equal(typeof cfgJson.defaultRoom, 'string');
    assert.equal(cfgJson.maxJarMb, 16);

    const host = await connectWs(port, '/ws?role=host&room=J2M-MAIN');
    host.sendJson({ type: 'host_hello', roomId: 'J2M-MAIN', hostSecret: 'sec-main' });
    const ready = await host.nextMessage();
    assert.equal(ready.data.type, 'host_ready');

    const viewer = await connectWs(port, '/ws?role=viewer&room=J2M-MAIN');
    await viewer.nextMessage(); // relay_status
    const joined = await host.nextMessage();
    const cid = joined.data.clientId;

    // Auto probe rejected (host has auto-link off) -> requiresPin: true, does not lock client
    viewer.sendJson({ type: 'auth', mode: 'auto' });
    const authProbe = await host.nextMessage();
    assert.equal(authProbe.data.type, 'viewer_auth');
    assert.equal(authProbe.data.mode, 'auto');

    host.sendJson({ type: 'authorize_viewer', clientId: cid, ok: false, requiresPin: true });
    const probeErr = await viewer.nextMessage();
    assert.equal(probeErr.data.type, 'auth_error');
    assert.equal(probeErr.data.requiresPin, true);

    // PairKey auth succeeds and relays frame_ack cleanly
    viewer.sendJson({ type: 'auth', key: 'pair-secret-123' });
    const keyReq = await host.nextMessage();
    assert.equal(keyReq.data.type, 'viewer_auth');
    assert.equal(keyReq.data.key, 'pair-secret-123');

    host.sendJson({ type: 'authorize_viewer', clientId: cid, ok: true, allowControl: true });
    const authOk = await viewer.nextMessage();
    assert.equal(authOk.data.type, 'auth_ok');

    viewer.sendJson({ type: 'frame_ack' });
    const ackCmd = await host.nextMessage();
    assert.equal(ackCmd.data.type, 'viewer_cmd');
    assert.equal(ackCmd.data.payload.type, 'frame_ack');

    host.close();
    viewer.close();
  } finally {
    await relay.close();
  }
});

test('Relay reassembles fragmented binary frames (>48KB) across proxy splits', async () => {
  const relay = createRelayServer();
  const addr = await relay.listen(0);
  const port = addr.port;

  try {
    const host = await connectWs(port, '/ws?role=host&room=FRAG-1');
    host.sendJson({ type: 'host_hello', roomId: 'FRAG-1', hostSecret: 'sec-frag' });
    await host.nextMessage();

    const viewer = await connectWs(port, '/ws?role=viewer&room=FRAG-1');
    await viewer.nextMessage(); // relay_status
    const joined = await host.nextMessage();
    const cid = joined.data.clientId;

    viewer.sendJson({ type: 'auth', mode: 'auto', supportsWebp: true });
    const authReq = await host.nextMessage();
    assert.equal(authReq.data.supportsWebp, true);

    host.sendJson({ type: 'authorize_viewer', clientId: cid, ok: true, allowControl: true });
    await viewer.nextMessage(); // auth_ok

    // Simulate a 48KB farm image split by reverse proxy into 3 fragmented WS frames + interleaved ping
    const largeFrame = Buffer.concat([
      Buffer.from([0x80, 0x03, 0x48, 0x01, 0x40]),
      crypto.randomBytes(49152)
    ]);
    const c1 = largeFrame.subarray(0, 16384);
    const c2 = largeFrame.subarray(16384, 32768);
    const c3 = largeFrame.subarray(32768);
    host.sendFragmentedBinary([c1, c2, c3]);

    const relayed = await viewer.nextMessage(3000);
    assert.equal(relayed.type, 'binary');
    assert.equal(relayed.data.length, largeFrame.length);
    assert.deepEqual(relayed.data, largeFrame);

    host.close();
    viewer.close();
  } finally {
    await relay.close();
  }
});

test('Relay forwards supportsH264 capability and relays H.264 binary packets cleanly', async () => {
  const relay = createRelayServer();
  const addr = await relay.listen(0);
  const port = addr.port;

  try {
    const host = await connectWs(port, '/ws?role=host&room=H264-1');
    host.sendJson({ type: 'host_hello', roomId: 'H264-1', hostSecret: 'sec-h264' });
    await host.nextMessage();

    const viewer = await connectWs(port, '/ws?role=viewer&room=H264-1');
    await viewer.nextMessage(); // relay_status
    const joined = await host.nextMessage();
    const cid = joined.data.clientId;

    viewer.sendJson({ type: 'auth', mode: 'auto', supportsWebp: true, supportsH264: true });
    const authReq = await host.nextMessage();
    assert.equal(authReq.data.supportsWebp, true);
    assert.equal(authReq.data.supportsH264, true);

    host.sendJson({ type: 'authorize_viewer', clientId: cid, ok: true, allowControl: true });
    await viewer.nextMessage(); // auth_ok

    // Send 11-byte H.264 keyframe header (flags = 0x10 | 0x20 = 0x30) + Annex-B NAL
    const keyPacket = Buffer.from([0x30, 0x03, 0x48, 0x01, 0x40, 0x00, 0x01, 0x03, 0x50, 0x01, 0x40, 0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1e]);
    host.sendBinary(keyPacket);
    const relayedKey = await viewer.nextMessage();
    assert.equal(relayedKey.type, 'binary');
    assert.deepEqual(relayedKey.data, keyPacket);

    // Send 11-byte H.264 P-frame (flags = 0x10 | 0x20 | 0x40 = 0x70)
    const pPacket = Buffer.from([0x70, 0x03, 0x48, 0x01, 0x40, 0x00, 0x02, 0x03, 0x50, 0x01, 0x40, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a]);
    host.sendBinary(pPacket);
    const relayedP = await viewer.nextMessage();
    assert.equal(relayedP.type, 'binary');
    assert.deepEqual(relayedP.data, pPacket);

    host.close();
    viewer.close();
  } finally {
    await relay.close();
  }
});
