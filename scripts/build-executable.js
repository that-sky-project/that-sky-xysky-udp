import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { stringify } from 'yaml';
import { configSchema, debugFileSchema } from '../src/config/schema.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const pinoPlugin = require('esbuild-plugin-pino');
const { inject } = require('postject');
const markerName = '.xysky-executable-build.json';
const markerKind = 'xysky-udp-sea-build-v1';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
}

function assertRealDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw new Error(`Refusing unsafe output directory: ${directory}`);
  }
}

function copy(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
}

// Keep the official plugin's worker entry points and Pino overrides. Its 2.3.3
// helper embeds the build machine's outdir (and an invalid import.meta fallback);
// replace only that helper, before esbuild lowers the plugin's source to CJS.
function relocatablePinoPlugin() {
  const plugin = pinoPlugin({ transports: ['pino-pretty'] });
  return {
    name: 'relocatable-pino',
    async setup(currentBuild) {
      const proxy = Object.create(currentBuild);
      proxy.onLoad = (options, callback) => currentBuild.onLoad(options, async args => {
        const result = await callback(args);
        if (!result?.contents) return result;
        const offset = result.contents.indexOf('globalThis.__bundlerPathsOverrides =');
        if (offset === -1 || !result.contents.slice(0, offset).includes('function pinoBundlerAbsolutePath')) {
          throw new Error('Unsupported esbuild-plugin-pino helper; review the pinned plugin before packaging');
        }
        return {
          ...result,
          contents: `function pinoBundlerAbsolutePath(p) {
            return require('node:path').resolve(require('node:path').dirname(process.execPath), 'resources', p);
          }\n` + result.contents.slice(offset)
        };
      });
      await plugin.setup(proxy);
    }
  };
}

function packageRoot(name, from = root) {
  const localRequire = createRequire(path.join(from, 'package.json'));
  try {
    return path.dirname(localRequire.resolve(`${name}/package.json`));
  } catch {
    let directory = path.dirname(localRequire.resolve(name));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory;
      directory = path.dirname(directory);
    }
    throw new Error(`Cannot locate production package ${name}`);
  }
}

function copyNativeRuntime(resources) {
  const nativeRoot = packageRoot('sky-enet');
  const nativeRequire = createRequire(path.join(nativeRoot, 'package.json'));
  const loaderRoot = packageRoot('node-gyp-build', nativeRoot);
  const addon = nativeRequire('node-gyp-build').resolve(nativeRoot);
  const relativeAddon = path.relative(nativeRoot, addon);
  if (relativeAddon.startsWith('..') || path.isAbsolute(relativeAddon) || !relativeAddon.endsWith('.node')) {
    throw new Error(`Native addon must belong to the installed sky-enet package: ${addon}`);
  }
  // Prove the selected binary loads in precisely the runtime being embedded.
  nativeRequire(addon);
  for (const [name, directory, files] of [
    ['sky-enet', nativeRoot, ['index.js', relativeAddon]],
    ['node-gyp-build', loaderRoot, ['index.js', 'node-gyp-build.js']]
  ]) {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const destination = path.join(resources, 'node_modules', name);
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, type: 'commonjs', main: 'index.js', license: manifest.license
    }, null, 2) + '\n');
    for (const file of files) copy(path.join(directory, file), path.join(destination, file));
    for (const file of readdirSync(directory).filter(file => /^(licen[sc]e|copying|notice)(\.|$)/iu.test(file))) {
      if (lstatSync(path.join(directory, file)).isFile()) copy(path.join(directory, file), path.join(destination, file));
    }
  }
  // Verify the copied subtree independently of the development node_modules.
  createRequire(path.join(resources, 'package.json'))('sky-enet');
  return relativeAddon.replaceAll('\\', '/');
}

async function copyNotices(destination, manifest) {
  const licenseDirectory = path.join(destination, 'licenses');
  mkdirSync(licenseDirectory);
  const seen = new Set();
  const notices = [];
  function visit(name, from) {
    const directory = packageRoot(name, from);
    if (seen.has(directory)) return;
    seen.add(directory);
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const files = readdirSync(directory).filter(file => /^(licen[sc]e|copying|notice)(\.|$)/iu.test(file) && lstatSync(path.join(directory, file)).isFile());
    const target = `${metadata.name.replaceAll('/', '-')}-${metadata.version}`;
    for (const file of files) copy(path.join(directory, file), path.join(licenseDirectory, target, file));
    notices.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? 'See package notices', files: files.map(file => `${target}/${file}`) });
    for (const child of Object.keys(metadata.dependencies ?? {})) visit(child, directory);
  }
  for (const name of Object.keys(manifest.dependencies)) visit(name, root);
  // The plugin's generated helper and workers also require their notices.
  visit('esbuild-plugin-pino', root);
  visit('thread-stream', packageRoot('pino'));
  const enetLicense = path.join(packageRoot('sky-enet'), 'enet', 'LICENSE');
  if (!existsSync(enetLicense)) throw new Error('Missing license for vendored ENet native library');
  copy(enetLicense, path.join(licenseDirectory, 'enet', 'LICENSE'));
  notices.push({ name: 'ENet (vendored by sky-enet)', license: 'MIT', files: ['enet/LICENSE'] });
  writeFileSync(path.join(licenseDirectory, 'third-party.json'), JSON.stringify(notices, null, 2) + '\n');
  const candidates = [process.env.NODE_LICENSE, path.join(path.dirname(process.execPath), 'LICENSE'), path.resolve(path.dirname(process.execPath), '..', 'LICENSE')].filter(Boolean);
  const nodeLicense = candidates.find(file => existsSync(file) && lstatSync(file).isFile());
  if (nodeLicense) copy(nodeLicense, path.join(licenseDirectory, 'NODE-LICENSE'));
  else {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Cannot obtain the embedded Node license; set NODE_LICENSE to the distribution LICENSE');
    writeFileSync(path.join(licenseDirectory, 'NODE-LICENSE'), await response.text());
  }
}

function findSignTool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const sdk = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (existsSync(sdk)) {
    for (const version of readdirSync(sdk).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const executable = path.join(sdk, version, 'x64', 'signtool.exe');
      if (existsSync(executable)) return executable;
    }
  }
  throw new Error('Windows SEA builds require Windows SDK signtool.exe; install the SDK or set SIGNTOOL');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/build-executable.js [--bundle-only]\nRun with the Node 22 runtime to embed, on Windows/Linux x64. Output: dist/xysky-udp-VERSION-{windows|linux}-amd64.\nExisting output directories are refused. SIGNTOOL and NODE_LICENSE may specify SDK/runtime license paths.');
    return;
  }
  if (args.some(argument => argument !== '--bundle-only')) throw new Error('Unknown build argument; use --help');
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error(`SEA packaging requires Node 22; received ${process.versions.node}. Run this script with the fixed Node 22 executable.`);
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw new Error('Supported SEA targets are Windows/Linux amd64; build on the target platform.');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(manifest.version)) throw new Error('Package version is unsafe for an output directory');
  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const name = `xysky-udp-${manifest.version}-${platform}-amd64`;
  const dist = path.join(root, 'dist');
  if (!existsSync(dist)) mkdirSync(dist);
  assertRealDirectory(dist);
  const output = path.join(dist, name);
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing output: ${output}. Move or remove that generated release explicitly first.`);
  const staging = mkdtempSync(path.join(dist, `.${name}-`));
  const marker = { kind: markerKind, root, name, runtime: process.versions.node, bundleOnly: args.includes('--bundle-only') };
  writeFileSync(path.join(staging, markerName), JSON.stringify(marker, null, 2) + '\n');
  try {
    const resources = path.join(staging, 'resources');
    mkdirSync(resources);
    writeFileSync(path.join(resources, 'package.json'), '{"private":true,"type":"commonjs"}\n');
    const nativeAddon = copyNativeRuntime(resources);
    await build({
      absWorkingDir: root,
      entryPoints: { 'executable-entry': 'scripts/executable-entry.js' },
      outdir: resources,
      outExtension: { '.js': '.cjs' },
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      sourcemap: false,
      minify: false,
      legalComments: 'inline',
      external: ['sky-enet', 'bufferutil', 'utf-8-validate'],
      define: {
        __XYSKY_VERSION__: JSON.stringify(manifest.version),
        __XYSKY_EXECUTABLE__: 'true',
        // Source-only package metadata is unreachable after version inlining.
        'import.meta.url': 'undefined',
        'process.env.WS_NO_BUFFER_UTIL': '"1"',
        'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
      },
      banner: { js: "require = require('node:module').createRequire(require('node:path').join(require('node:path').dirname(process.execPath), 'resources', 'package.json'));" },
      plugins: [relocatablePinoPlugin()],
      logLevel: 'info'
    });
    for (const file of readdirSync(resources).filter(file => file.endsWith('.cjs'))) {
      const source = readFileSync(path.join(resources, file), 'utf8');
      if (source.includes('import.meta') || source.includes(staging) || source.includes(staging.replaceAll('\\', '\\\\'))) {
        throw new Error(`Non-relocatable or ESM-only code in generated ${file}`);
      }
      run(process.execPath, ['--check', path.join(resources, file)]);
    }
    writeFileSync(path.join(staging, 'config.yml'), '# yaml-language-server: $schema=./config.schema.json\n# Neutral defaults; set room.public_uri and qwd.url for your deployment.\n' + stringify(configSchema.parse({})));
    writeFileSync(path.join(staging, 'debug.yml'), '# yaml-language-server: $schema=./debug.schema.json\n# All diagnostic switches are disabled by default.\n' + stringify(debugFileSchema.parse({})));
    for (const file of ['config.schema.json', 'debug.schema.json', 'README.md', 'README_zh.md', 'LICENSE']) copy(path.join(root, file), path.join(staging, file));
    await copyNotices(staging, manifest);
    if (!args.includes('--bundle-only')) {
      const preparation = path.join(staging, '.sea-preparation');
      mkdirSync(preparation);
      const blob = path.join(preparation, 'sea-prep.blob');
      const seaConfig = path.join(preparation, 'sea-config.json');
      writeFileSync(seaConfig, JSON.stringify({ main: path.join(resources, 'executable-entry.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
      run(process.execPath, ['--experimental-sea-config', seaConfig]);
      const executable = path.join(staging, process.platform === 'win32' ? 'xysky-udp.exe' : 'xysky-udp');
      copy(process.execPath, executable);
      if (process.platform === 'win32') run(findSignTool(), ['remove', '/s', executable]);
      await inject(executable, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
      if (process.platform === 'linux') chmodSync(executable, 0o755);
      // Only our fixed preparation directory is removed, after validating ownership.
      assertRealDirectory(staging);
      if (JSON.parse(readFileSync(path.join(staging, markerName), 'utf8')).kind !== markerKind) throw new Error('Generated staging ownership marker changed');
      rmSync(preparation, { recursive: true });
      rmSync(path.join(resources, 'executable-entry.cjs'));
    }
    writeFileSync(path.join(staging, markerName), JSON.stringify({ ...marker, nativeAddon }, null, 2) + '\n');
    renameSync(staging, output);
    console.log(`Executable ${args.includes('--bundle-only') ? 'bundle' : 'release'} ready: ${output}`);
  } catch (error) {
    throw new Error(`${error.message}\nBuild staging retained for inspection: ${staging}`, { cause: error });
  }
}

await main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
