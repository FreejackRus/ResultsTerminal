import { createDemo } from '../apps/demo-mis/src/index.ts';
const app = await createDemo({ key: process.env.RT_DEMO_KEY ?? 'demo-only-key' });
await app.listen({ host: '127.0.0.1', port: Number(process.env.RT_DEMO_PORT ?? 8788) });
console.log('Synthetic MIS ready on loopback.');
process.on('SIGTERM', () => void app.close());
