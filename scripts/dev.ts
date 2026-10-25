import { createServer } from 'vite';
import { resolve } from 'node:path';
import { createGateway } from '../apps/gateway/src/index.ts';
import { Store } from '../apps/gateway/src/store.ts';
import { createDemo } from '../apps/demo-mis/src/index.ts';
const demo = await createDemo();
await demo.listen({ host: '127.0.0.1', port: 8788 });
const store = new Store(resolve('var/development.sqlite'));
if (!store.integration.url)
  store.integration = {
    url: 'http://127.0.0.1:8788',
    key: 'demo-only-key',
    ca: '',
    timeoutMs: 30000,
  };
const gateway = await createGateway({
  store,
  development: true,
  bootstrapToken: 'demo-setup-local',
});
await gateway.listen({ host: '127.0.0.1', port: 8787 });
const terminal = await createServer({
  root: resolve('apps/terminal'),
  configFile: resolve('apps/terminal/vite.config.ts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
await terminal.listen();
const admin = await createServer({
  root: resolve('apps/admin'),
  configFile: resolve('apps/admin/vite.config.ts'),
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
await admin.listen();
console.log('ResultsTerminal demo: http://127.0.0.1:5173 / Admin: http://127.0.0.1:5174/admin/');
async function close() {
  await terminal.close();
  await admin.close();
  await gateway.close();
  await demo.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
