/*
 * AI Foreteller engine: the Connect Four board, how a position is judged, and the search.
 * The same file runs in the page, inside the Web Worker and in Node for the tests.
 */
(function (root) {
  'use strict';

  const COLS = 7;
  const ROWS = 6;
  const SIZE = COLS * ROWS;
  const WIN = 100000; // a win found k plies ahead scores WIN - k, so sooner wins score higher
  const NEAR_WIN = WIN - 1000;
  const INF = 1e9;
  const ORDER = [3, 2, 4, 1, 5, 0, 6]; // centre first: good moves early mean more cut-offs

  const at = (c, r) => c * ROWS + r;
  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

  // Every line of four cells on the board (69 of them), flattened for a fast evaluation loop.
  const LINE_CELLS = (function () {
    const out = [];
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        for (const [dc, dr] of dirs) {
          const ec = c + 3 * dc;
          const er = r + 3 * dr;
          if (ec < 0 || ec >= COLS || er < 0 || er >= ROWS) continue;
          for (let k = 0; k < 4; k++) out.push(at(c + k * dc, r + k * dr));
        }
      }
    }
    return Int8Array.from(out);
  })();

  // Points for a line holding 0..3 of one player's discs and none of the other's.
  const LINE_SCORE = [0, 0, 2, 6];
  const CENTRE_BONUS = 3;

  // Zobrist keys: two 32-bit halves per (cell, player). Seeded, so hashes are the same on every run.
  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) | 0;
    };
  }
  const rand = mulberry32(0x5eed);
  const ZLO = new Int32Array(SIZE * 2);
  const ZHI = new Int32Array(SIZE * 2);
  for (let i = 0; i < SIZE * 2; i++) {
    ZLO[i] = rand();
    ZHI[i] = rand();
  }

  class Position {
    constructor() {
      this.cells = new Int8Array(SIZE); // 0 empty, 1 first player, 2 second player
      this.heights = new Int8Array(COLS);
      this.moves = 0;
      this.lo = 0;
      this.hi = 0;
      this.history = [];
    }

    static from(cols) {
      const p = new Position();
      for (const c of cols) p.play(c);
      return p;
    }

    get turn() {
      return (this.moves & 1) + 1;
    }

    canPlay(c) {
      return c >= 0 && c < COLS && this.heights[c] < ROWS;
    }

    legalMoves() {
      return ORDER.filter((c) => this.heights[c] < ROWS);
    }

    play(c) {
      const who = this.turn;
      const r = this.heights[c]++;
      const i = at(c, r);
      const z = i * 2 + who - 1;
      this.cells[i] = who;
      this.lo ^= ZLO[z];
      this.hi ^= ZHI[z];
      this.moves++;
      this.history.push(c);
      return r;
    }

    undo() {
      const c = this.history.pop();
      const r = --this.heights[c];
      const i = at(c, r);
      this.moves--;
      const z = i * 2 + this.turn - 1;
      this.cells[i] = 0;
      this.lo ^= ZLO[z];
      this.hi ^= ZHI[z];
      return c;
    }

    // Discs of player `who` in a row from (c, r), walking (dc, dr), not counting (c, r) itself.
    run(c, r, dc, dr, who) {
      let n = 0;
      for (let k = 1; k < 4; k++) {
        const x = c + k * dc;
        const y = r + k * dr;
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS || this.cells[at(x, y)] !== who) break;
        n++;
      }
      return n;
    }

    // Would dropping a disc in column c win the game for the side to move?
    wins(c) {
      const r = this.heights[c];
      if (r >= ROWS) return false;
      const who = this.turn;
      return (
        this.run(c, r, 0, -1, who) >= 3 ||
        this.run(c, r, 1, 0, who) + this.run(c, r, -1, 0, who) >= 3 ||
        this.run(c, r, 1, 1, who) + this.run(c, r, -1, -1, who) >= 3 ||
        this.run(c, r, 1, -1, who) + this.run(c, r, -1, 1, who) >= 3
      );
    }

    // The four (or more) cells that make a win through (c, r), or null.
    winningCells(c, r) {
      const who = this.cells[at(c, r)];
      if (!who) return null;
      for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const cells = [[c, r]];
        for (const s of [1, -1]) {
          for (let k = 1; k < 4; k++) {
            const x = c + s * k * dc;
            const y = r + s * k * dr;
            if (x < 0 || x >= COLS || y < 0 || y >= ROWS || this.cells[at(x, y)] !== who) break;
            cells.push([x, y]);
          }
        }
        if (cells.length >= 4) return cells;
      }
      return null;
    }

    // Static judgement from the side to move's point of view: open lines and the centre column.
    evaluate() {
      const me = this.turn;
      const cells = this.cells;
      let s = 0;
      for (let i = 0; i < LINE_CELLS.length; i += 4) {
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = cells[LINE_CELLS[i + k]];
          if (v === me) mine++;
          else if (v) theirs++;
        }
        if (theirs === 0) s += LINE_SCORE[mine];
        else if (mine === 0) s -= LINE_SCORE[theirs];
      }
      for (let r = 0; r < ROWS; r++) {
        const v = cells[at(3, r)];
        if (v === me) s += CENTRE_BONUS;
        else if (v) s -= CENTRE_BONUS;
      }
      return s;
    }
  }

  // Transposition table: positions already searched, found again through a different move order.
  const TT_BITS = 20;
  const TT_SIZE = 1 << TT_BITS;
  const TT_MASK = TT_SIZE - 1;
  const EXACT = 1;
  const LOWER = 2;
  const UPPER = 3;

  // Win scores are stored relative to the node, so they stay right when reached at another depth.
  const toTT = (s, ply) => (s > NEAR_WIN ? s + ply : s < -NEAR_WIN ? s - ply : s);
  const fromTT = (s, ply) => (s > NEAR_WIN ? s - ply : s < -NEAR_WIN ? s + ply : s);

  class Searcher {
    constructor() {
      this.key = new Int32Array(TT_SIZE);
      this.score = new Int32Array(TT_SIZE);
      this.depth = new Int8Array(TT_SIZE);
      this.flag = new Int8Array(TT_SIZE);
      this.best = new Int8Array(TT_SIZE);
      this.age = new Uint8Array(TT_SIZE); // which search wrote the entry
      this.gen = 0;
      this.resetStats();
    }

    clear() {
      this.flag.fill(0);
    }

    resetStats() {
      this.nodes = 0;
      this.cutoffs = 0;
      this.hits = 0;
      this.stopped = false;
    }

    // Negamax with alpha-beta pruning. Returns the score for the side to move.
    negamax(p, depth, alpha, beta, ply) {
      this.nodes++;
      if ((this.nodes & 2047) === 0 && now() > this.deadline) this.stopped = true;
      if (this.stopped) return 0;

      for (let c = 0; c < COLS; c++) if (p.wins(c)) return WIN - ply - 1;
      if (p.moves >= SIZE - 1) return 0; // the last disc can't win (checked above), so a draw
      if (depth === 0) return p.evaluate();

      const alpha0 = alpha;
      const slot = p.lo & TT_MASK;
      let ttMove = -1;
      if (this.flag[slot] && this.key[slot] === p.hi) {
        this.hits++;
        this.age[slot] = this.gen; // still in use, so protect it like a fresh entry
        ttMove = this.best[slot];
        if (this.depth[slot] >= depth) {
          const s = fromTT(this.score[slot], ply);
          const f = this.flag[slot];
          if (f === EXACT) return s;
          if (f === LOWER && s >= beta) return s;
          if (f === UPPER && s <= alpha) return s;
        }
      }

      let best = -INF;
      let bestMove = -1;
      for (let i = -1; i < COLS; i++) {
        const c = i < 0 ? ttMove : ORDER[i];
        if (c < 0 || (i >= 0 && c === ttMove) || !p.canPlay(c)) continue;
        p.play(c);
        const s = -this.negamax(p, depth - 1, -beta, -alpha, ply + 1);
        p.undo();
        if (this.stopped) return 0;
        if (s > best) {
          best = s;
          bestMove = c;
        }
        if (s > alpha) alpha = s;
        if (alpha >= beta) {
          this.cutoffs++;
          break;
        }
      }

      // Keep deeper results from this search: they took the most work and hold the expected line.
      if (this.flag[slot] && this.age[slot] === this.gen && this.key[slot] !== p.hi && this.depth[slot] > depth) return best;
      this.age[slot] = this.gen;
      this.key[slot] = p.hi;
      this.score[slot] = toTT(best, ply);
      this.depth[slot] = depth;
      this.flag[slot] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT;
      this.best[slot] = bestMove;
      return best;
    }

    // The line of play the search expects after `first`, read back from the table.
    // If an entry was overwritten, a short search of its own fills in the next move.
    principalLine(p, first, maxLen) {
      const line = [];
      let played = 0;
      let c = first;
      while (c >= 0 && line.length < maxLen && p.canPlay(c)) {
        line.push(c);
        if (p.wins(c)) break;
        p.play(c);
        played++;
        if (p.moves === SIZE) break;
        const slot = p.lo & TT_MASK;
        c = this.flag[slot] && this.key[slot] === p.hi ? this.best[slot] : this.quickBest(p, Math.min(6, maxLen - line.length));
      }
      while (played--) p.undo();
      return line;
    }

    quickBest(p, depth) {
      const saved = [this.nodes, this.cutoffs, this.hits, this.deadline];
      this.deadline = Infinity;
      let best = -1;
      let bestScore = -INF;
      for (const c of p.legalMoves()) {
        if (p.wins(c)) { best = c; break; }
        p.play(c);
        const s = -this.negamax(p, Math.max(0, depth - 1), -INF, INF, 1);
        p.undo();
        if (s > bestScore) { bestScore = s; best = c; }
      }
      [this.nodes, this.cutoffs, this.hits, this.deadline] = saved;
      return best;
    }

    /*
     * Iterative deepening: search 1 ply ahead, then 2, then 3... until the time or depth limit.
     * Each finished depth is reported through onDepth, and orders the moves for the next one.
     * Every root move gets a full window so the page can show an exact score for each column.
     */
    search(p, { maxDepth = SIZE, timeMs = Infinity, noise = 0, onDepth } = {}) {
      this.resetStats();
      this.gen = (this.gen + 1) & 255;
      const start = now();
      this.deadline = start + timeMs;
      const limit = Math.min(maxDepth, SIZE - p.moves);
      let order = p.legalMoves();
      let result = null;

      for (let d = 1; d <= limit; d++) {
        const scores = new Array(COLS).fill(null);
        let bestMove = -1;
        let bestScore = -INF;
        for (const c of order) {
          let s;
          if (p.wins(c)) {
            s = WIN - 1;
          } else {
            p.play(c);
            s = -this.negamax(p, d - 1, -INF, INF, 1);
            p.undo();
          }
          if (this.stopped) break;
          scores[c] = s;
          if (s > bestScore) {
            bestScore = s;
            bestMove = c;
          }
        }
        if (this.stopped && result) break; // keep the last depth that finished

        order = [bestMove, ...order.filter((c) => c !== bestMove)];
        result = {
          depth: d,
          move: bestMove,
          score: bestScore,
          scores,
          line: this.principalLine(p, bestMove, d),
          nodes: this.nodes,
          cutoffs: this.cutoffs,
          hits: this.hits,
          ms: Math.round(now() - start),
        };
        if (onDepth) onDepth(result);
        if (this.stopped || Math.abs(bestScore) > NEAR_WIN) break; // the outcome is already settled
      }

      // The Apprentice level picks at random among moves close to the best, unless a win or loss is in sight.
      if (noise > 0 && result && Math.abs(result.score) < NEAR_WIN) {
        const close = result.scores
          .map((s, c) => ({ s, c }))
          .filter((x) => x.s !== null && x.s >= result.score - noise && x.s > -NEAR_WIN);
        const pick = close[Math.floor(Math.random() * close.length)];
        if (pick && pick.c !== result.move) {
          result.move = pick.c;
          result.line = this.principalLine(p, pick.c, result.depth);
        }
      }
      if (result) result.ms = Math.round(now() - start);
      return result;
    }
  }

  // Plies until a decided game ends, from the searching side's view (null if not decided).
  function pliesToEnd(score) {
    return Math.abs(score) > NEAR_WIN ? WIN - Math.abs(score) : null;
  }

  const api = { COLS, ROWS, SIZE, WIN, NEAR_WIN, ORDER, at, Position, Searcher, pliesToEnd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Foreteller = api;
})(typeof self !== 'undefined' ? self : this);
