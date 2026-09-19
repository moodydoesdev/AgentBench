import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWire, pasteChunks, promptKey } from '../src/lib/imageTokens.js';
import { createChatStore, applyRecord, addLocalUser, markSendFailed } from '../src/chat/records.js';

const P1 = '/var/folders/x/T/agentbench-images/paste-1-1.png';
const P2 = '/var/folders/x/T/agentbench-images/paste-2-2.png';

test('tokens become paths in place; untokened images lead', () => {
  assert.equal(
    buildWire('see [Image #1] vs [Image #2]', [{ n: 1, path: P1 }, { n: 2, path: P2 }]),
    `see ${P1} vs ${P2}`,
  );
  assert.equal(buildWire('fix [Image #2]', [{ n: 1, path: P1 }, { n: 2, path: P2 }]), `${P1} fix ${P2}`);
  assert.equal(buildWire('', [{ n: 1, path: P1 }]), P1);
});

test('each image path is pasted on its own, text keeps its spacing', () => {
  assert.deepEqual(pasteChunks(`see ${P1} vs ${P2}`), [
    { text: 'see ', image: false },
    { text: P1, image: true },
    { text: ' vs ', image: false },
    { text: P2, image: true },
  ]);
  assert.deepEqual(pasteChunks('plain'), [{ text: 'plain', image: false }]);
});

test('promptKey ignores paths and renumbered markers', () => {
  assert.equal(promptKey(`see ${P1} vs [Image #1]`), promptKey('see [Image #3]  vs [Image #4]'));
});

test('a queued message is delivered, not "may not have sent"', () => {
  const store = createChatStore();
  const echo = addLocalUser(store, '[Image #1] records overflow', [{ url: 'data:x', n: 1 }]);
  echo.wire = `${P1} records overflow`;
  markSendFailed(store, echo); // the 10s no-confirmation timer fired
  applyRecord(store, { type: 'queue-operation', operation: 'enqueue', content: `${P1} records overflow` });
  assert.equal(echo.failed, false);
  assert.equal(echo.queued, true);
  // dequeued as an image turn with Claude's own numbering
  applyRecord(store, {
    type: 'user',
    uuid: 'u1',
    message: { content: [{ type: 'text', text: '[Image #3] records overflow' }, { type: 'image', source: { type: 'base64', data: 'AA' } }] },
  });
  assert.equal(store.messages.length, 1);
  assert.equal(echo.queued, false);
  assert.equal(echo.text, '[Image #3] records overflow');
  assert.equal(echo.images[0].n, 3);
});

test('a message absorbed mid-turn is confirmed and leaves pending', () => {
  const store = createChatStore();
  const echo = addLocalUser(store, 'also this');
  applyRecord(store, { type: 'queue-operation', operation: 'enqueue', content: 'also this' });
  applyRecord(store, { type: 'queue-operation', operation: 'remove', content: 'also this', reason: 'absorbed_mid_turn' });
  assert.equal(echo.queued, false);
  assert.equal(echo.failed, false);
  assert.equal(store.pending.length, 0);
});

test('pasted_content wrapper is stripped and still confirms the echo', () => {
  const store = createChatStore();
  const echo = addLocalUser(store, 'Okay so im a beginner singer - teach me');
  applyRecord(store, {
    type: 'user',
    uuid: 'u3',
    message: {
      content: '<pasted_content id="4009">\nOkay so im a beginner singer - teach me\n</pasted_content id="4009">',
    },
  });
  assert.equal(store.messages.length, 1);
  assert.equal(echo.local, false);
});

test('an unmatched pasted_content record renders without the tags', () => {
  const store = createChatStore();
  applyRecord(store, {
    type: 'user',
    uuid: 'u4',
    message: {
      content: [{ type: 'text', text: '<pasted_content id="7">\nhello there\n</pasted_content id="7">' }],
    },
  });
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0].text, 'hello there');
});

test('a plain-text path record still confirms its image echo', () => {
  const store = createChatStore();
  const echo = addLocalUser(store, '[Image #1] ugly', [{ url: 'data:x', n: 1 }]);
  echo.wire = `${P1} ugly`;
  applyRecord(store, { type: 'user', uuid: 'u2', message: { content: `${P1} ugly` } });
  assert.equal(store.messages.length, 1);
  assert.equal(echo.local, false);
});
