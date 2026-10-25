import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../apps/gateway/src/index.ts';
import { Store } from '../apps/gateway/src/store.ts';
import { createDemo } from '../apps/demo-mis/src/index.ts';
import { defaults, methods } from '../packages/contracts/src/index.ts';
async function fixture(
  t: any,
  scenario: any = 'normal',
  options: Parameters<typeof createDemo>[0] = {},
) {
  const mis = await createDemo({ scenario, ...options });
  await mis.listen({ host: '127.0.0.1', port: 0 });
  const store = new Store();
  store.integration = { url: mis.listeningOrigin, key: 'demo-only-key', ca: '', timeoutMs: 3000 };
  store.config = { ...defaults, methods: [...methods] };
  const app = await createGateway({ store, development: true, bootstrapToken: 'setup-token' });
  await app.ready();
  t.after(async () => {
    await app.close();
    await mis.close();
  });
  const req = (url: string, method: any = 'GET', payload?: any, headers: any = {}) =>
    app.inject({ url, method, payload, headers });
  const setup = await req(
    '/api/admin/setup',
    'POST',
    { username: 'admin', password: 'test-password-1234', setupToken: 'setup-token' },
    { 'x-rt-admin': '1' },
  );
  assert.equal(setup.statusCode, 200);
  const cookie = setup.headers['set-cookie']!.toString().split(';')[0];
  const admin = { cookie, 'x-rt-admin': '1' };
  const pair = async () => {
    const e = await req('/api/admin/enrollments', 'POST', { name: 'Demo' }, admin);
    const p = await req('/api/v1/enroll', 'POST', { code: e.json().code });
    assert.equal(p.statusCode, 200);
    return { authorization: `Bearer ${p.json().token}` };
  };
  return { app, store, req, admin, pair };
}
test('enrollment one-use, authentication and secrets export', async (t) => {
  const { req, admin, store } = await fixture(t);
  const e = await req('/api/admin/enrollments', 'POST', { name: 'Front' }, admin);
  const payload = { code: e.json().code };
  assert.equal((await req('/api/v1/enroll', 'POST', payload)).statusCode, 200);
  assert.equal((await req('/api/v1/enroll', 'POST', payload)).statusCode, 401);
  assert.equal((await req('/api/v1/config')).statusCode, 401);
  const out = await req('/api/admin/export', 'GET', undefined, admin);
  assert.ok(!out.body.includes('demo-only-key'));
  assert.ok(!out.body.includes('test-password'));
  assert.ok(
    !JSON.stringify(store.db.prepare('SELECT * FROM settings').all()).includes('demo-only-key'),
  );
});
test('all declared identification methods; sessions and PDF isolated across terminals', async (t) => {
  const { req, pair } = await fixture(t);
  const a = await pair(),
    b = await pair();
  for (const method of methods) {
    const body =
      method === 'phone-otp'
        ? { method, identifier: '+79990000000' }
        : ['barcode', 'qr'].includes(method)
          ? { method, identifier: 'DEMO-ACCESS-0001' }
          : method === 'oms-birth'
            ? { method, identifier: '0000000000000001', proof: '2000-01-01' }
            : method === 'oms-name'
              ? { method, identifier: '0000000000000001', proof: 'Тестовый Пациент' }
              : { method, identifier: '000001', proof: '246810' };
    let res = await req('/api/v1/identifications', 'POST', body, a);
    assert.equal(res.statusCode, 200, res.body);
    if (method === 'phone-otp') {
      assert.equal(
        (
          await req(
            '/api/v1/identifications/confirm',
            'POST',
            { challengeId: res.json().challengeId, code: '123456' },
            b,
          )
        ).statusCode,
        401,
      );
      res = await req(
        '/api/v1/identifications/confirm',
        'POST',
        { challengeId: res.json().challengeId, code: '123456' },
        a,
      );
    }
    const s = res.json().sessionId;
    const page = await req(`/api/v1/sessions/${s}/results`, 'GET', undefined, a);
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().items.length, 2);
    assert.equal((await req(`/api/v1/sessions/${s}/results`, 'GET', undefined, b)).statusCode, 410);
    const pdf = await req(
      `/api/v1/sessions/${s}/results/${page.json().items[0].id}/pdf`,
      'GET',
      undefined,
      a,
    );
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    const next = await req(`/api/v1/sessions/${s}/results?cursor=page-2`, 'GET', undefined, a);
    assert.equal(next.json().items.length, 1);
    await req(`/api/v1/sessions/${s}`, 'DELETE', undefined, a);
    assert.equal((await req(`/api/v1/sessions/${s}/results`, 'GET', undefined, a)).statusCode, 410);
  }
});
test('admin CSRF, optimistic config and revocation invalidate access', async (t) => {
  const { req, admin, pair } = await fixture(t);
  assert.equal(
    (await req('/api/admin/config', 'PUT', defaults, { cookie: admin.cookie })).statusCode,
    403,
  );
  const c = (await req('/api/admin/config', 'GET', undefined, admin)).json();
  assert.equal((await req('/api/admin/config', 'PUT', c, admin)).statusCode, 200);
  assert.equal((await req('/api/admin/config', 'PUT', c, admin)).statusCode, 409);
  const a = await pair();
  const terminals = (await req('/api/admin/terminals', 'GET', undefined, admin)).json();
  await req(`/api/admin/terminals/${terminals[0].id}/revoke`, 'POST', {}, admin);
  assert.equal((await req('/api/v1/config', 'GET', undefined, a)).statusCode, 401);
});
for (const scenario of ['empty', 'invalid', 'unavailable'] as const)
  test(`MIS ${scenario} response is explicit`, async (t) => {
    const { req, pair } = await fixture(t, scenario);
    const a = await pair();
    const s = await req(
      '/api/v1/identifications',
      'POST',
      { method: 'oms-birth', identifier: '0000000000000001', proof: '2000-01-01' },
      a,
    );
    if (scenario === 'unavailable') {
      assert.equal(s.statusCode, 503);
      return;
    }
    const res = await req(`/api/v1/sessions/${s.json().sessionId}/results`, 'GET', undefined, a);
    assert.equal(res.statusCode, scenario === 'empty' ? 200 : 502);
    if (scenario === 'empty') assert.deepEqual(res.json().items, []);
    else assert.equal(res.json().error.code, 'INVALID_MIS_RESPONSE');
  });

test('session expiry invalidates PDF and results', async (t) => {
  const { req, pair } = await fixture(t, 'normal', { ttl: 40 });
  const auth = await pair();
  const res = await req(
    '/api/v1/identifications',
    'POST',
    { method: 'oms-birth', identifier: '0000000000000001', proof: '2000-01-01' },
    auth,
  );
  assert.equal(res.statusCode, 200);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    (await req(`/api/v1/sessions/${res.json().sessionId}/results`, 'GET', undefined, auth))
      .statusCode,
    410,
  );
});
test('late identification cannot reopen a reset patient session', async (t) => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (started = r));
  const { req, pair } = await fixture(t, 'normal', {
    beforeIdentification: async () => {
      started();
      await waiting;
    },
  });
  const auth = await pair();
  const pending = req(
    '/api/v1/identifications',
    'POST',
    { method: 'oms-birth', identifier: '0000000000000001', proof: '2000-01-01' },
    auth,
  ).then((r) => r);
  await ready;
  assert.equal((await req('/api/v1/reset', 'POST', {}, auth)).statusCode, 200);
  release();
  assert.equal((await pending).statusCode, 410);
});

test('changing integration invalidates every active patient session', async (t) => {
  const { req, pair, admin } = await fixture(t);
  const auth = await pair();
  const res = await req(
    '/api/v1/identifications',
    'POST',
    { method: 'oms-birth', identifier: '0000000000000001', proof: '2000-01-01' },
    auth,
  );
  const integration = (await req('/api/admin/integration', 'GET', undefined, admin)).json();
  const { keyConfigured, ...settings } = integration;
  assert.equal((await req('/api/admin/integration', 'PUT', settings, admin)).statusCode, 200);
  assert.equal(
    (await req(`/api/v1/sessions/${res.json().sessionId}/results`, 'GET', undefined, auth))
      .statusCode,
    410,
  );
});

test('terminal profiles inherit defaults and publish hardware and timers atomically', async (t) => {
  const { req, pair, admin } = await fixture(t);
  const auth = await pair();
  const terminals = (await req('/api/admin/terminals', 'GET', undefined, admin)).json();
  const config = (await req('/api/admin/config', 'GET', undefined, admin)).json();
  const profile = {
    version: config.version,
    hardware: { ...config.hardware, printer: 'Synthetic printer' },
    timers: { ...config.timers, idleSeconds: 60 },
  };
  assert.equal(
    (await req(`/api/admin/terminals/${terminals[0].id}/settings`, 'PUT', profile, admin))
      .statusCode,
    200,
  );
  const effective = (await req('/api/v1/config', 'GET', undefined, auth)).json();
  assert.equal(effective.timers.idleSeconds, 60);
  assert.equal(effective.hardware.printer, 'Synthetic printer');
  assert.equal(effective.version, config.version + 1);
  assert.equal(
    (await req(`/api/admin/terminals/${terminals[0].id}/settings`, 'PUT', profile, admin))
      .statusCode,
    409,
  );
});
