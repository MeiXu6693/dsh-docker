#!/usr/bin/env node
// Integration test against the shipped Caddyfiles. No npm packages or DSH state needed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const templates = process.env.CADDY_TEMPLATE_DIR
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../docker');
const caddyBin = process.env.CADDY_BIN ?? 'caddy';
const script = Buffer.from('export const message = "proxy compression fixture";\n'.repeat(3000));
const json = Buffer.from(JSON.stringify({ sessions: Array.from({ length: 1500 }, (_, id) => ({ id, title: 'fixture session' })) }));
const compressed = gzipSync(script);
const agent = new http.Agent({ keepAlive: true });
const sockets = new Set();
let streamEnded = false;
let revision = 1;
let sessionValid = true;

const upstream = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (path === '/healthz') return res.end('ok');
  if (path === '/assets/private.js' && (req.headers.cookie !== 'fixture-session=valid' || !sessionValid)) {
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
    return res.end('authentication required');
  }
  if (path === '/assets/live.js') {
    streamEnded = false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    const timer = setTimeout(() => {
      streamEnded = true;
      res.end('data: last\n\n');
    }, 1000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  const etag = `"fixture-v${revision}"`;
  const privateResponse = path.startsWith('/api/') || path === '/assets/private.js';
  // Deliberately mislabel the session list to verify the proxy's privacy policy.
  const cachePolicy = privateResponse && path !== '/api/session/list' ? 'private, no-store' : 'public, max-age=3600';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cachePolicy });
    return res.end();
  }
  let body = path.startsWith('/api/') ? json
    : revision === 1 ? script : Buffer.concat([Buffer.from('export const revision = 2;\n'), script]);
  let type = path.startsWith('/api/') ? 'application/json' : 'text/javascript; charset=utf-8';
  let status = 200;
  const headers = { ETag: etag, 'Cache-Control': cachePolicy, Vary: 'Origin' };
  if (path === '/assets/tiny.js') body = Buffer.from('export default 1;');
  if (path.endsWith('.css')) type = 'text/css';
  if (path.endsWith('.wasm')) type = 'application/wasm';
  if (path.endsWith('.ttf')) type = 'font/ttf';
  if (path.endsWith('.bin')) type = 'application/octet-stream';
  if (path === '/assets/error.js') status = 401;
  if (path === '/assets/preencoded.js') {
    body = compressed;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Origin, Accept-Encoding';
  }
  if (req.headers.range === 'bytes=0-31') {
    status = 206;
    headers['Content-Range'] = `bytes 0-31/${body.length}`;
    body = body.subarray(0, 32);
  }
  res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
});
upstream.on('connection', (socket) => {
  sockets.add(socket);
  // A client may close an upgraded socket without a WebSocket close handshake.
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
});
upstream.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const payload = Buffer.from('fixture-ws');
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
});

function request(port, path, { headers = {}, method = 'GET', firstChunk } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        if (chunks.length === 0) firstChunk?.();
        chunks.push(chunk);
      });
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`request timed out: ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function websocket(port) {
  await new Promise((resolveSocket, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/remote.mux',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Origin: `http://127.0.0.1:${port}`, 'Accept-Encoding': 'gzip',
      },
    });
    const timer = setTimeout(() => req.destroy(new Error('websocket timed out')), 5000);
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.on('response', (res) => { clearTimeout(timer); res.resume(); reject(new Error(`websocket returned ${res.statusCode}`)); });
    req.on('upgrade', (res, socket, head) => {
      try {
        assert.equal(res.statusCode, 101);
        assert.equal(res.headers['content-encoding'], undefined);
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); return; }
      let frame = head;
      const read = (chunk = Buffer.alloc(0)) => {
        frame = Buffer.concat([frame, chunk]);
        if (frame.length < 12) return;
        clearTimeout(timer);
        try { assert.equal(frame.subarray(2, 12).toString(), 'fixture-ws'); resolveSocket(); }
        catch (error) { reject(error); }
        finally { socket.destroy(); }
      };
      socket.on('data', read);
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      read();
    });
    req.end();
  });
}

async function testMode(mode, internalPort) {
  const dir = await mkdtemp(join(tmpdir(), `dsh-encoding-${mode}-`));
  const port = await unusedPort();
  let child;
  let closed;
  let log = '';
  try {
    let config = await readFile(join(templates, `Caddyfile.${mode}`), 'utf8');
    // Imports in a rendered runtime config stay anchored to the image's /etc/caddy.
    // In this fixture they point at the same checked-out (or installed) common file.
    config = config.replace('import /etc/caddy/Caddyfile.common', `import ${JSON.stringify(join(templates, 'Caddyfile.common'))}`);
    config = config.replace('admin off', 'admin off\n\tdefault_bind 127.0.0.1');
    const configPath = join(dir, 'Caddyfile');
    await writeFile(configPath, config);
    const env = {
      ...process.env, PORT: String(port), DSH_INTERNAL_PORT: String(internalPort),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DSH_UPSTREAM_HOST: `127.0.0.1:${port}`,
      DSH_LAUNCH_TOKEN: 'encoding-fixture', XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir,
    };
    const validation = spawnSync(caddyBin, ['validate', '--config', configPath, '--adapter', 'caddyfile'], { env, encoding: 'utf8' });
    assert.equal(validation.status, 0, `Caddy validation failed: ${validation.stderr}${validation.stdout}`);
    child = spawn(caddyBin, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { log = (log + data).slice(-5000); });
    child.stderr.on('data', (data) => { log = (log + data).slice(-5000); });
    closed = new Promise((done) => child.once('close', done));
    let startupError;
    child.on('error', (error) => { startupError = error; });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) {
        await closed;
        throw new Error(`Caddy exited (${child.exitCode}): ${log}`);
      }
      try { if ((await request(port, '/healthz')).status === 200) { ready = true; break; } }
      catch { /* Wait for the loopback listener. */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(ready, `Caddy failed to start: ${log}`);
    for (const path of ['/assets/app.js', '/assets/app.css', '/assets/app.wasm', '/assets/font.ttf', '/plugins/?entry=fixture', '/api/session/list']) {
      const identity = await request(port, path, { headers: { 'Accept-Encoding': 'identity' } });
      const encoded = await request(port, path, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(encoded.status, 200, path);
      assert.equal(encoded.headers['content-encoding'], 'gzip', path);
      assert.deepEqual(gunzipSync(encoded.body), identity.body, path);
      assert.ok(encoded.body.length < identity.body.length / 2, path);
      assert.match(encoded.headers.vary, /Accept-Encoding/i);
      assert.match(encoded.headers.vary, /Origin/);
      assert.equal(encoded.headers['cache-control'], identity.headers['cache-control']);
      if (path === '/api/session/list') assert.equal(encoded.headers['cache-control'], 'private, no-store');
    }
    const asset = await request(port, '/assets/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    const conditional = await request(port, '/assets/app.js', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': asset.headers.etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body.length, 0);
    revision = 2;
    const changed = await request(port, '/assets/app.js', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': asset.headers.etag },
    });
    assert.equal(changed.status, 200, 'a changed backend must not reuse a stale 304');
    assert.notEqual(changed.headers.etag, asset.headers.etag);
    assert.deepEqual(gunzipSync(changed.body), Buffer.concat([Buffer.from('export const revision = 2;\n'), script]));
    revision = 1;
    const privateAsset = await request(port, '/assets/private.js', {
      headers: { Cookie: 'fixture-session=valid', 'Accept-Encoding': 'gzip' },
    });
    assert.equal(privateAsset.status, 200);
    assert.equal(privateAsset.headers['cache-control'], 'private, no-store');
    sessionValid = false;
    const revoked = await request(port, '/assets/private.js', {
      headers: { Cookie: 'fixture-session=valid', 'Accept-Encoding': 'gzip', 'If-None-Match': privateAsset.headers.etag },
    });
    assert.equal(revoked.status, 401, 'a cached validator must not bypass a revoked session');
    assert.equal(revoked.headers['content-encoding'], undefined);
    sessionValid = true;
    const range = await request(port, '/assets/app.js', {
      headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-31' },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-encoding'], undefined);
    assert.deepEqual(range.body, script.subarray(0, 32));
    const preencoded = await request(port, '/assets/preencoded.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.deepEqual(preencoded.body, compressed, 'an encoded upstream response must not be encoded twice');
    for (const path of ['/assets/tiny.js', '/assets/file.bin', '/assets/error.js', '/api/settings.describe']) {
      const response = await request(port, path, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(response.headers['content-encoding'], undefined, path);
    }
    const disabled = await request(port, '/assets/app.js', { headers: { 'Accept-Encoding': 'gzip;q=0, identity' } });
    assert.equal(disabled.headers['content-encoding'], undefined);
    const post = await request(port, '/api/session/list', { method: 'POST', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(post.headers['content-encoding'], 'gzip', 'DSH fetches its read-only session list with POST');
    assert.equal(post.headers['cache-control'], 'private, no-store');
    assert.deepEqual(gunzipSync(post.body), json);
    for (const path of ['/assets/app.js', '/api/settings.describe']) {
      const otherPost = await request(port, path, { method: 'POST', headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(otherPost.headers['content-encoding'], undefined, path);
    }
    let streamedBeforeEnd = false;
    const stream = await request(port, '/assets/live.js', {
      headers: { 'Accept-Encoding': 'gzip' }, firstChunk: () => { streamedBeforeEnd = !streamEnded; },
    });
    assert.equal(stream.headers['content-encoding'], undefined);
    assert.ok(streamedBeforeEnd, 'the SSE first event must arrive before the upstream ends');
    await websocket(port);
    assert.equal((await request(port, '/api/settings.openDocument')).status, 403);
    if (mode === 'edge') {
      const foreign = await request(port, '/assets/app.js', {
        headers: { Origin: 'https://foreign.example', 'Accept-Encoding': 'gzip' },
      });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.headers['content-encoding'], undefined);
      const foreignPost = await request(port, '/api/session/list', {
        method: 'POST', headers: { Origin: 'https://foreign.example', 'Accept-Encoding': 'gzip' },
      });
      assert.equal(foreignPost.status, 403);
    }
    console.log(`ok ${mode}: encoding, body identity, backend updates, session revocation, Vary, 304, Range, SSE, WebSocket and origin fencing`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await closed;
      clearTimeout(force);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

try {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const { port } = upstream.address();
  for (const mode of ['lan', 'edge']) await testMode(mode, port);
} finally {
  agent.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => upstream.close(done));
}
