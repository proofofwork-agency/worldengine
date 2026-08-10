import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const packageDirectory = process.cwd();
const workspaceDirectory = resolve(packageDirectory, '../..');
await rm(resolve(packageDirectory, 'dist'), { recursive: true, force: true });
const tsc = resolve(workspaceDirectory, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: packageDirectory, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
