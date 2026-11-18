// Skyburn Phase 0 - Runtime invariants (Task 0.8): no NaN in position, speed capped,
// activeCount check. Dev-only: stripped from the hot path in prod builds via
// globalThis.__SKYBURN_DEV__ = false (set by build.py in dist/index.html).
// Violations are counted and logged throttled (once per tag per second) - never spam.

let enabled = true;
let violationCount = 0;
let lastTag = '';
let lastLogTime = 0;

export function invariantsEnabled() {
  if (typeof globalThis.__SKYBURN_DEV__ === 'boolean') {
    return globalThis.__SKYBURN_DEV__ && enabled;
  }
  return enabled;
}

export function setInvariantsEnabled(v) { enabled = !!v; }
export function getViolationCount() { return violationCount; }
export function resetInvariants() { violationCount = 0; lastTag = ''; lastLogTime = 0; }

function fail(tag, detail) {
  violationCount++;
  const now = Date.now();
  if (tag !== lastTag || now - lastLogTime > 1000) {
    console.error('[SKYBURN invariant] ' + tag + ' ' + detail);
    lastTag = tag;
    lastLogTime = now;
  }
}

// Fixed-arity variants (no rest-args allocation - safe to call every tick).
export function assertFinite3(tag, x, y, z) {
  if (!invariantsEnabled()) return;
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
    fail(tag, 'non-finite: ' + x + ',' + y + ',' + z);
  }
}

export function assertFinite1(tag, x) {
  if (!invariantsEnabled()) return;
  if (!Number.isFinite(x)) fail(tag, 'non-finite: ' + x);
}

// PRD: speed never exceeds maxSpeed * 1.05 (arcade tolerance).
export function assertSpeedCapped(tag, speed, maxSpeed) {
  if (!invariantsEnabled()) return;
  if (!Number.isFinite(speed)) { fail(tag, 'speed non-finite'); return; }
  if (speed > maxSpeed * 1.05) {
    fail(tag, 'speed ' + speed + ' exceeds cap ' + (maxSpeed * 1.05));
  }
}

// PRD: game never spawns/keeps more entities than the pool allows.
export function assertActiveCount(tag, activeCount, maxCount) {
  if (!invariantsEnabled()) return;
  if (!(activeCount >= 0 && activeCount <= maxCount)) {
    fail(tag, 'activeCount ' + activeCount + ' outside [0,' + maxCount + ']');
  }
}

// ---- Phase 4 additions (Task 4.2): health/fuel ranges + pool integrity ----

// PRD invariant: health 0-100, fuel >= 0 (any bounded resource lives in [lo, hi]).
export function assertRange(tag, v, lo, hi) {
  if (!invariantsEnabled()) return;
  if (!Number.isFinite(v)) { fail(tag, 'non-finite range value: ' + v); return; }
  if (v < lo || v > hi) {
    fail(tag, 'value ' + v + ' outside [' + lo + ',' + hi + ']');
  }
}

// Cheap per-tick pool check (O(1)): active never escapes [0, max]. Pairs with
// auditPool() below, which is O(max) and meant for tests/dev tools only.
export function assertPool(tag, pool) {
  if (!invariantsEnabled()) return;
  if (!pool || typeof pool.active !== 'number') { fail(tag, 'no pool'); return; }
  if (pool.active < 0 || pool.active > pool.max) {
    fail(tag, 'pool.active ' + pool.active + ' outside [0,' + pool.max + ']');
  }
}

// O(max) structural integrity audit: every slot sits in exactly one of
// {active, freeList}, freeList holds no duplicates or out-of-range ids, and
// freeTop matches the free count. Returns null when consistent, else the
// first problem as a string. Dev/test-time only (allocates one Uint8Array).
export function auditPool(pool) {
  if (!pool || !pool.freeList) return 'no pool';
  const seen = new Uint8Array(pool.max);
  for (let i = 0; i < pool.freeTop; i++) {
    const id = pool.freeList[i];
    if (!(id >= 0 && id < pool.max)) return 'freeList[' + i + '] out of range: ' + id;
    if (seen[id]) return 'slot ' + id + ' duplicated in freeList';
    seen[id] = 1;
  }
  if (pool.freeTop < 0 || pool.freeTop > pool.max) {
    return 'freeTop ' + pool.freeTop + ' outside [0,' + pool.max + ']';
  }
  if (pool.freeTop + pool.active !== pool.max) {
    return 'free ' + pool.freeTop + ' + active ' + pool.active + ' != max ' + pool.max;
  }
  return null;
}
