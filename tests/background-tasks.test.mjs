import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStore, applyRecord } from '../src/chat/records.js';

function launch(name = 'Bash') {
  const store = createChatStore();
  applyRecord(store, { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'tool1', name, input: { run_in_background: true, command: 'sleep 10' } }] } });
  return store;
}
function result(store, id, text, is_error = false) {
  applyRecord(store, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
}
test('background shell ID and meta completion reconcile', () => {
  const store = launch();
  result(store, 'tool1', 'Command running in background with ID: abc123');
  assert.equal(store.activity.get('tool1').bgId, 'abc123');
  applyRecord(store, { type: 'user', isMeta: true, message: { content: '<task-notification><task-id>abc123</task-id><status>failed</status><summary>Build failed</summary></task-notification>' } });
  assert.equal(store.activity.get('tool1').done, true);
  assert.equal(store.activity.get('tool1').failed, true);
});
test('Agent launch preserves original time and output', () => {
  const store = launch('Agent');
  result(store, 'tool1', 'agentId: agent123');
  assert.equal(store.activity.get('tool1').bgId, 'agent123');
  assert.equal(store.activity.get('tool1').startedAt, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(store.activity.get('tool1').output, 'agentId: agent123');
});
test('stop requests only complete after success; output words do not imply completion', () => {
  const store = launch();
  result(store, 'tool1', 'background ID: abc123');
  const call = (id, name) => applyRecord(store, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { task_id: 'abc123' } }] } });
  call('poll', 'TaskOutput');
  result(store, 'poll', '<status>running</status>Test failed but process continues');
  assert.equal(store.activity.get('tool1').done, false);
  call('stop', 'TaskStop');
  assert.equal(store.activity.get('tool1').done, false);
  result(store, 'stop', 'Could not stop', true);
  assert.equal(store.activity.get('tool1').done, false);
  call('stop2', 'TaskStop');
  result(store, 'stop2', 'Stopped');
  assert.equal(store.activity.get('tool1').done, true);
});

test('queue and attachment completion notices retire tasks without duplicating chat', () => {
  for (const type of ['queue-operation','attachment']) {
    const store=launch();result(store,'tool1','background ID: abc123');
    const text='<task-notification><task-id>abc123</task-id><status>completed</status></task-notification>';
    const rec=type==='queue-operation' ? {type,operation:'enqueue',content:text}
      : {type,attachment:{type:'queued_command',commandMode:'task-notification',prompt:text}};
    const count=store.messages.length;
    assert.equal(applyRecord(store,{...rec,timestamp:'2026-01-01T00:05:00Z'}),true);
    assert.equal(store.activity.get('tool1').done,true);
    assert.equal(store.activity.get('tool1').endedAt,Date.parse('2026-01-01T00:05:00Z'));
    assert.equal(store.messages.length,count);
    assert.equal(applyRecord(store,rec),false);
  }
});

test('background-requested Bash that finished immediately does not become a zombie task', () => {
  const store=launch();
  applyRecord(store,{type:'user',toolUseResult:{stdout:'done',stderr:'',interrupted:false},message:{content:[{type:'tool_result',tool_use_id:'tool1',content:'done'}]}});
  assert.equal(store.activity.get('tool1').done,true);
});
