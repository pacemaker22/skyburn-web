// Skyburn Phase 2 - Briefing screen (Task 2.6): the MENU->HANGAR->BRIEFING->LOADING->PLAYING
// flow lands here. Builds its own overlay once; show()/hide() toggle it. Pure DOM, no game
// logic - the Game FSM lives in main.js. LAUNCH fires opts.onLaunch(), BACK fires onBack().

export class BriefingScreen {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts || {};
    const el = doc.createElement('div');
    el.id = 'screen-briefing';
    el.className = 'skyburn-screen';
    el.hidden = true;
    el.innerHTML =
      '<div class="sb-panel">' +
      '  <div class="sb-kicker">MISSION BRIEFING</div>' +
      '  <h1 id="bf-title">---</h1>' +
      '  <div id="bf-meta" class="sb-meta">---</div>' +
      '  <p id="bf-text" class="sb-text">---</p>' +
      '  <div class="sb-sub">OBJECTIVES</div>' +
      '  <ul id="bf-objectives" class="sb-list"></ul>' +
      '  <div class="sb-sub">LOADOUT</div>' +
      '  <div id="bf-loadout" class="sb-meta">---</div>' +
      '  <div class="sb-row">' +
      '    <button id="bf-launch" class="sb-btn primary">LAUNCH</button>' +
      '    <button id="bf-back" class="sb-btn">BACK</button>' +
      '  </div>' +
      '</div>';
    doc.body.appendChild(el);
    this.el = el;
    this.launchBtn = el.querySelector('#bf-launch');
    this.backBtn = el.querySelector('#bf-back');
    this.launchBtn.addEventListener('click', () => {
      if (this.opts.onLaunch) this.opts.onLaunch(this.current);
    });
    this.backBtn.addEventListener('click', () => {
      if (this.opts.onBack) this.opts.onBack();
    });
    this.current = null;
  }

  // def: missions.json entry; mapName; difficulty label; jetName.
  show(def, mapName, difficultyLabel, jetLabel) {
    this.current = def;
    const q = (sel) => this.el.querySelector(sel);
    q('#bf-title').textContent = def.title.toUpperCase();
    q('#bf-meta').textContent = 'MAP ' + (mapName || def.map).toUpperCase() +
      '  |  DIFFICULTY ' + difficultyLabel + '  |  STAGES ' + def.stages.length +
      '  |  REWARD ' + def.reward +
      (def.recommendedJet ? '  |  AIRCRAFT ' + def.recommendedJet.toUpperCase() : '') +
      (def.aceBonus && def.aceBonus.length
        ? '  |  ACE BONUS x' + def.aceBonus.length + ' (hidden until earned)' : '');
    q('#bf-text').textContent = def.briefing || '';
    const list = q('#bf-objectives');
    list.innerHTML = '';
    for (let s = 0; s < def.stages.length; s++) {
      const stage = def.stages[s];
      for (let o = 0; o < stage.objectives.length; o++) {
        const li = this.doc.createElement('li');
        li.textContent = 'S' + (s + 1) + '  ' + stage.objectives[o].label;
        list.appendChild(li);
      }
    }
    q('#bf-loadout').textContent = jetLabel;
    this.el.hidden = false;
  }

  hide() { this.el.hidden = true; }
}
