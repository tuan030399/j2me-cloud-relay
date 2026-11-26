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

    function sendFrame(opcode, payloadBuf) {
      const mask = crypto.randomBytes(4);
      const len = payloadBuf.length;
      let hdr;
      if (len < 126) {
        hdr = Buffer.allocUnsafe(2);
        hdr[0] = 0x80 | opcode;
        hdr[1] = 0x80 | len;
      } else {
        hdr = Buffer.allocUnsafe(4);
        hdr[0] = 0x80 | opcode;
        hdr[1] = 0x80 | 126;
        hdr.writeUInt16BE(len, 2);
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
    // 1. Health + static + traversal block
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'j2me-cloud-relay');

    const indexRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(indexRes.status, 200);
    const html = await indexRes.text();
    assert.ok(html.includes('J2ME Cloud Console'));

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
