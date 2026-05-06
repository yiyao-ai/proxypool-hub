#!/usr/bin/env node

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const packOnly = args.has('--pack-only');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function fail(message) {
  console.error(`release-check failed: ${message}`);
  process.exit(1);
}

function ensure(condition, message) {
  if (!condition) fail(message);
}

function runCliVersion() {
  return execFileSync(process.execPath, ['bin/cli.js', '--version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const readmeCn = readFileSync(resolve(root, 'README_CN.md'), 'utf8');

ensure(pkg.name === lock.name, 'package-lock name does not match package.json');
ensure(pkg.version === lock.version, 'package-lock version does not match package.json');
ensure(lock.packages?.['']?.version === pkg.version, 'root package-lock entry is out of sync');
ensure(Array.isArray(pkg.files) && pkg.files.includes('bin'), '`bin` must be published');
ensure(Array.isArray(pkg.files) && pkg.files.includes('src'), '`src` must be published');
ensure(existsSync(resolve(root, 'bin/cli.js')), 'CLI entrypoint bin/cli.js is missing');
ensure(existsSync(resolve(root, '.github/workflows/build-desktop.yml')), 'build-desktop workflow is missing');
ensure(readme.includes('npm install -g cligate'), 'README.md is missing npm install instructions');
ensure(readme.includes('npx cligate@latest start'), 'README.md is missing npx instructions');
ensure(readmeCn.includes('npm install -g cligate'), 'README_CN.md is missing npm install instructions');
ensure(readmeCn.includes('npx cligate@latest start'), 'README_CN.md is missing npx instructions');

const cliVersion = runCliVersion();
ensure(cliVersion === pkg.version, `CLI --version output mismatch: expected ${pkg.version}, got ${cliVersion}`);

const npmCacheDir = resolve(root, '.tmp', 'npm-cache');
const packOutput = execSync(`npm pack --dry-run --cache "${npmCacheDir}" 2>&1`, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true
});

ensure(/npm notice\s+\d.*\sbin\/cli\.js/.test(packOutput), 'npm pack output is missing bin/cli.js');
ensure(/npm notice\s+\d.*\sREADME\.md/.test(packOutput), 'npm pack output is missing README.md');

if (!packOnly) {
  console.log(`release-check passed for ${pkg.name}@${pkg.version}`);
}
