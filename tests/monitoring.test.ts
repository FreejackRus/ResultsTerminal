import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthSchema, validate } from '../packages/contracts/src/index.ts';
import { Store } from '../apps/gateway/src/store.ts';
import { createGateway } from '../apps/gateway/src/index.ts';
import { digest } from '../apps/gateway/src/store.ts';
const health = {
  checkedAt: new Date().toISOString(),
  os: 'windows',
  uptimeSeconds: 200,
  cpuPercent: 12,
  memoryTotalMb: 8192,
  memoryUsedMb: 4096,
  diskFreeGb: 20,
  scanner: { state: 'unknown', code: 'HID_UNVERIFIED' },
  printer: { state: 'disconnected', code: 'OFFLINE' },
};
test('health schema never invents ready or accepts free text with PII', () => {
  assert.equal(validate(HealthSchema, health), true);
  assert.equal(
    validate(HealthSchema, { ...health, scanner: { state: 'ready', code: 'patient name' } }),
    false,
  );
  assert.equal(validate(HealthSchema, { ...health, cpuPercent: 200 }), false);
});
test('authenticated terminal sends health snapshot; data stored without credentials', async (t) => {
  const store = new Store();
  store.db
    .prepare('INSERT INTO terminals(id,name,token,hardware) VALUES(?,?,?,?)')
    .run('t1', 'Synthetic', digest('test-token'), '{}');
  const app = await createGateway({ store, development: true });
  t.after(() => app.close());
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/heartbeat',
    headers: { authorization: 'Bearer test-token' },
    payload: { version: '0.1.0', health },
  });
  assert.equal(r.statusCode, 200, r.body);
  const row = store.terminals()[0];
  assert.deepEqual(row.health, health);
  assert.ok(Number(row.last_seen) > 0);
  assert.ok(!('token' in row));
  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/heartbeat',
    payload: { version: '0.1.0', health },
  });
  assert.equal(bad.statusCode, 401);
});
