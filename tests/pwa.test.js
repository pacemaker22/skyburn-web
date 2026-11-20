// Skyburn Phase 5 (Task 5.1): PWA artifacts - manifest, service worker, icons, wiring.
// Icons are regenerated with `python tools/gen_icons.py` (original procedural art only).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

test('pwa: manifest valid + installable (192/512 icons on disk, real PNGs, maskable)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'SKYBURN');
  assert.ok(manifest.display === 'fullscreen' || manifest.display === 'standalone');
  assert.equal(manifest.background_color, '#0a0e14');
  assert.equal(manifest.theme_color, '#0a0e14');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'installability needs 192x192');
  assert.ok(sizes.includes('512x512'), 'installability needs 512x512');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable present');
  for (const icon of manifest.icons) {
    const path = ROOT + icon.src;
    assert.ok(existsSync(path), 'icon file exists: ' + icon.src);
    const sig = readFileSync(path).subarray(0, 8);
    assert.deepEqual([...sig], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'PNG signature: ' + icon.src);
  }
});

test('pwa: service worker provides offline caching (lifecycle + fetch + guards)', () => {
  const sw = read('sw.js');
  assert.match(sw, /addEventListener\('install'/);
  assert.match(sw, /addEventListener\('activate'/);
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /skipWaiting/, 'new SW takes over promptly');
  assert.match(sw, /clients\.claim/, 'controls open pages without reload');
  assert.match(sw, /req\.method !== 'GET'/, 'only GET is cached');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'same-origin guard');
  assert.match(sw, /caches\.open/, 'runtime caching (offline after first visit)');
  assert.match(sw, /req\.mode === 'navigate'/, 'navigation fallback to cached index');
  assert.match(sw, /skyburn-/, 'versioned cache namespace');
});

test('pwa: index.html wires manifest + icons + guarded SW registration', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.json">/);
  assert.match(html, /<meta name="theme-color" content="#0a0e14">/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\.\/icons\/icon-64\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\.\/icons\/icon-192\.png">/);
  assert.match(html, /'serviceWorker' in navigator/, 'feature-detected registration');
  assert.match(html, /serviceWorker\.register\('\.\/sw\.js'\)/);
  assert.match(html, /location\.protocol === 'https:'/,
    'skips on insecure contexts (plain http LAN / file://)');
});

test('pwa: icons are original procedural art with a committed generator (no copied assets)', () => {
  assert.ok(existsSync(ROOT + 'tools/gen_icons.py'), 'icon generator exists');
  const src = read('tools/gen_icons.py');
  assert.match(src, /ORIGINAL procedural artwork/, 'golden-rule note present');
});
