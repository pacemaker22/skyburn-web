// Skyburn Phase 1 - Collision (Task 1.6: "BVH+Sphere+Hash, ground crash, proximity fuse 8m,
// ship sphere"). Phase 1 scale (<= 512 entities) uses a spatial hash grid (chained buckets,
// rebuilt every tick from typed arrays - zero allocation) + exact sphere-sphere /
// segment-vs-sphere tests. The hash plays the BVH role at this entity count (documented
// deviation: BVH arrives with mission-scale statics in later phases; hash is O(n) rebuild,
// O(cell) query, no per-tick allocation).
//
// Entities are registered in EVERY cell their bounding sphere's x/z AABB overlaps (a jet is
// 1-4 cells, the carrier 3x3). Without this, a ray that skims a cell boundary parallel to the
// entity center line enters the neighbor cell and never visits the center cell - the sphere
// (which pokes into the visited cell) would be missed. Chains run over "slots" (one slot per
// entity-cell pair) because a plain per-entity next[] cannot link one entity into several
// buckets. querySphere dedupes multi-cell entities with a generation stamp; segmentQuery does
// not need it (bestT makes duplicate candidates idempotent).
//
// Entity ids are indices into a WorldEntities registry (src/combat/entities.js).

import { ENT_TYPE } from './entities.js';

const BUCKETS = 4096;              // power of two -> hash via mask
const BUCKET_MASK = BUCKETS - 1;
export const CELL_SIZE = 128;      // meters (grid cell)
// Slot capacity per entity: worst case is the carrier (r=70 -> 3x3 cells); margin for
// larger hulls. 512 entities * 16 = 8192 slots, ~32 KB total - rebuilt in place per tick.
const MAX_CELLS_PER_ENT = 16;

function hash2(cx, cz) {
  // xor-fold signed cell coords into the bucket mask
  let h = (cx * 0x8da6b343) ^ (cz * 0xd8163841);
  h = h ^ (h >>> 13);
  return h & BUCKET_MASK;
}

export class CollisionWorld {
  constructor(maxEntities) {
    this.max = maxEntities;
    this.heads = new Int32Array(BUCKETS);                          // first slot per bucket
    this.next = new Int32Array(maxEntities * MAX_CELLS_PER_ENT);   // slot -> next slot
    this.entOf = new Int32Array(maxEntities * MAX_CELLS_PER_ENT);  // slot -> entity id
    this._stamp = new Int32Array(maxEntities);                     // querySphere dedupe
    this._gen = 0;
    // CRITICAL: 0 is a valid slot index, so an all-zero heads[] would make every bucket's
    // chain "start" at slot 0 whose next[] is also 0 -> the chain walk spins forever on any
    // query before the first rebuild(). Empty buckets must read -1 from the very start.
    this.heads.fill(-1);
  }

  // Rebuild buckets from the live entity set. O(n * cellsPerEntity), no allocation.
  rebuild(ents) {
    this.heads.fill(-1);
    const inv = 1 / CELL_SIZE;
    const cap = this.next.length;
    let s = 0;
    for (let i = 0; i < ents.count; i++) {
      if (ents.type[i] === ENT_TYPE.NONE) continue;
      const r = ents.radius[i];
      const px = ents.pos[i * 3], pz = ents.pos[i * 3 + 2];
      const cx0 = Math.floor((px - r) * inv), cx1 = Math.floor((px + r) * inv);
      const cz0 = Math.floor((pz - r) * inv), cz1 = Math.floor((pz + r) * inv);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (s >= cap) break; // capacity guard; MAX_CELLS_PER_ENT keeps this unreachable
          const b = hash2(cx, cz);
          this.entOf[s] = i;
          this.next[s] = this.heads[b];
          this.heads[b] = s;
          s++;
        }
      }
    }
  }

  // Query entities whose sphere intersects the sphere (x,y,z,r). Writes ids into out (must be
  // caller-allocated Int32Array). Returns the count (each id at most once even when registered
  // in several overlapping cells). Typical r <= 2 cells -> 9-25 buckets.
  querySphere(ents, x, y, z, r, out) {
    if (++this._gen >= 0x7fffffff) { this._gen = 1; this._stamp.fill(0); }
    const gen = this._gen;
    const inv = 1 / CELL_SIZE;
    const cx = Math.floor(x * inv), cz = Math.floor(z * inv);
    const ring = Math.ceil(r / CELL_SIZE) + 1;
    const r2 = r * r;
    let n = 0;
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        let s = this.heads[hash2(cx + dx, cz + dz)];
        // bounded walk (see segmentQuery): guards against a query before rebuild()
        let chainGuard = this.next.length;
        while (s !== -1 && chainGuard-- > 0) {
          const id = this.entOf[s];
          s = this.next[s];
          if (this._stamp[id] === gen) continue; // already reported (multi-cell entity)
          this._stamp[id] = gen;
          if (ents.type[id] !== ENT_TYPE.NONE) {
            const ox = ents.pos[id * 3] - x;
            const oy = ents.pos[id * 3 + 1] - y;
            const oz = ents.pos[id * 3 + 2] - z;
            const rr = r + ents.radius[id];
            if (ox * ox + oy * oy + oz * oz <= rr * rr && n < out.length) {
              out[n++] = id;
            }
          }
        }
      }
    }
    return n;
  }

  // Exact segment vs entity-spheres raycast (hitscan bullets, lock LOS). Walks buckets along
  // the segment via 2D DDA on x/z (PRD: "Raycast DDA"), then solves ray-sphere per candidate.
  // Writes the nearest hit into `hit` ({ id, dist, px, py, pz } - preallocated by caller).
  // `skipId` may be -1. `teamFilter` = -1 for any, else a TEAM constant. Returns true on hit.
  // Duplicate candidates (entity registered in several cells along the ray) are harmless:
  // bestT makes only the nearest registration count.
  segmentQuery(ents, x0, y0, z0, x1, y1, z1, skipId, teamFilter, hit) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len2 = dx * dx + dy * dy + dz * dz;
    const segLen = Math.sqrt(len2);
    if (segLen < 1e-6) return false;
    const inv = 1 / CELL_SIZE;
    let cx = Math.floor(x0 * inv), cz = Math.floor(z0 * inv);
    const cx1 = Math.floor(x1 * inv), cz1 = Math.floor(z1 * inv);
    const stepX = cx1 > cx ? 1 : (cx1 < cx ? -1 : 0);
    const stepZ = cz1 > cz ? 1 : (cz1 < cz ? -1 : 0);
    const tDeltaX = stepX !== 0 ? Math.abs(CELL_SIZE / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(CELL_SIZE / dz) : Infinity;
    let tMaxX = stepX !== 0
      ? ((stepX > 0 ? (cx + 1) * CELL_SIZE - x0 : x0 - cx * CELL_SIZE) / Math.abs(dx))
      : Infinity;
    let tMaxZ = stepZ !== 0
      ? ((stepZ > 0 ? (cz + 1) * CELL_SIZE - z0 : z0 - cz * CELL_SIZE) / Math.abs(dz))
      : Infinity;
    let found = false;
    let bestT = 1; // normalized segment parameter of the closest hit so far
    for (let guard = 0; guard <= 512; guard++) {
      let s = this.heads[hash2(cx, cz)];
      // bounded walk: next[] is typed-array zero for never-written slots, so a corrupted
      // heads[] (query before rebuild) would otherwise spin here forever
      let chainGuard = this.next.length;
      while (s !== -1 && chainGuard-- > 0) {
        const ns = this.next[s];
        const id = this.entOf[s];
        if (id !== skipId && ents.type[id] !== ENT_TYPE.NONE &&
          (teamFilter === -1 || ents.team[id] === teamFilter)) {
          const ox = ents.pos[id * 3] - x0;
          const oy = ents.pos[id * 3 + 1] - y0;
          const oz = ents.pos[id * 3 + 2] - z0;
          const rr = ents.radius[id];
          const tCa = (ox * dx + oy * dy + oz * dz) / len2; // closest-approach param [0..1]
          if (tCa > 0 && tCa < bestT + rr / segLen) {
            const d2 = (ox * ox + oy * oy + oz * oz) - tCa * tCa * len2;
            if (d2 <= rr * rr) {
              const thc = Math.sqrt(rr * rr - d2) / segLen;
              let t = tCa - thc;
              if (t < 0) t = 0;
              if (t < bestT) {
                bestT = t;
                hit.id = id;
                hit.dist = t * segLen;
                hit.px = x0 + dx * t;
                hit.py = y0 + dy * t;
                hit.pz = z0 + dz * t;
                found = true;
              }
            }
          }
        }
        s = ns;
      }
      if (cx === cx1 && cz === cz1) break;
      if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
      else { cz += stepZ; tMaxZ += tDeltaZ; }
    }
    return found;
  }
}

// Ground/sea collision helper (PRD: "ground crash"). Returns the surface height when the point
// is at or below terrain+clearance (or sea level 0), else -1. Caller decides crash vs landing.
export function groundHitAt(terrain, x, y, z, clearance) {
  const h = terrain.heightAt(x, z);
  const surface = h > 0 ? h : 0;
  return y <= surface + clearance ? surface : -1;
}
