// Skyburn Phase 3A - Content tests (Tasks 3A.1 + 3A.3 + 3A.4): full jet roster schema,
// balance anchors from PLAN.md, weapons data integrity, kitbash mesh validity, hangar
// economy contract and save credits/ownership roundtrip. All headless (pure modules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildJetKitLod, SHAPE_IDS, shapeIndexFor } from '../src/render/models.js';
import { buyJet, jetOwned, creditsForRun, statRows, compareRows } from '../src/ui/hangar.js';
import { defaultSaveData, mergeSave, SaveSystem, MemoryBackend } from '../src/core/save.js';
import { parseAceCondition } from '../src/mission/ace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const jetsData = JSON.parse(readFileSync(join(ROOT, 'src/data/jets.json'), 'utf-8'));
const weaponsData = JSON.parse(readFileSync(join(ROOT, 'src/data/weapons.json'), 'utf-8'));
const missionsData = JSON.parse(readFileSync(join(ROOT, 'src/data/missions.json'), 'utf-8'));
const mapsData = JSON.parse(readFileSync(join(ROOT, 'src/data/maps.json'), 'utf-8'));
const JETS = jetsData.jets;
const WEAPONS = weaponsData.weapons;

// ---------------------------------------------------------------------------
// 3A.1 roster: schema + uniqueness + Phase 0 anchors intact

test('roster: 40+ jets, unique ids, full Appendix B schema on every entry', () => {
  assert.ok(JETS.length >= 40, '40+ jets, got ' + JETS.length);
  const ids = new Set();
  const FIELDS = ['id', 'name', 'country', 'tier', 'thrust', 'drag', 'maxSpeed', 'turnRate',
    'stallSpeed', 'radarRange', 'stealthFactor', 'hardpoints', 'gunDamage', 'flareCount', 'price'];
  for (const j of JETS) {
    assert.ok(!ids.has(j.id), 'duplicate id ' + j.id);
    ids.add(j.id);
    for (const f of FIELDS) assert.ok(j[f] !== undefined, j.id + ' missing ' + f);
    assert.ok(j.tier >= 1 && j.tier <= 5, j.id + ' tier');
    assert.ok(j.thrust > 0 && j.maxSpeed > 0 && j.turnRate > 0 && j.stallSpeed > 0);
    assert.ok(j.drag > 0 && j.drag < 0.1, j.id + ' drag');
    assert.ok(j.radarRange >= 2000 && j.radarRange <= 20000, j.id + ' radar');
    assert.ok(j.stealthFactor > 0 && j.stealthFactor <= 1, j.id + ' stealth');
    assert.ok(j.hardpoints >= 0 && j.hardpoints <= 14, j.id + ' hardpoints');
    assert.ok(j.price > 0, j.id + ' price');
    if (j.armor !== undefined) assert.ok(j.armor >= 1 && j.armor <= 2, j.id + ' armor');
    if (j.shape !== undefined) assert.ok(SHAPE_IDS.indexOf(j.shape) >= 0, j.id + ' shape');
    if (j.paint !== undefined) {
      assert.equal(j.paint.length, 3, j.id + ' paint rgb');
      for (const c of j.paint) assert.ok(c >= 0 && c <= 1, j.id + ' paint range');
    }
    if (j.accent !== undefined) assert.equal(j.accent.length, 3, j.id + ' accent rgb');
    if (j.loadout !== undefined) assert.ok(Array.isArray(j.loadout), j.id + ' loadout array');
  }
  // all 5 tiers populated, multiple countries represented
  const tiers = [...new Set(JETS.map((j) => j.tier))].sort();
  assert.deepEqual(tiers, [1, 2, 3, 4, 5], 'tiers 1-5 all present');
  assert.ok(new Set(JETS.map((j) => j.country)).size >= 6, '6+ countries');
  // prices are unique (economy anchors stay distinguishable)
  const prices = new Set(JETS.map((j) => j.price));
  assert.equal(prices.size, JETS.length, 'unique prices');
});

test('roster: Phase 0 Appendix B values unchanged for F-16C and MiG-29', () => {
  const f16 = JETS.find((j) => j.id === 'f16c');
  const mig = JETS.find((j) => j.id === 'mig29');
  assert.ok(f16 && mig);
  assert.equal(f16.thrust, 129000);
  assert.equal(f16.drag, 0.021);
  assert.equal(f16.maxSpeed, 2120);
  assert.equal(f16.turnRate, 18.5);
  assert.equal(f16.stallSpeed, 180);
  assert.equal(f16.radarRange, 8000);
  assert.equal(f16.stealthFactor, 0.65);
  assert.equal(f16.hardpoints, 6);
  assert.equal(f16.gunDamage, 12);
  assert.equal(f16.flareCount, 60);
  assert.equal(f16.price, 1200);
  assert.equal(mig.thrust, 162800);
  assert.equal(mig.maxSpeed, 2200);
  assert.equal(mig.price, 1000);
});

test('roster: PLAN 3A.3 balance anchors (F-22/Su-35/A-10/SR-71)', () => {
  const f22 = JETS.find((j) => j.id === 'f22');
  const su35 = JETS.find((j) => j.id === 'su35');
  const a10 = JETS.find((j) => j.id === 'a10');
  const sr71 = JETS.find((j) => j.id === 'sr71');
  const f16 = JETS.find((j) => j.id === 'f16c');
  assert.ok(f22 && su35 && a10 && sr71 && f16);
  // F-22 stealth 0.15
  assert.equal(f22.stealthFactor, 0.15, 'F-22 stealthFactor');
  // Su-35 turn 1.2x the F-16C baseline
  assert.ok(Math.abs(su35.turnRate - f16.turnRate * 1.2) < 1e-9,
    'Su-35 turnRate = 1.2 x F-16C baseline, got ' + su35.turnRate);
  // A-10 armor 2x
  assert.equal(a10.armor, 2.0, 'A-10 armor');
  // SR-71: Mach 3.3 (~4025 km/h), no missiles, no gun, no flares
  assert.ok(sr71.maxSpeed >= 4000 && sr71.maxSpeed <= 4100,
    'SR-71 Mach 3.3 band, got ' + sr71.maxSpeed);
  assert.equal(sr71.hardpoints, 0, 'SR-71 hardpoints');
  assert.equal(sr71.gunDamage, 0, 'SR-71 gunDamage');
  assert.deepEqual(sr71.loadout, [], 'SR-71 unarmed loadout');
});

// ---------------------------------------------------------------------------
// 3A.3 weapons data + loadout integrity

test('weapons: unique ids, gun/missile types, per-type fields sane', () => {
  const ids = new Set();
  for (const w of WEAPONS) {
    assert.ok(!ids.has(w.id), 'duplicate weapon ' + w.id);
    ids.add(w.id);
    assert.ok(w.type === 'gun' || w.type === 'missile', w.id + ' type');
    assert.ok(w.damage > 0, w.id + ' damage');
    if (w.type === 'gun') {
      assert.equal(w.guidance, 'none', w.id + ' gun guidance');
      assert.ok(w.rpm > 0 && w.range > 0, w.id + ' gun fields');
    } else {
      assert.ok(w.guidance === 'ir' || w.guidance === 'radar', w.id + ' guidance');
      assert.ok(w.lockTime > 0 && w.range > 0, w.id + ' missile fields');
      assert.ok(w.flareResist >= 0 && w.flareResist <= 1, w.id + ' flareResist');
    }
  }
  assert.ok(WEAPONS.filter((w) => w.type === 'gun').length >= 2, '2+ gun types');
  assert.ok(WEAPONS.filter((w) => w.type === 'missile').length >= 4, '4+ missile types');
});

test('loadouts: reference valid weapons; exactly one gun; unarmed jets stay unarmed', () => {
  const byId = new Map(WEAPONS.map((w) => [w.id, w]));
  for (const j of JETS) {
    const lo = j.loadout || [];
    for (const wid of lo) assert.ok(byId.has(wid), j.id + ' unknown weapon ' + wid);
    const guns = lo.filter((wid) => byId.get(wid).type === 'gun');
    if (j.hardpoints === 0) {
      assert.equal(lo.length, 0, j.id + ' unarmed jet must have empty loadout');
    } else {
      assert.equal(guns.length, 1, j.id + ' exactly one gun');
      assert.ok(lo.length >= 2, j.id + ' at least gun + one missile');
      const missiles = lo.filter((wid) => byId.get(wid).type === 'missile');
      assert.ok(missiles.length >= 1, j.id + ' carries at least one missile');
    }
  }
});

// ---------------------------------------------------------------------------
// 3A.2 kitbash mesh validity

test('kitbash: every shape x LOD builds a valid interleaved mesh', () => {
  for (const shape of SHAPE_IDS) {
    let prevIdx = Infinity;
    for (let level = 0; level < 3; level++) {
      const m = buildJetKitLod({ shape, paint: [0.5, 0.5, 0.5] }, level);
      assert.equal(m.stride, 9, shape + ' stride');
      assert.equal(m.verts.length % 9, 0, shape + ' LOD' + level + ' verts divisible');
      assert.equal(m.idx.length % 3, 0, shape + ' LOD' + level + ' tris');
      const vertCount = m.verts.length / 9;
      assert.ok(vertCount > 0 && vertCount < 65536,
        shape + ' LOD' + level + ' vertCount in Uint16 range');
      for (const ix of m.idx) assert.ok(ix < vertCount, shape + ' idx in range');
      // LODs must shed detail: each level has strictly fewer triangles
      assert.ok(m.idx.length < prevIdx, shape + ' LOD' + level + ' sheds detail');
      prevIdx = m.idx.length;
    }
  }
});

test('kitbash: every roster jet maps to a valid shape index; unknown -> 0', () => {
  for (const j of JETS) {
    const idx = shapeIndexFor(j);
    assert.ok(idx >= 0 && idx < SHAPE_IDS.length, j.id + ' shape index');
  }
  assert.equal(shapeIndexFor({}), 0, 'missing shape defaults to multi');
  assert.equal(shapeIndexFor(null), 0, 'null jet defaults to multi');
  // every shape family is actually used by the roster (no dead meshes)
  const used = new Set(JETS.map((j) => shapeIndexFor(j)));
  assert.equal(used.size, SHAPE_IDS.length, 'all 7 families used');
});

// ---------------------------------------------------------------------------
// 3A.4 hangar economy (pure helpers) + save credits/ownership

test('hangar: buyJet deducts credits and grants ownership; failures leave state clean', () => {
  const save = defaultSaveData();          // credits 1500, owns f16c + mig29
  const f5e = JETS.find((j) => j.id === 'f5e');   // price 450
  assert.ok(jetOwned(save, 'f16c'));
  const res = buyJet(save, f5e);
  assert.equal(res.ok, true);
  assert.equal(save.credits, 1500 - 450);
  assert.ok(jetOwned(save, 'f5e'));
  // already owned
  const again = buyJet(save, f5e);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-owned');
  // insufficient credits
  save.credits = 100;
  const poor = buyJet(save, JETS.find((j) => j.id === 'f22'));  // 4200
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, 'insufficient-credits');
  assert.equal(save.credits, 100, 'failed purchase leaves credits untouched');
  assert.ok(!jetOwned(save, 'f22'));
});

test('hangar: creditsForRun - win pays reward + 10% score, loss 5%, sandbox win 10%', () => {
  const m1 = { reward: 200 };
  assert.equal(creditsForRun(m1, { success: true, score: 4210 }), 200 + 421);
  assert.equal(creditsForRun(m1, { success: false, score: 900 }), 45);
  assert.equal(creditsForRun(null, { success: true, score: 1000 }), 100,
    'sandbox win still pays score slice');
  assert.equal(creditsForRun(m1, null), 0, 'no results -> no credits');
});

test('hangar: statRows/compareRows produce complete, bounded rows', () => {
  const a = JETS.find((j) => j.id === 'a10');
  const b = JETS.find((j) => j.id === 'f22');
  const rowsA = statRows(a);
  assert.ok(rowsA.length >= 8, 'stat panel rows');
  for (const r of rowsA) {
    assert.equal(r.length, 3, 'label, formatted, bar');
    assert.ok(r[2] >= 0 && r[2] <= 1, 'bar bounded');
  }
  const cmp = compareRows(a, b);
  assert.ok(cmp.length >= 9, 'compare rows incl. price');
  const price = cmp[cmp.length - 1];
  assert.equal(price.label, 'Price');
  assert.equal(price.better, 'a', 'A-10 (700cr) is cheaper than F-22 (4200cr)');
  const turn = cmp.find((r) => r.label === 'Turn rate');
  assert.equal(turn.better, 'b', 'F-22 out-turns the A-10');
});

test('save: credits + ownedJets defaults, merge roundtrip through the backend', async () => {
  const base = defaultSaveData();
  assert.equal(base.credits, 1500);
  assert.deepEqual(base.ownedJets, ['f16c', 'mig29']);
  // merge preserves loaded credits/ownedJets (older saves gain the new fields)
  const merged = mergeSave({ version: 1, unlocked: ['m1', 'm2'], credits: 4321,
    ownedJets: ['f16c', 'mig29', 'f22'] });
  assert.equal(merged.credits, 4321);
  assert.deepEqual(merged.ownedJets, ['f16c', 'mig29', 'f22']);
  // old save without credits gets defaults
  const old = mergeSave({ version: 1 });
  assert.equal(old.credits, 1500);
  assert.deepEqual(old.ownedJets, ['f16c', 'mig29']);
  // full backend roundtrip (close + reopen)
  MemoryBackend.reset();
  const s1 = new SaveSystem(new MemoryBackend());
  const data = await s1.load();
  data.credits = 2000;
  data.ownedJets.push('a10');
  await s1.save(data);
  const s2 = new SaveSystem(new MemoryBackend());
  const reloaded = await s2.load();
  assert.equal(reloaded.credits, 2000);
  assert.ok(reloaded.ownedJets.indexOf('a10') >= 0);
  assert.ok(jetOwned(reloaded, 'a10'));
});

// ---------------------------------------------------------------------------
// 3B.1 + 3B.2 + 3B.4: eight maps, missions M5-M14, unlock chain, zone refs, budgets

test('3B.1 maps: eight sectors with seeds/atmosphere; every referenced zone exists', () => {
  const MAPS = mapsData.maps;
  for (const n of ['ocean', 'coast', 'rig', 'island', 'desert', 'city', 'arctic', 'night']) {
    assert.ok(MAPS[n], 'map ' + n + ' exists');
  }
  for (const id of Object.keys(MAPS)) {
    const m = MAPS[id];
    assert.equal(m.id, id);
    assert.ok(m.points && m.points.playerStart, id + ' playerStart');
    assert.ok(Number.isInteger(m.seed), id + ' integer terrain seed');
    if (m.atmosphere) {
      for (const k of ['fog', 'zenith', 'horizon']) {
        const v = m.atmosphere[k];
        assert.ok(Array.isArray(v) && v.length === 3, id + ' atmosphere.' + k);
        for (const c of v) assert.ok(c >= 0 && c <= 1.5, id + ' atmosphere range');
      }
      const sun = m.atmosphere.sun;
      assert.ok(Array.isArray(sun) && sun.length === 3, id + ' atmosphere.sun');
      for (const c of sun) assert.ok(c >= -1 && c <= 1, id + ' sun is a direction vector');
    }
  }
  for (const def of missionsData.missions) {
    const map = MAPS[def.map];
    assert.ok(map, def.id + ' map exists');
    for (const stage of def.stages) {
      for (const w of stage.waves || []) {
        for (const u of w.units || []) {
          assert.ok(map.points[u.zone], def.id + ' wave zone "' + u.zone + '" on ' + def.map);
        }
      }
      for (const o of stage.objectives) {
        if (o.waypoints) {
          for (const wp of o.waypoints) assert.ok(map.points[wp], def.id + ' waypoint ' + wp);
        }
      }
    }
    for (const a of def.assets || []) {
      assert.ok(map.points[a.zone], def.id + ' asset zone ' + a.zone);
    }
  }
});

test('3B.2 missions: fourteen, linear chain, valid schemas, M14 uses all five types', () => {
  const M = missionsData.missions;
  assert.equal(M.length, 14);
  for (let i = 0; i < 14; i++) assert.equal(M[i].id, 'm' + (i + 1), 'ordered m1..m14');
  for (let i = 0; i < 13; i++) assert.equal(M[i].unlocks, 'm' + (i + 2), M[i].id + ' unlocks next');
  assert.equal(M[13].unlocks, null, 'm14 finale ends the chain');
  const TYPES = ['air_to_air', 'ground', 'naval', 'escort', 'recon'];
  for (const def of M) {
    for (const stage of def.stages) {
      for (const o of stage.objectives) {
        assert.ok(TYPES.indexOf(o.type) >= 0, def.id + ' objective type ' + o.type);
        if (o.type === 'escort') {
          assert.ok(o.groups && o.holdTime > 0, def.id + ' escort shape');
        } else {
          assert.ok(o.timer > 0, def.id + ' timed objective');
          if (o.type === 'recon') {
            assert.ok(o.waypoints.length >= 2 && o.altMin !== undefined && o.radius > 0,
              def.id + ' recon shape');
          } else {
            assert.ok(o.groups && o.count > 0, def.id + ' kill-list shape');
          }
        }
        for (const d of o.deps || []) {
          assert.ok(stage.objectives.some((o2) => o2.id === d), def.id + ' dep ' + d);
        }
      }
    }
    assert.ok(def.aceBonus && def.aceBonus.length >= 1 && def.aceBonus.length <= 3,
      def.id + ' aceBonus 1-3');
    for (const b of def.aceBonus) {
      assert.ok(b.id && b.desc, def.id + ' bonus fields');
      parseAceCondition(b.condition); // throws on unknown kinds / missing parameters
    }
  }
  const m14 = M[13];
  const used = new Set();
  for (const s of m14.stages) for (const o of s.objectives) used.add(o.type);
  assert.deepEqual([...used].sort(), TYPES.slice().sort(), 'finale uses all 5 objective types');
});

test('3B.4 balancing: stage timer budgets bound every mission; M11 fits 6 minutes', () => {
  const M = missionsData.missions;
  for (const def of M) {
    let budget = 0;
    for (const stage of def.stages) {
      let maxT = 0;
      for (const o of stage.objectives) if (o.timer) maxT = Math.max(maxT, o.timer);
      budget += maxT;
    }
    assert.ok(budget >= 300 && budget <= 1440,
      def.id + ' fail-ceiling budget ' + budget + 's inside the Veteran play window');
  }
  const m11 = M[10];
  assert.equal(m11.recommendedJet, 'sr71', 'Oxcart recommends the Blackbird');
  assert.ok(JETS.some((j) => j.id === m11.recommendedJet), 'recommended jet is in the roster');
  assert.equal(m11.stages.length, 1, 'single photo-run stage');
  const o = m11.stages[0].objectives[0];
  assert.equal(o.type, 'recon');
  assert.ok(o.waypoints.length >= 5, 'five camera gates');
  assert.ok(o.timer <= 360, 'SR-71 photo run inside the 6-minute acceptance window');
});

test('3B.3 economy: earned Ace Bonuses pay credits on top of the run', () => {
  const def = { reward: 1000 };
  assert.equal(creditsForRun(def, { success: true, score: 1000, aceCount: 2 }),
    1000 + 400 + 100, 'win: reward + 200/ace + 10% score');
  assert.equal(creditsForRun(def, { success: false, score: 1000, aceCount: 3 }),
    300 + 50, 'loss: 100/ace + 5% score');
  assert.equal(creditsForRun(def, { success: true, score: 1000 }), 1000 + 100,
    'no ace fields -> legacy math unchanged');
});



