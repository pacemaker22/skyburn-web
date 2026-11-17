// Skyburn Phase 2 - Debrief screen (Task 2.6): shown when the mission FSM reaches
// SUCCESS/FAILED. Displays the mission results(); CONTINUE persists the save (progress,
// unlocks, results; Task 2.6 "save IndexedDB after debrief") and returns to the menu.
// RETRY (offered on failure, always for Ace) restarts the whole mission (Task 2.7).

export class DebriefScreen {
  constructor(doc, opts) {
    this.doc = doc;
    this.opts = opts || {};
    const el = doc.createElement('div');
    el.id = 'screen-debrief';
    el.className = 'skyburn-screen';
    el.hidden = true;
    el.innerHTML =
      '<div class="sb-panel">' +
      '  <div id="db-kicker" class="sb-kicker">DEBRIEF</div>' +
      '  <h1 id="db-title">---</h1>' +
      '  <div id="db-verdict" class="sb-verdict">---</div>' +
      '  <div id="db-stats" class="sb-meta">---</div>' +
      '  <p id="db-note" class="sb-text"></p>' +
      '  <div class="sb-row">' +
      '    <button id="db-continue" class="sb-btn primary">CONTINUE</button>' +
      '    <button id="db-retry" class="sb-btn">RETRY MISSION</button>' +
      '  </div>' +
      '</div>';
    doc.body.appendChild(el);
    this.el = el;
    el.querySelector('#db-continue').addEventListener('click', () => {
      if (this.opts.onContinue) this.opts.onContinue(this.result);
    });
    el.querySelector('#db-retry').addEventListener('click', () => {
      if (this.opts.onRetry) this.opts.onRetry(this.result);
    });
    this.result = null;
  }

  show(result) {
    this.result = result;
    const q = (sel) => this.el.querySelector(sel);
    q('#db-title').textContent = result.title.toUpperCase();
    q('#db-verdict').textContent = result.success ? 'MISSION SUCCESS' : 'MISSION FAILED';
    q('#db-verdict').style.color = result.success ? '#7fd67f' : '#ff6b6b';
    q('#db-stats').textContent =
      'score ' + result.score +
      '  |  kills ' + result.kills +
      '  |  time ' + result.timeSec.toFixed(0) + ' s' +
      '  |  difficulty ' + ['ROOKIE', 'VETERAN', 'ACE'][result.difficulty] +
      (result.restores ? '  |  checkpoints used ' + result.restores : '');
    // Task 3B.3: Ace Bonus debrief line (PRD: earned bonuses surface here, not in the HUD)
    const note = q('#db-note');
    if (result.aceBonuses && result.aceBonuses.length > 0) {
      const earned = result.aceBonuses.filter((b) => b.earned);
      note.textContent = 'ACE BONUS ' + earned.length + '/' + result.aceBonuses.length +
        (earned.length ? ' earned: ' + earned.map((b) => b.desc).join('  |  ')
          : ' - none earned this run');
      note.style.color = earned.length ? '#ffd54f' : '#7a8ea3';
    } else {
      note.textContent = '';
    }
    const retry = q('#db-retry');
    retry.style.display = result.success ? 'none' : 'inline-block';
    this.el.hidden = false;
  }

  hide() { this.el.hidden = true; }
}
