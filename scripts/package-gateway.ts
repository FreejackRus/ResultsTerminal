import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('dist', { recursive: true });
const result = spawnSync(
  'tar',
  [
    '--exclude=node_modules',
    '--exclude=target',
    '--exclude=var',
    '-czf',
    'dist/resultsterminal-gateway-0.1.0.tar.gz',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'apps/gateway',
    'apps/admin/dist',
    'apps/admin/package.json',
    'apps/demo-mis',
    'packages/contracts',
    'scripts',
    'deploy',
    'examples',
    'docs',
    'README.md',
    'AGENTS.md',
    'THIRD_PARTY_NOTICES.md',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(1);
