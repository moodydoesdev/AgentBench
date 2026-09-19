import test from 'node:test';
import assert from 'node:assert/strict';
import { taskState } from '../src/tasks/taskState.js';
test('old entries are unconfirmed, never assumed running or successfully completed', () => {
  const now=Date.now();const row={kind:'shell',updatedAt:now-40*3600*1000};
  assert.equal(taskState(row,now),'unconfirmed');
  assert.equal(taskState({...row,updatedAt:now},now),'recent');
  assert.equal(taskState({...row,updatedAt:now},now,{hibernated:true}),'unconfirmed');
  assert.equal(taskState({...row,done:true},now),'finished');
});
