// Skyburn Phase 1 - World entity registry + object pools (Task 1.2).
// PRD: "SoA Float32Array max 512, pools bullets 500 missiles 64 particles 2000, no new in loop."
// SoA = Structure of Arrays: every field is its own preallocated typed array. Slots are stable
// (no compaction/swapping) so external systems hold plain integer ids for the entity lifetime.
// Zero allocation after construction: all mutating APIs write in place.

export const WORLD_MAX = 512;

// World entity types (jets + ships + ground units; bullets/missiles/particles live in their
// own pools). Phase 2 adds GROUND for SAM sites / hangars / radars (mission spawner).
export const ENT_TYPE = { NONE: 0, JET: 1, SHIP: 2, GROUND: 3 };

// Teams (PRD: player vs enemies; collisions are friendly-fire aware).
export const TEAM = { PLAYER: 0, ENEMY: 1, NEUTRAL: 2 };

export class WorldEntities {
  constructor(max) {
    this.max = max || WORLD_MAX;
    this.count = 0;                              // high-water mark (slots [0..count) ever used)
    this.type = new Uint8Array(this.max);        // ENT_TYPE, 0 = free slot
    this.team = new Uint8Array(this.max);
    this.alive = new Uint8Array(this.max);
    this.pos = new Float32Array(this.max * 3);
    this.prevPos = new Float32Array(this.max * 3); // render interpolation snapshot
    this.vel = new Float32Array(this.max * 3);
    this.rot = new Float32Array(this.max * 3);     // yaw, pitch, roll (rad)
    this.prevRot = new Float32Array(this.max * 3);
    this.radius = new Float32Array(this.max);      // collision sphere (m)
    this.health = new Float32Array(this.max);
    this.maxHealth = new Float32Array(this.max);
    this.speed = new Float32Array(this.max);       // m/s (scalar, cached for HUD/AI)
    this.gearDown = new Uint8Array(this.max);      // landing gear state (carrier landing)
    this.flareCount = new Uint16Array(this.max);
    this.missilesLeft = new Uint8Array(this.max);
    this.variant = new Uint8Array(this.max);       // mesh variant for the renderer (Phase 2):
                                                   // ships: 2 boat, 3 rig; ground: 4 SAM, 5 hangar, 6 radar
  }

  // Spawn into the first free slot. Returns the slot id, or -1 when full (pool cap respected;
  // PRD invariant: the game never keeps more entities than the array allows).
  spawn(type, team, x, y, z, yaw, pitch, roll, radius, health) {
    for (let i = 0; i < this.max; i++) {
      if (this.type[i] === ENT_TYPE.NONE) {
        this._init(i, type, team, x, y, z, yaw, pitch, roll, radius, health);
        return i;
      }
    }
    return -1;
  }

  _init(i, type, team, x, y, z, yaw, pitch, roll, radius, health) {
    this.type[i] = type; this.team[i] = team; this.alive[i] = 1;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.prevPos[i * 3] = x; this.prevPos[i * 3 + 1] = y; this.prevPos[i * 3 + 2] = z;
    this.vel[i * 3] = 0; this.vel[i * 3 + 1] = 0; this.vel[i * 3 + 2] = 0;
    this.rot[i * 3] = yaw; this.rot[i * 3 + 1] = pitch; this.rot[i * 3 + 2] = roll;
    this.prevRot[i * 3] = yaw; this.prevRot[i * 3 + 1] = pitch; this.prevRot[i * 3 + 2] = roll;
    this.radius[i] = radius;
    this.health[i] = health; this.maxHealth[i] = health;
    this.speed[i] = 0; this.gearDown[i] = 0; this.flareCount[i] = 0; this.missilesLeft[i] = 0;
    this.variant[i] = 0;
    if (i + 1 > this.count) this.count = i + 1;
  }

  kill(id) {
    this.alive[id] = 0;
    this.type[id] = ENT_TYPE.NONE; // free the slot; count stays (high-water mark)
  }

  // Returns true if the hit killed the entity (health reached 0 exactly this call).
  damage(id, amount) {
    if (!this.alive[id]) return false;
    this.health[id] -= amount;
    if (this.health[id] <= 0) {
      this.health[id] = 0;
      this.kill(id);
      return true;
    }
    return false;
  }

  isAlive(id) { return this.alive[id] === 1; }

  // Count of currently alive entities (allocation-free; O(max) over a tiny typed array).
  activeCount() {
    let n = 0;
    const a = this.alive;
    for (let i = 0; i < this.count; i++) if (a[i]) n++;
    return n;
  }

  // Free slots right now (spawn-time check for the mission spawner; not for the hot loop).
  freeSlotCount() {
    let n = 0;
    const t = this.type;
    for (let i = 0; i < this.max; i++) if (t[i] === ENT_TYPE.NONE) n++;
    return n;
  }
}

// Generic fixed-capacity pool (free-list stack). All arrays preallocated; alloc/free are O(1)
// and allocate nothing. Consumers attach their own typed-array fields sized [max * stride].
export class Pool {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.freeTop = max;
    this.freeList = new Int32Array(max);
    for (let i = 0; i < max; i++) this.freeList[i] = max - 1 - i; // stack grows from the end
  }

  // Returns a slot index or -1 when the pool is full (callers MUST handle -1: "no new in loop").
  alloc() {
    if (this.freeTop === 0) return -1;
    const id = this.freeList[--this.freeTop];
    this.active++;
    return id;
  }

  free(id) {
    this.freeList[this.freeTop++] = id;
    this.active--;
  }

  reset() {
    this.active = 0;
    this.freeTop = this.max;
    for (let i = 0; i < this.max; i++) this.freeList[i] = this.max - 1 - i;
  }
}
