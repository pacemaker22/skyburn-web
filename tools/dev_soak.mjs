// Headless visual-verification soak driver for Skyburn (no dependencies).
// Launches Chrome headless with the DevTools protocol, drives the game over a raw
// RFC6455 WebSocket, collects console errors + FPS/particle stats and saves the
// final frame as a PNG. Usage:
//   node tools/dev_soak.mjs <url> <soakSeconds> <outPng> [--before]
// --before: navigate + wait + screenshot only (no autostart drive, baseline shot).
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const CHROME = process.env.CHROME_BIN ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = parseInt(process.env.SOAK_PORT || '9222', 10);
const args = process.argv.slice(2);
const URL_ = args[0] || 'http://localhost:8080/?autostart=1';
const SOAK_MS = (parseInt(args[1] || '130', 10)) * 1000;
const OUT = args[2] || 'after.png';
const BEFORE = args.includes('--before');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---- minimal WebSocket client (text frames, client-side masking) ----
class WS {
  constructor(url) { this.url = url; this.buf = Buffer.alloc(0); this.onmessage = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const sock = net.connect(u.port, u.hostname, () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${u.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      sock.once('error', reject);
      let handshook = false;
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshook) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.slice(0, idx).toString('utf8');
          if (!/HTTP\/1\.1 101/.test(head)) { reject(new Error('WS handshake failed: ' + head)); return; }
          handshook = true;
          this.buf = this.buf.slice(idx + 4);
          resolve();
        }
        this._frames();
      });
      this.sock = sock;
    });
  }
  _frames() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f;
      const masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? 4 : 0;
      if (b.length < off + mask + len) return;
      let payload = b.slice(off + mask, off + mask + len);
      if (masked) {
        const m = b.slice(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = b.slice(off + mask + len);
      if (op === 0x8) { this.sock.end(); return; }
      if (op === 0x9) { this._sendRaw(0xA, payload); return; } // ping -> pong
      if ((op === 0x1 || op === 0x2) && fin && this.onmessage) {
        this.onmessage(payload.toString('utf8'));
      }
      // continuation frames (op 0) are not expected for CDP-sized JSON; ignored if split.
    }
  }
  _sendRaw(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(obj) { this._sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
}

// ==== MAIN BELOW ====
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skyburn-soak-'));
  const chromeArgs = [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1280,720', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    // Software WebGL (SwiftShader): the GPU path composites canvas content black in
    // headless screenshots; SwiftShader is the documented-verification path (HANDOFF).
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    'about:blank',
  ];
  const proc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try { targets = await httpJson('/json/list'); if (targets && targets.length) break; }
      catch { /* chrome still booting */ }
    }
    if (!targets || !targets.length) throw new Error('Chrome devtools endpoint never came up');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WS(page.webSocketDebuggerUrl);
    await ws.connect();

    let mid = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const p = msg.params;
        if (p.type === 'error' || p.type === 'warning') {
          const text = p.args.map((a) => a.value !== undefined ? String(a.value) : a.description || '').join(' ');
          errors.push(`[console.${p.type}] ${text.slice(0, 400)}`);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`[exception] ${(d.exception && (d.exception.description || d.exception.value)) || d.text}`.slice(0, 500));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') errors.push(`[log.${e.source}] ${String(e.text).slice(0, 400)} url=${e.url || ''}`);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++mid;
      pending.set(id, { resolve, reject });
      ws.send({ id, method, params });
    });
    // Page-side try/catch: turns evaluate-time page exceptions into readable strings.
    const evalJs = async (expr) => {
      const wrapped = '(function(){ try { return (function(){ ' + expr + ' })(); }' +
        ' catch (e) { return "PAGE-ERR: " + (e && e.message ? e.message : e); } })()';
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      return r.result.value;
    };
    const key = (type, ms) => send('Input.dispatchKeyEvent',
      { type, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 }).then(() => sleep(ms));

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(7000); // boot: data fetch + world build + 350 ms LOADING beat

    if (!BEFORE) {
      const diag = await evalJs(
        'return JSON.stringify({ href: location.href, dev: window.__SKYBURN_DEV__,' +
        ' err: (document.getElementById("err")||{}).textContent || "",' +
        ' fpsEl: !!document.getElementById("hud-fps") });').catch((e) => 'diag-fail: ' + e.message);
      console.log('diag:', diag);
      console.log('state after boot:',
        await evalJs('return window.__SB_DEV__ ? window.__SB_DEV__.state() : "NO_DEV_HANDLE";'),
        '(PLAYING=4)');
      // Full-throttle hold > CATAPULT_TIME (2.6 s) -> the jet launches off the deck.
      await key('keyDown', 4000);
      await key('keyUp', 0);

      // --probe: read the REAL framebuffer via gl.readPixels right after a forced
      // world.render() in the same JS task (compositor-independent ground truth).
      if (args.includes('--probe')) {
        await sleep(8000); // let the flight settle and emitters warm up
        const grid = await evalJs(
          'var d = window.__SB_DEV__, w = d.world(), r = d.renderer(); ' +
          'if (!w || !r) return "no world/renderer"; ' +
          'w.render(1, performance.now()); ' +
          'var g = r.gl; g.bindFramebuffer(g.FRAMEBUFFER, null); ' +
          'var cw = g.drawingBufferWidth, ch = g.drawingBufferHeight; ' +
          'var N = 12, buf = new Uint8Array(4 * N * N); ' +
          'for (var gy = 0; gy < N; gy++) for (var gx = 0; gx < N; gx++) { ' +
          '  var x = Math.floor((gx + 0.5) * cw / N), y = Math.floor((gy + 0.5) * ch / N); ' +
          '  g.readPixels(x, y, 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf, ((gy * N + gx) * 4)); } ' +
          'var rows = []; ' +
          'for (var ry = N - 1; ry >= 0; ry--) { ' +   // GL row 0 = screen bottom -> print top first
          '  var cells = []; ' +
          '  for (var rx = 0; rx < N; rx++) { var o = (ry * N + rx) * 4; ' +
          '    cells.push(buf[o] + "," + buf[o + 1] + "," + buf[o + 2]); } ' +
          '  rows.push(cells.join(" ")); } ' +
          'return cw + "x" + ch + "\\n" + rows.join("\\n");');
        console.log('FRAMEBUFFER PROBE (top row = screen top):');
        console.log(grid);
      }

      const t0 = Date.now();
      let nextSample = 0, nextTap = 20000, midShot = false;
      while (Date.now() - t0 < SOAK_MS) {
        await sleep(1000);
        const el = Date.now() - t0;
        // periodic throttle top-up so the unsteered jet keeps flying
        if (el >= nextTap) {
          nextTap = el + 20000;
          await key('keyDown', 2000);
          await key('keyUp', 0);
        }
        if (el >= nextSample) {
          nextSample = el + 10000;
          const s = await evalJs(
            'var d = window.__SB_DEV__; ' +
            'return JSON.stringify(d ? d.stats() : null) + ' +
            '"|" + document.getElementById("hud-fps").textContent + ' +
            '"|" + document.getElementById("hud-spd").textContent + ' +
            '"|" + document.getElementById("hud-alt").textContent + ' +
            '"|" + d.state();');
          console.log(Math.round(el / 1000) + 's:', s);
          // auto-recovery: ended flight (debrief/death) -> reload into a fresh launch
          if (typeof s === 'string' && /\|6$/.test(s)) {
            console.log('flight ended -> re-navigating for a fresh launch');
            await send('Page.navigate', { url: URL_ });
            await sleep(7000);
            await key('keyDown', 4000);
            await key('keyUp', 0);
          }
        }
        if (!midShot && el >= SOAK_MS * 0.55) {
          midShot = true;
          const m = await send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(OUT.replace(/\.png$/, '') + '_mid.png', Buffer.from(m.data, 'base64'));
          console.log('mid-soak screenshot saved');
        }
      }
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot saved:', path.resolve(OUT));

    const hudFps = await evalJs('document.getElementById("hud-fps").textContent').catch(() => 'n/a');
    console.log('final hud-fps:', hudFps);

    const fatal = errors.filter((e) =>
      !/\[log\.network\] Failed to load resource.*(favicon|\.wasm|vec3)/.test(e));
    console.log('\n=== console problems (' + fatal.length + ') ===');
    for (const e of fatal.slice(0, 20)) console.log(e);
    if (!fatal.length) console.log('(none)');
    console.log('SOAK ' + (fatal.length === 0 ? 'PASS' : 'REVIEW-NEEDED'));
  } finally {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* keep going */ }
  }
}
main().then(() => process.exit(0))
  .catch((e) => { console.error('SOAK FAILED:', e.message); process.exit(1); });

