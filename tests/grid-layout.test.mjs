import test from 'node:test';
import assert from 'node:assert/strict';
import { packSpans, resetPaneWidths } from '../src/lib/gridLayout.js';

test('four agents fit across after applying four columns to saved wide panes', () => {
  const panes = [1, 2, 3, 4].map(id => ({ id }));
  const saved = { 1: { w: 2, h: 2 }, 4: { w: 4, h: 1 } };
  const sizes = resetPaneWidths(saved);
  assert.deepEqual(packSpans(panes, sizes, 4), { 1: 1, 2: 1, 3: 1, 4: 1 });
  assert.equal(sizes[1].h, 2);
  assert.equal(saved[1].w, 2);
});
