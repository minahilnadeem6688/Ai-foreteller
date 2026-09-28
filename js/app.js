/* AI Foreteller: the board, the turns, and the panel that shows what the search sees. */
(function () {
  'use strict';

  const { COLS, ROWS, SIZE, NEAR_WIN, Position, Searcher, pliesToEnd } = window.Foreteller;

  const LEVELS = {
    apprentice: { maxDepth: 2, noise: 10, timeMs: 600 },
    seer: { maxDepth: 8, timeMs: 3000 },
    oracle: { timeMs: 2200 },
  };
  const HINT = { timeMs: 1200 };
  const MIN_THINK_MS = 450; // so an instant reply still reads as a move, not a glitch

  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const els = {
    turn: $('turnLabel'), verdict: $('verdict'), fsLabel: $('foresightLabel'), fsCols: $('foresightCols'),
    result: $('result'), resultTitle: $('resultTitle'), resultText: $('resultText'),
    hint: $('hint'), undo: $('undo'), showLine: $('showLine'),
    sub: $('readingSub'), depth: $('stDepth'), nodes: $('stNodes'), cuts: $('stCuts'), hits: $('stHits'),
    cmpFull: $('cmpFull'), cmpAb: $('cmpAb'), barFull: $('barFull'), barAb: $('barAb'), cmpNote: $('cmpNote'),
    depths: $('depths'),
  };

  const store = {
    get(k, d) { try { return localStorage.getItem('foreteller.' + k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('foreteller.' + k, v); } catch { /* private mode */ } },
  };

  let pos = new Position();
  let level = store.get('level', 'seer');
  let starter = store.get('start', 'you');
  let you = 1; // 1 moves first
  let busy = false;
  let over = false;
  let game = 0; // bumps on every new game so late search results are ignored
  let line = []; // expected line of play to draw on the board
  let lineFrom = 0; // who plays line[0]

  /* ---------- search, in a worker when the browser allows it ---------- */

  let worker = null;
  let fallback = null;
  let pending = null;
  let nextId = 0;

  function startWorker() {
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const m = e.data;
        if (!pending || m.id !== pending.id) return;
        if (m.type === 'depth') pending.onDepth(m.result);
        else { const p = pending; pending = null; p.resolve(m.result); }
      };
      worker.onerror = () => { // e.g. opened from a file:// URL
        worker = null;
        if (pending) { const p = pending; pending = null; runHere(p); }
      };
    } catch {
      worker = null;
    }
  }

  function runHere(p) {
    fallback = fallback || new Searcher();
    setTimeout(() => p.resolve(fallback.search(Position.from(p.moves), { ...p.options, onDepth: p.onDepth })), 30);
  }

  function search(options, onDepth) {
    return new Promise((resolve) => {
      const p = { id: ++nextId, moves: pos.history.slice(), options, onDepth, resolve };
      if (worker) { pending = p; worker.postMessage({ type: 'search', id: p.id, moves: p.moves, options }); }
      else runHere(p);
    });
  }

  function cancelSearch() {
    if (worker && pending) { worker.terminate(); pending = null; startWorker(); }
  }

  /* ---------- board ---------- */

  const cellEls = []; // [col][row]
  const colEls = [];

  function buildBoard() {
    for (let c = 0; c < COLS; c++) {
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'col';
      col.dataset.col = c;
      col.addEventListener('click', () => humanMove(c));
      cellEls[c] = [];
      for (let r = 0; r < ROWS; r++) {
        const cell = document.createElement('span');
        cell.className = 'cell';
        cell.innerHTML = '<i class="disc"></i>';
        col.appendChild(cell);
        cellEls[c][r] = cell;
      }
      boardEl.appendChild(col);
      colEls[c] = col;

      const fs = document.createElement('div');
      fs.className = 'fs';
      fs.innerHTML = '<span class="fs__bar"><i></i></span><span class="fs__val mono"></span>';
      els.fsCols.appendChild(fs);
    }
  }

  const sideClass = (who) => (who === you ? 'is-you' : 'is-ai');

  function renderBoard(dropped) {
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const cell = cellEls[c][r];
        const v = pos.cells[c * ROWS + r];
        cell.className = 'cell' + (v ? ' ' + sideClass(v) : '');
        if (dropped && dropped[0] === c && dropped[1] === r) {
          cell.classList.add('is-new');
          cell.style.setProperty('--fall', ROWS - r);
        }
        delete cell.dataset.n;
      }
      const free = ROWS - pos.heights[c];
      colEls[c].disabled = free === 0;
      colEls[c].setAttribute('aria-label', `Column ${c + 1}, ${free ? free + ' free' : 'full'}`);
      if (free) cellEls[c][pos.heights[c]].classList.add('is-next');
    }
    renderLine();
  }

  // Numbered ghost discs for the moves the search expects next.
  function renderLine() {
    boardEl.querySelectorAll('.ghost-you, .ghost-ai, [data-n]').forEach((el) => {
      el.classList.remove('ghost-you', 'ghost-ai');
      delete el.dataset.n;
    });
    if (!els.showLine.checked || over || !line.length) return;
    const h = Array.from(pos.heights);
    let who = lineFrom;
    line.forEach((c, i) => {
      if (h[c] >= ROWS) return;
      const cell = cellEls[c][h[c]++];
      cell.classList.add(who === you ? 'ghost-you' : 'ghost-ai');
      cell.dataset.n = i + 1;
      who = 3 - who;
    });
  }

  function setTurn(thinking) {
    els.turn.innerHTML = thinking
      ? '<i class="dot dot--ai is-pulse"></i><span>The Foreteller is reading the board</span>'
      : over ? '<i class="dot dot--done"></i><span>Game over</span>'
      : '<i class="dot dot--you"></i><span>Your move</span>';
    document.body.classList.toggle('is-thinking', !!thinking);
    els.hint.disabled = !!thinking || over || pos.turn !== you;
    els.undo.disabled = !!thinking || !pos.history.some((_, i) => (i % 2) + 1 === you);
  }

  /* ---------- numbers and words ---------- */

  const fmt = (n) => (n >= 1e15 ? n.toExponential(1).replace('e+', 'e') : n >= 1e12 ? (n / 1e12).toFixed(1) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString('en'));
  const words = (n) => (n >= 1e15 ? '10^' + Math.floor(Math.log10(n)) : n >= 1e12 ? (n / 1e12).toFixed(1) + ' trillion' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : fmt(n));
  const ahead = (d) => `${d} move${d === 1 ? '' : 's'} ahead`;
  const movesIn = (score) => Math.ceil(pliesToEnd(score) / 2);

  function scoreText(s) {
    if (s === null) return 'full';
    if (s > NEAR_WIN) return 'win ' + movesIn(s);
    if (s < -NEAR_WIN) return 'loss ' + movesIn(s);
    return (s > 0 ? '+' : '') + s;
  }

  // Foresight row: each column's score for whoever was searching, as a bar above or below the midline.
  function renderForesight(r, forYou) {
    els.fsLabel.textContent = forYou ? 'Foresight · your columns' : 'Foresight · its columns';
    els.fsCols.classList.toggle('for-you', forYou);
    Array.from(els.fsCols.children).forEach((el, c) => {
      const s = r ? r.scores[c] : null;
      const bar = el.querySelector('.fs__bar i');
      el.className = 'fs' + (r && c === r.move ? ' is-best' : '') + (s === null ? ' is-empty' : '');
      if (!r || s === null) { bar.style.cssText = ''; el.querySelector('.fs__val').textContent = r ? 'full' : ''; return; }
      const v = s > NEAR_WIN ? 1 : s < -NEAR_WIN ? -1 : Math.tanh(s / 14);
      bar.style.setProperty('--v', Math.abs(v).toFixed(3));
      el.classList.add(v >= 0 ? 'is-up' : 'is-down');
      el.querySelector('.fs__val').textContent = scoreText(s);
    });
  }

  function renderReading(r, legal) {
    els.depth.textContent = r.depth;
    els.depth.nextElementSibling.textContent = r.depth === 1 ? ' move' : ' moves';
    els.nodes.textContent = fmt(r.nodes);
    els.cuts.textContent = fmt(r.cutoffs);
    els.hits.textContent = fmt(r.hits);
    // A plain minimax visits every branch: up to b + b^2 + ... + b^d positions for b legal moves.
    let full = 0;
    for (let k = 1, p = 1; k <= r.depth; k++) { p *= legal; full += p; }
    full = Math.max(full, r.nodes);
    const scale = Math.log10(full + 1);
    els.cmpFull.textContent = 'up to ' + fmt(full);
    els.cmpAb.textContent = fmt(r.nodes);
    els.barFull.style.width = '100%';
    els.barAb.style.width = Math.max(2, (Math.log10(r.nodes + 1) / scale) * 100).toFixed(1) + '%';
    const share = (r.nodes / full) * 100;
    els.cmpNote.textContent = r.depth < 3
      ? 'Positions visited at the same depth, on a log scale.'
      : `Looking ${r.depth} moves ahead, a plain minimax could visit up to ${words(full)} positions. Alpha-beta needed ${share < 0.01 ? 'under 0.01' : share < 1 ? share.toFixed(2) : share.toFixed(1)}% of that.`;
  }

  function addDepthRow(r) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${String(r.depth).padStart(2, '0')}</span><span>col ${r.move + 1}</span><span>${scoreText(r.score)}</span><span>${fmt(r.nodes)}</span><span>${r.ms} ms</span>`;
    els.depths.prepend(li);
    while (els.depths.children.length > 14) els.depths.lastChild.remove();
  }

  function resetReading(text) {
    els.sub.textContent = text;
    els.depths.innerHTML = '';
  }

  /* ---------- turns ---------- */

  function place(c) {
    const r = pos.play(c);
    const win = pos.winningCells(c, r);
    renderBoard([c, r]);
    if (win) return finish(pos.cells[c * ROWS + r], win);
    if (pos.moves === SIZE) return finish(0);
    return false;
  }

  function finish(winner, cells) {
    over = true;
    line = [];
    renderLine();
    if (cells) {
      boardEl.classList.add('is-over');
      cells.forEach(([c, r]) => cellEls[c][r].classList.add('is-win'));
    }
    const aiMoves = pos.history.filter((_, i) => (i % 2) + 1 !== you).length;
    els.resultTitle.textContent = winner === you ? 'You changed the future.' : winner ? 'As foretold.' : 'A draw.';
    els.resultText.textContent = winner === you
      ? `Four in a row against the ${level[0].toUpperCase() + level.slice(1)}. Try a harder level next.`
      : winner ? `The Foreteller connected four in ${aiMoves} moves.` : 'The board filled with no four in a row.';
    els.verdict.textContent = winner === you ? 'You won.' : winner ? 'The Foreteller won.' : 'Nobody won this one.';
    setTimeout(() => { if (over) els.result.hidden = false; }, 700);
    setTurn(false);
    return true;
  }

  function humanMove(c) {
    if (busy || over || pos.turn !== you || !pos.canPlay(c)) return;
    line = [];
    if (place(c)) return;
    aiMove();
  }

  async function aiMove() {
    const g = game;
    busy = true;
    setTurn(true);
    resetReading('Thinking · ' + level);
    const legal = pos.legalMoves().length;
    const started = performance.now();
    const r = await search(LEVELS[level], (d) => {
      if (g !== game) return;
      addDepthRow(d);
      renderReading(d, legal);
    });
    const wait = MIN_THINK_MS - (performance.now() - started);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (g !== game) return;

    busy = false;
    renderReading(r, legal);
    renderForesight(r, false);
    els.sub.textContent = `Last move · ${ahead(r.depth)} · ${r.ms} ms`;
    const ended = place(r.move);
    if (!ended) {
      line = r.line.slice(1);
      lineFrom = you;
      renderLine();
      els.verdict.textContent = aiVerdict(r);
    }
    setTurn(false);
  }

  function aiVerdict(r) {
    const s = r.score;
    const c = `It played column ${r.move + 1}. `;
    if (s > NEAR_WIN) {
      const n = movesIn(s) - 1;
      return c + `It sees a forced win in ${n} more move${n === 1 ? '' : 's'}, whatever you play.`;
    }
    if (s < -NEAR_WIN) return c + `It sees a win for you in ${movesIn(s)} moves. Can you find it?`;
    if (s > 30) return c + 'It thinks it is well ahead.';
    if (s > 6) return c + 'It thinks it has a slight edge.';
    if (s < -30) return c + 'It thinks you are well ahead.';
    if (s < -6) return c + 'It thinks you have a slight edge.';
    return c + 'It sees an even game.';
  }

  async function hint() {
    if (busy || over || pos.turn !== you) return;
    const g = game;
    busy = true;
    setTurn(false);
    els.hint.disabled = true;
    resetReading('Reading your future');
    const legal = pos.legalMoves().length;
    const r = await search(HINT, (d) => { if (g === game) { addDepthRow(d); renderReading(d, legal); } });
    if (g !== game) return;
    busy = false;
    renderReading(r, legal);
    renderForesight(r, true);
    els.sub.textContent = `Your position · ${ahead(r.depth)} · ${r.ms} ms`;
    line = r.line;
    lineFrom = you;
    renderLine();
    const s = r.score;
    const col = `column ${r.move + 1}`;
    els.verdict.textContent = s > NEAR_WIN ? `You have a forced win in ${movesIn(s)} moves. It starts with ${col}.`
      : s < -NEAR_WIN ? `It can force a win in ${movesIn(s)} moves. ${col[0].toUpperCase() + col.slice(1)} holds out longest.`
      : `Your strongest move looks like ${col}.`;
    setTurn(false);
  }

  function undo() {
    if (busy || !pos.history.length) return;
    do pos.undo(); while (pos.moves > 0 && pos.turn !== you);
    if (pos.turn !== you) return newGame(); // only the Foreteller's opening move was left
    reopen();
    els.verdict.textContent = 'Move taken back. Your turn again.';
  }

  function reopen() {
    over = false;
    line = [];
    els.result.hidden = true;
    boardEl.classList.remove('is-over');
    renderBoard();
    renderForesight(null, false);
    setTurn(false);
  }

  function newGame() {
    cancelSearch();
    game++;
    busy = false;
    pos = new Position();
    you = starter === 'you' ? 1 : 2;
    reopen();
    resetReading('Waiting for the first search');
    ['depth', 'nodes', 'cuts', 'hits', 'cmpAb'].forEach((k) => (els[k].textContent = '0'));
    els.cmpFull.textContent = '0';
    els.barFull.style.width = els.barAb.style.width = '0';
    els.cmpNote.textContent = 'Positions visited at the same depth, on a log scale.';
    els.verdict.textContent = 'Drop a disc in any column. Four in a row wins.';
    if (you === 2) aiMove();
  }

  /* ---------- controls ---------- */

  function bindSeg(id, attr, get, set) {
    const btns = document.querySelectorAll(`#${id} button`);
    const paint = () => btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === get())));
    btns.forEach((b) => b.addEventListener('click', () => { set(b.dataset[attr]); paint(); }));
    paint();
  }

  bindSeg('levels', 'level', () => level, (v) => { level = v; store.set('level', v); });
  bindSeg('starters', 'start', () => starter, (v) => { if (v !== starter) { starter = v; store.set('start', v); newGame(); } });
  $('newGame').addEventListener('click', newGame);
  $('again').addEventListener('click', newGame);
  els.hint.addEventListener('click', hint);
  els.undo.addEventListener('click', undo);
  els.showLine.addEventListener('change', renderLine);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= COLS) humanMove(n - 1);
  });

  startWorker();
  buildBoard();
  newGame();
})();
