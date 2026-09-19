import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputBatcher } from '../src/lib/terminalOutput.js';
import { formatBytes, formatIdle } from '../src/lib/resourceFormat.js';

test('hidden terminal preserves split UTF-8 and escape sequences in order', () => {
  const output = []; let timer; let visible = false;
  const batch = createOutputBatcher((bytes) => output.push(...bytes), () => visible,
    {setTimeout(fn) {timer=fn;return 1;},clearTimeout() {timer=null;}});
  const bytes = new TextEncoder().encode('\x1b[31mHello 🌎\x1b[0m');
  for (const byte of bytes) batch.push(Uint8Array.of(byte));
  assert.equal(output.length,0);
  timer();
  assert.deepEqual(Uint8Array.from(output),bytes);
  visible=true;batch.push(Uint8Array.of(33));assert.equal(output.at(-1),33);
  batch.dispose();batch.push(Uint8Array.of(44));assert.equal(output.at(-1),33);
});

test('hidden output has a bounded batch and disposal cancels its timer', () => {
  const lengths=[];let timer;
  const batch=createOutputBatcher((b)=>lengths.push(b.length),()=>false,
    {setTimeout(fn){timer=fn;return 1;},clearTimeout(){timer=null;}});
  batch.push(new Uint8Array(32768));assert.ok(timer);
  batch.push(new Uint8Array(32768));assert.deepEqual(lengths,[65536]);assert.equal(timer,null);
  batch.push(Uint8Array.of(1));batch.dispose();assert.equal(timer,null);
});

test('resource labels do not invent memory numbers for missing samples', () => {
  assert.equal(formatBytes(undefined),'—');
  assert.equal(formatBytes(2*1024**3),'2.0 GB');
  assert.equal(formatIdle(1850),'Idle 30m');
});
