#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises',
  'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(walk(full));
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) {
      results.push(full);
    }
  }
  return results;
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function checkWorkspace(relPath, { enforceTypes = [] } = {}) {
  const wsDir = path.join(REPO_ROOT, relPath);
  const pkgJsonPath = path.join(wsDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error(`Missing package.json at ${pkgJsonPath}`);
    return 1;
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const prodDeps = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
  ]);
  const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));
  const allDeps = new Set([...prodDeps, ...devDeps]);

  const srcDir = path.join(wsDir, 'src');
  const files = walk(srcDir);
  const errors = [];

  const importRegex = /^\s*(?:import\s+(?:(?:type\s+)?[\s\S]*?from\s+)?['"]([^'"]+)['"]|export\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(['"]([^'"]+)['"]\))/gm;

  for (const file of files) {
    const isTest = file.includes('.test.') || file.includes('__tests__') || file.endsWith('setupTests.ts');
    const allowed = isTest ? allDeps : prodDeps;
    const rawContent = fs.readFileSync(file, 'utf8');
    const content = stripComments(rawContent);

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1] || match[2] || match[3];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:')) continue;

      let basePkg = spec;
      if (spec.startsWith('@')) {
        basePkg = spec.split('/').slice(0, 2).join('/');
      } else {
        basePkg = spec.split('/')[0];
      }

      if (NODE_BUILTINS.has(basePkg)) continue;

      if (!allowed.has(basePkg)) {
        errors.push({
          file: path.relative(REPO_ROOT, file),
          spec,
          basePkg,
          isTest,
          type: 'undeclared_dependency',
        });
      }
    }
  }

  for (const pkg of enforceTypes) {
    if (prodDeps.has(pkg) || devDeps.has(pkg)) {
      const typePkg = `@types/${pkg}`;
      if (!devDeps.has(typePkg) && !prodDeps.has(typePkg)) {
        errors.push({
          file: path.relative(REPO_ROOT, pkgJsonPath),
          spec: typePkg,
          basePkg: typePkg,
          isTest: false,
          type: 'missing_types',
        });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`❌ Undeclared imports found in ${relPath}:`);
    for (const err of errors) {
      if (err.type === 'missing_types') {
        console.error(`  - ${err.basePkg} missing from devDependencies in ${err.file}`);
      } else {
        const targetSection = err.isTest ? 'dependencies or devDependencies' : 'dependencies';
        console.error(`  - [${err.isTest ? 'TEST' : 'PROD'}] '${err.spec}' in ${err.file} (must be declared in ${targetSection})`);
      }
    }
    return errors.length;
  }

  console.log(`✓ ${relPath}: all imports declared in package.json`);
  return 0;
}

let totalErrors = 0;
// Check apps/manager (specifically guarded against workspace hoisting traps)
totalErrors += checkWorkspace('apps/manager', { enforceTypes: ['leaflet'] });

if (totalErrors > 0) {
  console.error(`\nFound ${totalErrors} undeclared import violation(s).`);
  process.exit(1);
}

console.log('✓ All workspace import boundaries verified.');
process.exit(0);
