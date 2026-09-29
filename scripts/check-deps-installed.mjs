#!/usr/bin/env node
/**
 * Fails fast when node_modules is older than the package.json files: a declared dependency that is not installed.
 *
 * WHY. When a merged PR adds a dependency, anyone who pulls without reinstalling gets "Cannot find module 'x'" from
 * tsc, vitest and the server suites. That reads like broken code, and test-all is now the merge gate, so it has to say
 * what is actually wrong: the install is stale. A new git worktree has no node_modules at all, which is the same fix.
 *
 * It only asks whether each declared package is installed somewhere this workspace resolves it from. It says nothing
 * about versions: a package installed at another version still resolves, and `pnpm install` is the tool for that.
 *
 * WHERE A PACKAGE MAY BE. .npmrc sets node-linker=hoisted, so pnpm puts every package in the root node_modules, and a
 * second version one workspace needs beside that workspace, in <workspace>/node_modules.
 *
 * Usage: node scripts/check-deps-installed.mjs [repo root]   (the root argument is for its own test)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');

/** The workspace globs in pnpm-workspace.yaml, each `dir/*` or a plain dir, plus the root itself. */
function workspaces() {
    const dirs = ['.'];
    let yaml = '';
    try { yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'); } catch { return dirs; }
    for (const m of yaml.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)) {
        const glob = m[1];
        if (glob.startsWith('!')) continue;
        if (glob.endsWith('/*')) {
            const parent = glob.slice(0, -2);
            let names = [];
            try { names = readdirSync(join(repoRoot, parent), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
            for (const name of names) dirs.push(join(parent, name));
        } else {
            dirs.push(glob);
        }
    }
    return dirs.filter((d) => existsSync(join(repoRoot, d, 'package.json')));
}

const missing = new Map(); // workspace -> [names]

for (const ws of workspaces()) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, ws, 'package.json'), 'utf8'));
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const [name, range] of Object.entries(declared)) {
        // A workspace or local-path dependency is linked by pnpm itself; an optional one may be absent on this platform.
        if (typeof range === 'string' && /^(workspace:|file:|link:|portal:)/.test(range)) continue;
        if (manifest.optionalDependencies?.[name]) continue;
        const found = [join(repoRoot, ws, 'node_modules'), join(repoRoot, 'node_modules')]
            .some((dir) => existsSync(join(dir, name, 'package.json')));
        if (!found) {
            if (!missing.has(ws)) missing.set(ws, []);
            missing.get(ws).push(name);
        }
    }
}

if (missing.size === 0) process.exit(0);

const count = [...missing.values()].reduce((n, names) => n + names.length, 0);
const nothingInstalled = !existsSync(join(repoRoot, 'node_modules'));
const MAX_LISTED = 8;

console.error('');
console.error(nothingInstalled
    ? '❌ STALE INSTALL: nothing is installed here, so nothing was tested. Run: pnpm install'
    : '❌ STALE INSTALL: run pnpm install. Nothing was tested; this is not broken code.');
console.error('');
if (nothingInstalled) {
    console.error(`   No node_modules at ${relative(process.cwd(), repoRoot) || '.'} (${count} declared packages missing). A fresh clone or a new git worktree starts this way.`);
} else {
    console.error(`   ${count} package(s) declared in a package.json are not installed:`);
    for (const [ws, names] of missing) {
        const sorted = names.sort();
        console.error(`     ${ws === '.' ? 'package.json' : `${ws}/package.json`}: ${sorted.slice(0, MAX_LISTED).join(', ')}${sorted.length > MAX_LISTED ? `, … and ${sorted.length - MAX_LISTED} more` : ''}`);
    }
    console.error('');
    console.error('   That almost always means a merged PR added a dependency after this install. Running the checks now would');
    console.error('   report "Cannot find module" errors that look like broken code but are not.');
}
console.error('');
console.error('   Fix: pnpm install   (from the repo root)');
console.error('');
process.exit(1);
