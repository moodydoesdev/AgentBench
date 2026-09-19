import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStore, applyRecord, addLocalUser } from '../src/chat/records.js';
import { terminalThemeFromVars, THEMES } from '../src/themes.js';

test('Codex messages confirm optimistic sends and show tool results once', () => {
  const store = createChatStore();
  addLocalUser(store, 'hello');
  const record = (payload) => ({ type: 'response_item', payload });
  applyRecord(store, record({ type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }));
  const reply = record({ type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] });
  applyRecord(store, reply);
  applyRecord(store, reply);
  applyRecord(store, { type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } });
  assert.equal(store.messages.length, 2);
  assert.equal(store.pending.length, 0);
  applyRecord(store, record({ type: 'function_call', call_id: 'tool1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }));
  applyRecord(store, record({ type: 'function_call_output', call_id: 'tool1', output: '/project' }));
  assert.equal(store.tools.get('tool1').done, true);
  assert.equal(store.tools.get('tool1').result, '/project');
});

test('Codex ignores injected instructions and tracks turn boundaries', () => {
  const store = createChatStore();
  applyRecord(store, { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{type:'input_text',text:'secret context'}] } });
  assert.equal(store.messages.length, 0);
  applyRecord(store, { type: 'event_msg', payload: { type: 'task_started' } });
  assert.equal(store.turnActive, true);
  applyRecord(store, { type: 'event_msg', payload: { type: 'task_complete' } });
  assert.equal(store.turnActive, false);
});

test('ANSI black follows every terminal theme, including wallpaper mode', () => {
  for (const theme of Object.values(THEMES)) {
    for (const transparent of [false, true]) {
      assert.equal(terminalThemeFromVars(theme.vars, transparent).black, theme.vars['--theme-term-bg']);
    }
  }
});
