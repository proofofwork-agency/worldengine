import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['schema', 'terrain', 'runtime', 'three', 'compiler'];
const destination = await mkdtemp(join(tmpdir(), 'worldengine-pack-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return result.stdout;
}

try {
  for (const packageName of packages) {
    const cwd = resolve(root, 'packages', packageName);
    const before = new Set(await readdir(destination));
    run('pnpm', ['pack', '--pack-destination', destination], cwd);
    const archiveName = (await readdir(destination)).find((name) => name.endsWith('.tgz') && !before.has(name));
    if (!archiveName) throw new Error(`pnpm pack did not create a tarball for @worldengine/${packageName}`);
    const archive = join(destination, archiveName);
    const paths = new Set(run('tar', ['-tzf', archive], cwd).trim().split('\n').map((path) => path.replace(/^package\//, '')));

    for (const required of ['LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts']) {
      if (!paths.has(required)) throw new Error(`@worldengine/${packageName} is missing ${required} from its tarball`);
    }
    if (packageName === 'compiler' && !paths.has('THIRD_PARTY_NOTICES.md')) {
      throw new Error('@worldengine/compiler is missing THIRD_PARTY_NOTICES.md from its tarball');
    }

    const forbidden = [...paths].filter((path) => path.startsWith('src/') || path.includes('.test.') || path.includes('.spec.') || /(?:^|\/)(?:__)?tests?(?:__)?(?:\/|\.)/.test(path));
    if (forbidden.length > 0) throw new Error(`@worldengine/${packageName} contains non-release files: ${forbidden.join(', ')}`);

    const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json'], cwd));
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    const unresolved = Object.entries(dependencies).filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'));
    if (unresolved.length > 0) throw new Error(`${manifest.name} contains unresolved workspace dependencies: ${unresolved.map(([name]) => name).join(', ')}`);

    const archiveStat = await stat(archive);
    process.stdout.write(`${manifest.name}@${manifest.version}: ${paths.size} files, ${archiveStat.size} bytes packed\n`);
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}
