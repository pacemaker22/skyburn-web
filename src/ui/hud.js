// Skyburn Phase 2 - HUD v2 widgets (Task 2.8): "objective tracker, stage banner, protected
// HP, cruise missile warning, distance". DOM is built once here (index.html keeps only the
// Phase 0/1 containers); per-frame updates mutate textContent in place at 4 Hz - no
// allocation in the render path. Objective line text comes from the pure formatter in
// mission/objectives.js (unit-tested headlessly).

import { formatObjectiveLine } from '../mission/objectives.js';

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

    if (root) {
      root.appendChild(this.box);
      root.appendChild(this.protectedWrap);
      root.appendChild(this.cruise);
      this.root = root;
    }

    this._nextUpdate = 0;
    this._out = { text: '' };       // reused formatter out-param (no allocation)
    this._extras = { px: 0, pz: 0, reconDist: -1, protectedHpFrac: 1 };
    this.bannerTimer = 0;
    this.mission = null;
  }

  show() {
    this.box.style.display = 'block';
  }

  hide() {
    this.box.style.display = 'none';
    this.protectedWrap.style.display = 'none';
    this.cruise.style.display = 'none';
    this.mission = null;
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
        el.style.color = dag.state[i] === 2 ? '#7fd67f'
          : dag.state[i] === 3 ? '#ff6b6b'
            : dag.state[i] === 0 ? '#7a8ea3' : '#cfe8ff';
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
          frac > 0.5 ? '#7fd67f' : frac > 0.25 ? '#ffd54f' : '#ff6b6b';
        break;
      }
    }
    this.protectedWrap.style.display = showProtected ? 'block' : 'none';

    // cruise missile warning (Task 2.8) - blink via visibility toggle
    const warn = mission.spawner.cruiseWarn;
    this.cruise.style.display = warn ? 'block' : 'none';
    if (warn) this.cruise.style.opacity = (nowMs % 600) < 300 ? '1' : '0.25';
  }
}
