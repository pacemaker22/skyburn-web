// Skyburn Phase 3A - Hangar screen (Task 3A.4): grid of all jets, stat bars, loadout,
// head-to-head compare, and credit unlocks. Economy helpers are pure + exported so the
// buy/unlock contract is testable headlessly (the DOM screen mirrors briefing.js's
// build-once/show-hide pattern; the Game FSM stays in main.js).

import jetsJson from '../data/jets.json' with { type: 'json' };

// ---------------------------------------------------------------- pure economy helpers

export function jetOwned(saveData, jetId) {
  return !!(saveData && saveData.ownedJets && saveData.ownedJets.indexOf(jetId) >= 0);
}

// Attempt to buy a jet with saved credits. Mutates saveData on success and returns
// { ok: true, credits, ownedJets }; on failure returns { ok: false, reason } untouched.
export function buyJet(saveData, jet) {
  if (!saveData || !jet) return { ok: false, reason: 'bad-args' };
  if (jetOwned(saveData, jet.id)) return { ok: false, reason: 'already-owned' };
  const credits = saveData.credits || 0;
  if (credits < jet.price) return { ok: false, reason: 'insufficient-credits' };
  saveData.credits = credits - jet.price;
  saveData.ownedJets.push(jet.id);
  return { ok: true, credits: saveData.credits, ownedJets: saveData.ownedJets.slice() };
}

// Credits awarded by the debrief (Task 3A.4 + 3B.3): full reward + 200 per earned Ace
// Bonus + 10% of score on a win; 100 per earned Ace Bonus + a 5%-of-score consolation on
// a loss (keeps grinding possible without trivializing).
export function creditsForRun(missionDef, res) {
  if (!res) return 0;
  const ace = res.aceCount || 0;
  if (res.success) {
    return Math.round((missionDef ? missionDef.reward : 0) + ace * 200 + res.score * 0.1);
  }
  return Math.round(ace * 100 + res.score * 0.05);
}

// Stat rows for the detail panel: [label, formatted, bar 0..1]. Bounds chosen so every
// roster jet lands in a useful visual range (SR-71 tops speed, MiG-31 tops radar...).
const STAT_DEFS = [
  ['Top speed', (j) => j.maxSpeed, 4100, (v) => v + ' km/h'],
  ['Thrust', (j) => j.thrust, 320000, (v) => Math.round(v / 1000) + ' kN'],
  ['Turn rate', (j) => j.turnRate, 25, (v) => v.toFixed(1) + '\u00B0/s'],
  ['Radar', (j) => j.radarRange, 16000, (v) => Math.round(v / 1000) + ' km'],
  ['Stealth', (j) => 1 - j.stealthFactor, 1, (v) => Math.round(v * 100) + '%'],
  ['Armor', (j) => j.armor || 1, 2, (v) => v.toFixed(1) + 'x'],
  ['Hardpoints', (j) => j.hardpoints, 14, (v) => String(v)],
  ['Flares', (j) => j.flareCount, 130, (v) => String(v)],
];

export function statRows(jet) {
  const rows = [];
  for (let i = 0; i < STAT_DEFS.length; i++) {
    const def = STAT_DEFS[i];
    const v = def[1](jet);
    rows.push([def[0], def[3](v), Math.max(0, Math.min(1, v / def[2]))]);
  }
  return rows;
}

// Head-to-head rows for the compare panel: { label, a, b, better } (better = 'a'|'b'|'eq').
// Higher is better for every stat; price compares the other way.
export function compareRows(a, b) {
  const rows = [];
  for (let i = 0; i < STAT_DEFS.length; i++) {
    const def = STAT_DEFS[i];
    const av = def[1](a), bv = def[1](b);
    rows.push({
      label: def[0], a: def[3](av), b: def[3](bv),
      better: av > bv ? 'a' : (bv > av ? 'b' : 'eq'),
    });
  }
  const ap = a.price, bp = b.price;
  rows.push({
    label: 'Price', a: ap + ' cr', b: bp + ' cr',
    better: ap < bp ? 'a' : (bp < ap ? 'b' : 'eq'),
  });
  return rows;
}

// ---------------------------------------------------------------- the screen

export class HangarScreen {
  constructor(document, opts) {
    this.doc = document;
    this.opts = opts || {};
    this.jets = this.opts.jets || [];
    this.weaponNames = this.opts.weaponNames || {};
    this.selected = null;      // currently flying jet
    this.compare = [];         // up to 2 jet ids for the head-to-head panel
    this.el = document.createElement('div');
    this.el.id = 'screen-hangar';
    this.el.className = 'skyburn-screen';
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  weaponLabel(id) { return this.weaponNames[id] || id; }

  loadoutLabel(jet) {
    if (!jet.loadout || jet.loadout.length === 0) return 'UNARMED (recon airframe)';
    return jet.loadout.map((w) => this.weaponLabel(w)).join(' + ');
  }

  show(selectedJet) {
    this.selected = selectedJet;
    this.render();
    this.el.hidden = false;
  }

  hide() { this.el.hidden = true; }

  render() {
    const doc = this.doc;
    const saveData = this.opts.getSave ? this.opts.getSave() : { credits: 0, ownedJets: [] };
    const d = (id) => this.el.querySelector('#' + id);
    this.el.innerHTML =
      '<div class="sb-panel sb-hangar">' +
      '<div class="sb-kicker">HANGAR</div>' +
      '<h1>SELECT AIRCRAFT</h1>' +
      '<div class="sb-meta">Credits <b id="hg-credits"></b> - owned ' +
      '<b id="hg-owned"></b></div>' +
      '<div class="sb-hangar-grid">' +
      '  <div class="sb-hangar-list" id="hg-list"></div>' +
      '  <div class="sb-hangar-detail" id="hg-detail"></div>' +
      '</div>' +
      '<div id="hg-compare" class="sb-compare" hidden></div>' +
      '<div class="sb-row">' +
      '  <button id="hg-back" class="sb-btn">BACK</button>' +
      '</div>' +
      '</div>';

    d('hg-credits').textContent = String(saveData.credits || 0);
    d('hg-owned').textContent = String(
      this.jets.filter((j) => jetOwned(saveData, j.id)).length);

    // ---- jet grid grouped by tier ----
    const list = d('hg-list');
    for (let tier = 1; tier <= 5; tier++) {
      const tierJets = this.jets.filter((j) => j.tier === tier);
      if (tierJets.length === 0) continue;
      const head = doc.createElement('div');
      head.className = 'sb-tier-head';
      head.textContent = 'TIER ' + tier;
      list.appendChild(head);
      for (const jet of tierJets) {
        list.appendChild(this.jetCard(saveData, jet));
      }
    }

    this.renderDetail(saveData);
    this.renderCompare(saveData);
    d('hg-back').addEventListener('click', () => {
      if (this.opts.onBack) this.opts.onBack();
    });
  }

  jetCard(saveData, jet) {
    const owned = jetOwned(saveData, jet.id);
    const card = this.doc.createElement('button');
    card.className = 'sb-jet-card' +
      (jet === this.selected ? ' selected' : '') +
      (owned ? '' : ' locked');
    card.id = 'hg-jet-' + jet.id;
    card.innerHTML =
      '<span class="hg-dot" style="background:' + cssColor(jet.paint) + '"></span>' +
      '<span class="hg-name">' + jet.name + '</span>' +
      '<span class="hg-meta">' + jet.country + ' | ' + jet.price + ' cr' +
      (owned ? '' : ' | LOCKED') + '</span>';
    card.addEventListener('click', () => {
      this.selected = jet;
      if (this.opts.onSelect) this.opts.onSelect(jet);
      this.render();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.toggleCompare(jet.id);
    });
    return card;
  }

  renderDetail(saveData) {
    const jet = this.selected || this.jets[0];
    const owned = jetOwned(saveData, jet.id);
    const rows = statRows(jet);
    let detail =
      '<div class="sb-hangar-jetname">' + jet.name + '</div>' +
      '<div class="sb-meta">' + jet.country + ' | tier ' + jet.tier +
      (jet.armor && jet.armor > 1 ? ' | armored' : '') +
      (jet.hardpoints === 0 ? ' | unarmed' : '') + '</div>' +
      '<div class="sb-stats">';
    for (const r of rows) {
      detail += '<div class="sb-stat"><span>' + r[0] + '</span>' +
        '<div class="sb-statbar"><div style="width:' + Math.round(r[2] * 100) + '%"></div></div>' +
        '<em>' + r[1] + '</em></div>';
    }
    detail += '</div>' +
      '<div class="sb-sub">LOADOUT</div>' +
      '<div class="sb-meta">' + this.loadoutLabel(jet) + '</div>' +
      '<div class="sb-meta sb-dim">left-click select | right-click compare</div>';
    if (owned) {
      detail += '<div class="sb-tag owned">OWNED</div>';
    } else {
      detail += '<button id="hg-buy" class="sb-btn">BUY - ' + jet.price + ' cr</button>';
    }
    this.el.querySelector('#hg-detail').innerHTML = detail;

    const buyBtn = this.el.querySelector('#hg-buy');
    if (buyBtn) {
      buyBtn.addEventListener('click', () => {
        const res = buyJet(saveData, jet);
        if (!res.ok && this.opts.onBuyFail) this.opts.onBuyFail(res.reason, jet);
        if (res.ok && this.opts.onBuy) this.opts.onBuy(jet);
        this.render();
      });
    }
  }

  toggleCompare(jetId) {
    const at = this.compare.indexOf(jetId);
    if (at >= 0) this.compare.splice(at, 1);
    else {
      if (this.compare.length >= 2) this.compare.shift();
      this.compare.push(jetId);
    }
    this.render();
  }

  renderCompare() {
    const box = this.el.querySelector('#hg-compare');
    if (this.compare.length < 2) { box.hidden = true; return; }
    const a = this.jets.find((j) => j.id === this.compare[0]);
    const b = this.jets.find((j) => j.id === this.compare[1]);
    if (!a || !b) { box.hidden = true; return; }
    const rows = compareRows(a, b);
    let html =
      '<div class="sb-kicker">HEAD TO HEAD</div><table class="sb-cmp"><tr>' +
      '<th>' + a.name + '</th><th></th><th>' + b.name + '</th></tr>';
    for (const r of rows) {
      html += '<tr><td class="' + (r.better === 'a' ? 'win' : '') + '">' + r.a + '</td>' +
        '<td>' + r.label + '</td>' +
        '<td class="' + (r.better === 'b' ? 'win' : '') + '">' + r.b + '</td></tr>';
    }
    box.innerHTML = html + '</table>';
    box.hidden = false;
  }
}

function cssColor(rgb) {
  if (!rgb || rgb.length < 3) return '#888';
  const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return 'rgb(' + c(rgb[0]) + ',' + c(rgb[1]) + ',' + c(rgb[2]) + ')';
}
