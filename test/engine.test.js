const test = require('node:test');
const assert = require('node:assert/strict');
const { Position, Searcher, WIN, NEAR_WIN, pliesToEnd } = require('../js/engine.js');

// Columns are 0-based here; the page shows them as 1 to 7.

test('spots wins in every direction', () => {
  assert.ok(Position.from([0, 6, 1, 6, 2, 6]).wins(3), 'horizontal');
  assert.ok(Position.from([0, 1, 0, 1, 0, 1]).wins(0), 'vertical');
  // diagonal up-right for the first player: (0,0) (1,1) (2,2) (3,3)
  assert.ok(Position.from([0, 1, 1, 2, 2, 3, 2, 3, 3, 6]).wins(3), 'diagonal');
  // diagonal down-right: (0,3) (1,2) (2,1) (3,0)
  assert.ok(Position.from([3, 2, 2, 1, 1, 0, 1, 0, 0, 6]).wins(0), 'anti-diagonal');
  assert.ok(!Position.from([0, 6, 1, 6]).wins(2), 'no win yet');
});

test('winningCells returns the connected four', () => {
  const p = Position.from([0, 6, 1, 6, 2, 6, 3]);
  const cells = p.winningCells(3, 0);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(([c]) => c).sort(), [0, 1, 2, 3]);
});

test('undo restores the board and the hash', () => {
  const p = Position.from([3, 2, 4]);
  const before = [p.lo, p.hi, Array.from(p.cells).join('')];
  p.play(5);
  p.undo();
  assert.deepEqual([p.lo, p.hi, Array.from(p.cells).join('')], before);
});

test('the same position reached in a different order has the same hash', () => {
  const a = Position.from([3, 2, 4, 1]);
  const b = Position.from([4, 1, 3, 2]);
  assert.equal(a.lo, b.lo);
  assert.equal(a.hi, b.hi);
});

test('takes an immediate win', () => {
  const r = new Searcher().search(Position.from([0, 6, 1, 6, 2, 5]), { maxDepth: 6 });
  assert.equal(r.move, 3);
  assert.equal(r.score, WIN - 1);
});

test('blocks an immediate threat', () => {
  // First player has 0,1,2 on the bottom row; second player must take column 3.
  const r = new Searcher().search(Position.from([0, 6, 1, 6, 2]), { maxDepth: 6 });
  assert.equal(r.move, 3);
});

test('finds a forced win through a double threat', () => {
  // First player on 2 and 3 with both ends open: playing 1 or 4 makes two threats at once.
  const r = new Searcher().search(Position.from([2, 6, 3, 6]), { maxDepth: 8 });
  assert.ok([1, 4].includes(r.move), `played ${r.move}`);
  assert.ok(r.score > NEAR_WIN);
  assert.equal(pliesToEnd(r.score), 3); // its move, a forced reply, then the win
});

test('scores every legal column and marks full ones', () => {
  const p = Position.from([0, 0, 0, 0, 0, 0]);
  const r = new Searcher().search(p, { maxDepth: 4 });
  assert.equal(r.scores[0], null);
  assert.ok(r.scores.slice(1).every((s) => typeof s === 'number'));
  assert.notEqual(r.move, 0);
});

test('iterative deepening reports each depth in order and stops on time', () => {
  const depths = [];
  const r = new Searcher().search(new Position(), { timeMs: 300, onDepth: (d) => depths.push(d.depth) });
  assert.deepEqual(depths, depths.map((_, i) => i + 1));
  assert.ok(r.depth >= 8, `reached depth ${r.depth}`);
  assert.ok(r.ms < 600, `took ${r.ms} ms`);
});

test('pruning visits far fewer positions than plain minimax', () => {
  const r = new Searcher().search(new Position(), { maxDepth: 8 });
  const minimax = [1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, k) => sum + 7 ** k, 0);
  assert.ok(r.nodes < minimax / 100, `${r.nodes} of ${minimax}`);
});

test('the expected line is legal and as long as the search', () => {
  const s = new Searcher();
  const moves = [];
  for (let k = 0; k < 16; k++) {
    const p = Position.from(moves);
    const r = s.search(p, { timeMs: 150 });
    const q = Position.from(moves);
    for (const c of r.line) {
      assert.ok(q.canPlay(c));
      if (q.wins(c)) break;
      q.play(c);
    }
    if (Math.abs(r.score) < NEAR_WIN) assert.equal(r.line.length, Math.min(r.depth, 42 - moves.length));
    if (p.wins(r.move)) break;
    moves.push(r.move);
  }
});

test('never loses a game to a random player', () => {
  for (let g = 0; g < 6; g++) {
    const p = new Position();
    const s = new Searcher();
    let result = 0;
    while (p.moves < 42) {
      const legal = p.legalMoves();
      const c = p.turn === 1 ? s.search(p, { maxDepth: 6 }).move : legal[Math.floor(Math.random() * legal.length)];
      if (p.wins(c)) { result = p.turn; break; }
      p.play(c);
    }
    assert.notEqual(result, 2, 'the random player won');
  }
});
