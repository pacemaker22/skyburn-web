// Skyburn Phase 5 (Task 5.1) - PWA service worker: offline after first visit.
// Strategy (no framework, no external deps - PRD stack):
//  - install: precache the app shell (PRECACHE_LIST). build.py rewrites PRECACHE_LIST and
//    VERSION in dist/sw.js with the FULL dist file set + a content-hashed cache name, so
//    every deployed build gets a fresh cache namespace (no stale-asset bugs on update).
//  - fetch: same-origin GET only. Assets use stale-while-revalidate (instant cached
//    response + background refresh), navigations are network-first with a cached
//    index.html fallback. Every successful response is stored, so the FIRST online visit
//    makes the whole game available offline - airplane mode still plays.
//  - activate: delete stale cache namespaces, claim existing clients.
// This file only runs on lifecycle/fetch events - never in the frame hot loop.

const VERSION = 'v1-dev';
const CACHE = 'skyburn-' + VERSION;
const PRECACHE_LIST = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-64.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individual puts: one missing dev artifact must not fail the whole install.
    await Promise.all(PRECACHE_LIST.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first (picks up new deploys), cached index.html when offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        return (await cache.match('./index.html')) || (await cache.match('./')) ||
          Response.error();
      }
    })());
    return;
  }

  // Assets: stale-while-revalidate - cached copy immediately, background re-fetch.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req).then((fresh) => {
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    }).catch(() => null);
    if (hit) return hit;
    const fresh = await refresh;
    return fresh || Response.error();
  })());
});
