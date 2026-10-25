import assert from 'node:assert/strict';
import { createDemo, demoCredentials } from '../apps/demo-mis/src/index.ts';
import { MisClient } from '../apps/gateway/src/mis.ts';
import {
  CapabilitiesSchema,
  SessionSchema,
  ChallengeSchema,
  ResultsSchema,
  Type,
  methods,
  validate,
  type Results,
} from '../packages/contracts/src/index.ts';
const local = !process.env.RT_MIS_URL;
const demo = local ? await createDemo() : null;
if (demo) await demo.listen({ host: '127.0.0.1', port: 0 });
const url = process.env.RT_MIS_URL ?? demo!.listeningOrigin,
  key = process.env.RT_MIS_KEY ?? 'demo-only-key';
const fixture = process.env.RT_CONTRACT_FIXTURES
  ? JSON.parse(
      await (await import('node:fs/promises')).readFile(process.env.RT_CONTRACT_FIXTURES, 'utf8'),
    )
  : Object.fromEntries(
      methods.map((method) => [
        method,
        method === 'phone-otp'
          ? { method, identifier: demoCredentials.phone, otp: demoCredentials.otp }
          : ['barcode', 'qr'].includes(method)
            ? { method, identifier: demoCredentials.token }
            : method === 'oms-birth'
              ? { method, identifier: demoCredentials.identifier, proof: demoCredentials.birthDate }
              : method === 'oms-name'
                ? { method, identifier: demoCredentials.identifier, proof: demoCredentials.name }
                : { method, identifier: '000001', proof: demoCredentials.accessCode },
      ]),
    );
if (!local && !process.env.RT_CONTRACT_FIXTURES)
  throw Error('Provide RT_CONTRACT_FIXTURES with explicitly authorized synthetic identities.');
const client = () =>
  new MisClient(
    {
      url,
      key,
      ca: process.env.RT_MIS_CA ? requireFile(process.env.RT_MIS_CA) : '',
      timeoutMs: 30000,
    },
    local,
  );
function requireFile(path: string) {
  return readFileSync(path, 'utf8');
}
import { readFileSync } from 'node:fs';
try {
  const caps = await client().json('/capabilities', CapabilitiesSchema);
  assert.ok(caps.methods.length);
  let checked = 0;
  for (const method of caps.methods) {
    const f = fixture[method];
    assert.ok(f, `Missing fixture for ${method}`);
    const { otp, ...input } = f;
    let response = await client().json(
      '/identifications',
      Type.Union([SessionSchema, ChallengeSchema]),
      'POST',
      input,
    );
    if ('challengeId' in response) {
      assert.equal(method, 'phone-otp');
      response = await client().json('/identifications/confirm', SessionSchema, 'POST', {
        challengeId: response.challengeId,
        code: otp,
      });
    }
    assert.ok('sessionId' in response);
    const session = (response as any).sessionId;
    try {
      let cursor: string | null = null;
      let pages = 0;
      const seen = new Set<string>();
      do {
        const result: Results = await client().json(
          `/sessions/${encodeURIComponent(session)}/results` +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
          ResultsSchema,
        );
        for (const item of result.items) {
          assert.ok(!seen.has(item.id), 'Duplicate result ID');
          seen.add(item.id);
          if (item.pdfAvailable && item.status === 'ready') {
            const pdf = await client().call(
              `/sessions/${encodeURIComponent(session)}/results/${encodeURIComponent(item.id)}/pdf`,
            );
            assert.ok(pdf.type.startsWith('application/pdf'));
            assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
          }
        }
        if (result.nextCursor === cursor && cursor) throw Error('Pagination loop');
        cursor = result.nextCursor;
        assert.ok(++pages <= 100, 'Pagination did not finish');
      } while (cursor);
    } finally {
      await client().call(`/sessions/${encodeURIComponent(session)}`, 'DELETE');
    }
    await assert.rejects(() =>
      client().json(`/sessions/${encodeURIComponent(session)}/results`, ResultsSchema),
    );
    checked++;
  }
  console.log(`PASS: ${checked} declared methods, pagination, PDF and closed-session rejection.`);
} finally {
  await demo?.close();
}
