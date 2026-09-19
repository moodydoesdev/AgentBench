import test from 'node:test';
import assert from 'node:assert/strict';
import { questionAnswerSteps, sendQuestionAnswer } from '../src/lib/questionAnswer.js';
const q = (multiSelect = false) => ({ options: [{label:'A'}, {label:'B'}, {label:'C'}], multiSelect });
const a = (pick = 0, set = [], other = '') => ({ pick, set, other });
const down = '\x1b[B';
test('one single choice submits directly without an extra Enter into the next prompt', () => {
  assert.deepEqual(questionAnswerSteps([q()], [a(2)]), [down, down, '\r']);
});
test('multiple questions and multi-select confirm the final review page', () => {
  assert.deepEqual(questionAnswerSteps([q(),q()], [a(),a(1)]), ['\r', down, '\r', '\r']);
  assert.deepEqual(questionAnswerSteps([q(true)], [a(null,[0,2])]), [' ',down,down,' ','\r','\r']);
});
test('Other focuses the inline field before pasting, with no premature Enter', () => {
  assert.deepEqual(questionAnswerSteps([q()], [a(null,[], 'custom\nanswer')]), [down,down,down,'\x1b[200~custom\nanswer\x1b[201~','\r']);
});
test('delivery awaits acknowledged writes and pacing; only first write claims the question', async () => {
  const events=[];
  await sendQuestionAnswer(async (command, args) => { events.push([command,args]); }, 7, [down,'\r'], async ms => events.push(ms));
  assert.equal(events[0][1].ack, true);
  assert.equal(events[0][1].answers, true);
  assert.equal(events[1],200);
  assert.equal(events[2][1].answers,false);
});
test('failed delivery stops before sending more picker keys', async () => {
  let writes=0;
  await assert.rejects(sendQuestionAnswer(async () => { writes++; throw Error('pane gone'); }, 7, [down,'\r'],async () => {}), /pane gone/);
  assert.equal(writes,1);
});
