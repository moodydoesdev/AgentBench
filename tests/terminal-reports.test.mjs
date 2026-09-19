import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalReport } from '../src/lib/terminalReports.js';

test('terminal-generated replies are not user input', () => {
  for (const d of ['\x1b[I', '\x1b[O', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', ''])
    assert.equal(isTerminalReport(d), true, JSON.stringify(d));
});

test('keystrokes are user input', () => {
  for (const d of ['a', '\r', '\x03', '\x1b[A', '\x1b[1;5C', '\x1bb', 'hello\r'])
    assert.equal(isTerminalReport(d), false, JSON.stringify(d));
});
