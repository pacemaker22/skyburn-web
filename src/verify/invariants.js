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
