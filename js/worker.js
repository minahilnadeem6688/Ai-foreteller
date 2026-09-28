/* Runs the search off the main thread, so the page keeps animating while the Foreteller thinks. */
importScripts('engine.js');

const { Position, Searcher } = self.Foreteller;
const searcher = new Searcher(); // one table for the whole session: later searches reuse earlier work

self.onmessage = (e) => {
  const { type, id, moves, options } = e.data;
  if (type === 'clear') return searcher.clear();
  if (type !== 'search') return;
  const result = searcher.search(Position.from(moves), {
    ...options,
    onDepth: (r) => self.postMessage({ id, type: 'depth', result: r }),
  });
  self.postMessage({ id, type: 'done', result });
};
