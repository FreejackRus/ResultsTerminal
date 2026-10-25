import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printBatch } from '../apps/terminal/src/printing.ts';
test('unknown spool result stops and never automatically resubmits', async () => {
  const submitted: string[] = [];
  const r = await printBatch(
    ['a', 'b', 'c'],
    async () => [1],
    async (id) => {
      submitted.push(id);
      if (id === 'b') throw Error();
    },
    () => true,
    () => {},
  );
  assert.deepEqual(submitted, ['a', 'b']);
  assert.deepEqual(r.completed, ['a']);
  assert.equal(r.uncertain, 'b');
  assert.deepEqual(r.failed, ['c']);
});
test('prepare failure is retryable; cancellation prevents further submission', async () => {
  let active = true;
  const jobs: string[] = [];
  const r = await printBatch(
    ['a', 'b', 'c'],
    async (id) => {
      if (id === 'a') throw Error();
      return [1];
    },
    async (id) => {
      jobs.push(id);
      active = false;
    },
    () => active,
    () => {},
  );
  assert.deepEqual(r.failed, ['a']);
  assert.deepEqual(jobs, ['b']);
  assert.equal(r.cancelled, true);
});

test('a definite failure before submission stays retryable', async () => {
  const r = await printBatch(
    ['a', 'b'],
    async () => [1],
    async () => {
      throw 'NOT_SUBMITTED';
    },
    () => true,
    () => {},
  );
  assert.equal(r.uncertain, undefined);
  assert.deepEqual(r.failed, ['a', 'b']);
});
