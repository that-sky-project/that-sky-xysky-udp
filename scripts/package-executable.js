import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { smokeExecutable } from './smoke-executable.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform)) {
  throw new Error('Executable packaging supports only Windows amd64 and Linux amd64.');
}
const platform = process.platform === 'win32' ? 'windows' : 'linux';
const name = `xysky-udp-${version}-${platform}-amd64`;
const dist = path.join(root, 'dist');
const source = path.join(dist, name);
if (!statSync(source).isDirectory()) throw new Error(`Build the executable before packaging: ${source}`);
const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
const archive = path.join(dist, name + extension);
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
};
const quotePs = value => "'" + value.replaceAll("'", "''") + "'";

// Contents are inspected before the archive is regenerated.
console.log(`Packaging ${name}: ${readdirSync(source).join(', ')}`);
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -LiteralPath ${quotePs(source)} -DestinationPath ${quotePs(archive)} -Force`]);
} else {
  run('tar', ['-czf', archive, '-C', dist, name]);
}

// Test the actual archive after extraction/relocation, not its build directory.
const extracted = mkdtempSync(path.join(tmpdir(), 'xysky-executable-test-'));
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath ${quotePs(archive)} -DestinationPath ${quotePs(extracted)}`]);
} else {
  run('tar', ['-xzf', archive, '-C', extracted]);
}
await smokeExecutable(path.join(extracted, name), version);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(path.join(dist, name + '.sha256'), `${digest}  ${path.basename(archive)}\n`);
console.log(`Verified archive: ${archive}`);
console.log(`SHA256: ${digest}`);
