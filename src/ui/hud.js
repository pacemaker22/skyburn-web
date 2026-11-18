// Skyburn Phase 2 - HUD v2 widgets (Task 2.8): "objective tracker, stage banner, protected
// HP, cruise missile warning, distance". DOM is built once here (index.html keeps only the
// Phase 0/1 containers); per-frame updates mutate textContent in place at 4 Hz - no
// allocation in the render path. Objective line text comes from the pure formatter in
// mission/objectives.js (unit-tested headlessly).

import { formatObjectiveLine } from '../mission/objectives.js';

// Phase 4 (Task 4.7): HUD palettes. Roles: done (objective complete), failed
// (objective failed), warn (protected HP low), hidden (inactive objective),
// base (active objective). Colorblind-safe sets keep the same ROLES so meaning
// never relies on hue alone (position + symbol prefix already do heavy lifting).
export const HUD_PALETTES = {
  normal: { done: '#7fd67f', failed: '#ff6b6b', warn: '#ffd54f', hidden: '#7a8ea3', base: '#cfe8ff' },
  // protanopia/deuteranopia: blue vs orange (no red/green axis), amber kept dark
  protan: { done: '#4fc3f7', failed: '#ff9e40', warn: '#ffe082', hidden: '#7a8ea3', base: '#cfe8ff' },
  deutan: { done: '#4fc3f7', failed: '#ff9e40', warn: '#ffe082', hidden: '#7a8ea3', base: '#cfe8ff' },
  // tritanopia: teal vs warm rose
  tritan: { done: '#26c6a6', failed: '#f06292', warn: '#ffe082', hidden: '#7a8ea3', base: '#cfe8ff' },
};

export function paletteFor(mode) {
  return HUD_PALETTES[mode] || HUD_PALETTES.normal;
}

export class MissionHud {
  constructor(doc) {
    this.doc = doc;
    const root = doc.getElementById('hud');
    this.root = null;

    this.box = doc.createElement('div');
    this.box.id = 'hud-objectives';
    this.title = doc.createElement('div');
    this.title.id = 'hud-obj-title';
    this.title.textContent = 'MISSION';
    this.lines = [];
    for (let i = 0; i < 6; i++) {
      const el = doc.createElement('div');
      el.className = 'hud-obj-line';
      this.box.appendChild(el);
      this.lines.push(el);
    }
    this.box.insertBefore(this.title, this.box.firstChild);

    this.protectedWrap = doc.createElement('div');
    this.protectedWrap.id = 'hud-protected';
    this.protectedLabel = doc.createElement('span');
    this.protectedLabel.textContent = 'KESTREL-4';
    this.protectedBarOuter = doc.createElement('span');
    this.protectedBarOuter.id = 'hud-protected-bar';
    this.protectedBar = doc.createElement('span');
    this.protectedBar.id = 'hud-protected-fill';
    this.protectedBarOuter.appendChild(this.protectedBar);
    this.protectedWrap.appendChild(this.protectedLabel);
    this.protectedWrap.appendChild(this.protectedBarOuter);

    this.cruise = doc.createElement('div');
    this.cruise.id = 'hud-cruise';
    this.cruise.textContent = '!! CRUISE MISSILE - RIG UNDER FIRE !!';

    // Phase 4 (Task 4.7): subtitle line for radio chatter (settings.subtitles).
    this.subtitleEl = doc.createElement('div');
    this.subtitleEl.id = 'hud-subtitle';
    this.subtitleEl.style.display = 'none';

    if (root) {
      root.appendChild(this.box);
      root.appendChild(this.protectedWrap);
      root.appendChild(this.cruise);
      root.appendChild(this.subtitleEl);
      this.root = root;
    }

    this._nextUpdate = 0;
    this._out = { text: '' };       // reused formatter out-param (no allocation)
    this._extras = { px: 0, pz: 0, reconDist: -1, protectedHpFrac: 1 };
    this.bannerTimer = 0;
    this.subtitleTimer = 0;
    this.mission = null;
    this.palette = HUD_PALETTES.normal;   // Task 4.7: colorblind palette
    this.reducedMotion = false;           // Task 4.7: no blink / gentler FX
  }

  // Task 4.7: colorblind HUD palette ('normal' | 'protan' | 'deutan' | 'tritan').
  setPalette(mode) { this.palette = paletteFor(mode); }

  show() {
    this.box.style.display = 'block';
  }

  hide() {
    this.box.style.display = 'none';
    this.protectedWrap.style.display = 'none';
    this.cruise.style.display = 'none';
    this.subtitleEl.style.display = 'none';
    this.subtitleTimer = 0;
    this.mission = null;
  }

  // Task 4.7: radio chatter subtitle (main calls this when settings.subtitles is on).
  subtitle(text) {
    this.subtitleEl.textContent = '> ' + text;
    this.subtitleEl.style.display = 'block';
    this.subtitleTimer = 3.0;   // seconds of visibility (tick down in update())
  }

  // Stage banner (Task 2.8) - reuses the existing #hud-banner element, timed here.
  banner(text, doc) {
    const el = (doc || this.doc).getElementById('hud-banner');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    this.bannerTimer = 2.8;
  }

  // 4 Hz throttled refresh; called from the render path with the mission + recon distance.
  update(nowMs, mission, reconDist, protectedHpFrac) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= 0.016;
      if (this.bannerTimer <= 0) {
        const el = this.doc.getElementById('hud-banner');
        if (el) el.hidden = true;
      }
    }
    if (!mission || !mission.stage) return;
    if (nowMs < this._nextUpdate) return;
    this._nextUpdate = nowMs + 250;
    this.mission = mission;

    // Task 4.7: subtitle expiry (frames between 4 Hz updates are fine at 0.25 s)
    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= 0.25;
      if (this.subtitleTimer <= 0) this.subtitleEl.style.display = 'none';
    }

    const pal = this.palette;
    const dag = mission.stage.dag;
    this.title.textContent = mission.def.title + '  -  stage ' +
      (mission.stageIndex + 1) + '/' + mission.def.stages.length;
    const n = Math.min(dag.n, this.lines.length);
    for (let i = 0; i < this.lines.length; i++) {
      const el = this.lines[i];
      if (i < n) {
        this._extras.px = mission.ents.pos[mission.playerId * 3];
        this._extras.pz = mission.ents.pos[mission.playerId * 3 + 2];
        this._extras.reconDist = reconDist !== undefined ? reconDist : -1;
        this._extras.protectedHpFrac = protectedHpFrac !== undefined ? protectedHpFrac : 1;
        formatObjectiveLine(dag, i, this._out, this._extras);
        el.textContent = this._out.text;
        el.style.display = 'block';
        el.style.color = dag.state[i] === 2 ? pal.done
          : dag.state[i] === 3 ? pal.failed
            : dag.state[i] === 0 ? pal.hidden : pal.base;
      } else {
        el.style.display = 'none';
      }
    }

    // protected asset HP bar (only when a protected group exists)
    let showProtected = false;
    for (let g = 0; g < mission.spawner.protectedIds.length; g++) {
      const pid = mission.spawner.protectedIds[g];
      if (mission.ents.isAlive(pid)) {
        showProtected = true;
        const frac = Math.max(0, mission.ents.health[pid] / mission.ents.maxHealth[pid]);
        this.protectedBar.style.width = (frac * 100).toFixed(0) + '%';
        this.protectedBar.style.background =
          frac > 0.5 ? pal.done : frac > 0.25 ? pal.warn : pal.failed;
        break;
      }
    }
    this.protectedWrap.style.display = showProtected ? 'block' : 'none';

    // cruise missile warning (Task 2.8) - blink via visibility toggle
    // (Task 4.7: reduced motion keeps it solid - no flashing)
    const warn = mission.spawner.cruiseWarn;
    this.cruise.style.display = warn ? 'block' : 'none';
    if (warn) {
      this.cruise.style.opacity =
        (this.reducedMotion || (nowMs % 600) < 300) ? '1' : '0.25';
    }
  }
}
