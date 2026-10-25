import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateway } from '../apps/gateway/src/index.ts';
import { Store } from '../apps/gateway/src/store.ts';
const cert = process.env.RT_TLS_CERT,
  key = process.env.RT_TLS_KEY;
if (!cert || !key)
  throw Error(
    'RT_TLS_CERT and RT_TLS_KEY paths are required. Production HTTPS cannot be disabled.',
  );
const store = new Store(resolve(process.env.RT_DATABASE ?? 'var/gateway.sqlite'));
if (
  !store.db.prepare('SELECT name FROM admins LIMIT 1').get() &&
  (!process.env.RT_SETUP_TOKEN || process.env.RT_SETUP_TOKEN.length < 24)
)
  throw Error('Set a random RT_SETUP_TOKEN of at least 24 characters for first startup.');
const app = await createGateway({
  store,
  bootstrapToken: process.env.RT_SETUP_TOKEN,
  tls: { cert: readFileSync(cert), key: readFileSync(key) },
});
await app.listen({
  host: process.env.RT_HOST ?? '127.0.0.1',
  port: Number(process.env.RT_PORT ?? 8787),
});
console.log('ResultsTerminal gateway ready.');
async function close() {
  await app.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
