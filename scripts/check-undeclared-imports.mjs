#!/usr/bin/env node
//
// Undeclared-import guard for every workspace the Docker image builds.
//
// The repo's .npmrc sets node-linker=hoisted, so a bare import resolves from the root
// node_modules even when the importing package never declared it — Test-All goes green.
// The Dockerfile copies no .npmrc, so pnpm's isolated layout gives each package only its
// own declared deps and the build fails there instead. #1075 is the worked example: a
// server test file imported `multiformats/bases/base58`, apps/server had not declared it,
// and no image built for main across seven merges.
//
// So: for each package the Dockerfile builds, every bare import in its sources must be
// declared in that package's own package.json.
//
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// The hardcoded list this check started with, unioned with the running Node's own list so
// newer builtins (node:sqlite, node:test, util/types, …) are never reported as undeclared.
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises',
  'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  ...builtinModules,
]);

// The packages the Dockerfile builds, in the order it builds them. `testFilePattern`
// matches a package-relative posix path and widens what that file may import from
// `dependencies` to `dependencies` + `devDependencies` — correct only for files that
// never run in production.
const WORKSPACES = [
  {
    path: 'packages/beanpool-core',
  },
  {
    path: 'packages/beanpool-engine',
  },
  {
    path: 'apps/pwa',
  },
  {
    // Guarded first, and specifically against the workspace hoisting trap.
    path: 'apps/manager',
    enforceTypes: ['leaflet'],
  },
  {
    // The server's tsc compiles src/**/* — its test files included — so they are part of
    // the Docker build and their imports have to be declared too. The node itself never
    // runs them, so a devDependency is enough (that is where #1075 put multiformats).
    path: 'apps/server',
    testFilePattern: /(^|\/)(?:test|bench)-[^/]*$|(^|\/)__fixtures__\/|(^|\/)takeover-test-harness\.ts$/,
  },
];

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === 'dist') continue;
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

// The package a specifier resolves to: 'multiformats/bases/base58' → 'multiformats',
// '@beanpool/core/ed25519-key' → '@beanpool/core'.
function basePackageOf(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function checkWorkspace({ path: relPath, enforceTypes = [], testFilePattern = null }) {
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

  // Four shapes: a side-effect import, an import/export … from clause (which may wrap over
  // several lines), a dynamic import() and a require(), the last two with a literal only.
  //
  // The … from clause's body is `[^'"();]*?`, not `[\s\S]*?`: it still spans newlines for a
  // wrapped `import {\n  a,\n} from 'x'`, but it cannot run from an `export function foo(`
  // down into a body and match something that merely reads like one. apps/pwa has
  // `{isBuyer ? 'Bought from ' : 'Sold to '}`, whose ` from ' : '` a body of `[\s\S]*?`
  // happily reaches, reporting ' : ' as an undeclared package.
  const importRegex = /(?:^\s*import\s+['"]([^'"]+)['"]|^\s*(?:import|export)\s+(?:type\s+)?[^'"();]*?\sfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\))/gm;

  for (const file of files) {
    const wsRelative = path.relative(wsDir, file).split(path.sep).join('/');
    const isTest =
      file.includes('.test.') ||
      file.includes('__tests__') ||
      file.endsWith('setupTests.ts') ||
      (testFilePattern !== null && testFilePattern.test(wsRelative));
    const rawContent = fs.readFileSync(file, 'utf8');
    const content = stripComments(rawContent);

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1] || match[2] || match[3] || match[4];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:')) continue;

      const basePkg = basePackageOf(spec);

      if (NODE_BUILTINS.has(basePkg)) continue;

      const isTypeOnly = /^\s*(?:import\s+type|export\s+type)/.test(match[0]);
      const allowed = (isTest || isTypeOnly) ? allDeps : prodDeps;

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
for (const workspace of WORKSPACES) {
  totalErrors += checkWorkspace(workspace);
}

if (totalErrors > 0) {
  console.error(`\nFound ${totalErrors} undeclared import violation(s).`);
  process.exit(1);
}

console.log('✓ All workspace import boundaries verified.');
process.exit(0);
