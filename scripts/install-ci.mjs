import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.npm_execpath) throw new Error('Run this installer with npm run install:ci.');
const root = fileURLToPath(new URL('..', import.meta.url));
const installed = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--prefix', root,
  '--workspaces=false', '--include=dev', '--include=optional', '--prefer-offline', '--no-audit', '--no-fund'], { stdio: 'inherit' });
if (installed.error) throw installed.error;
if (installed.status !== 0) process.exit(installed.status ?? 1);
await import('vite');
await import('@vitejs/plugin-react');
