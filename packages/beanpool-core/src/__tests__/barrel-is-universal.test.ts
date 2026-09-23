/**
 * The barrel of @beanpool/core is bundled by Metro for android and ios.
 *
 * Expo's Metro resolver shims Node built-ins on `web` only; on native it deliberately falls
 * through and errors (`withMetroMultiPlatform.js`, `requestNodeExternals`: "Preserve previous
 * behavior where native throws an error on node.js internals"), and there is no `crypto`
 * polyfill in this workspace to fall back to. So a single `import 'node:crypto'` anywhere in
 * the barrel's reachable module graph does not fail a type-check or a vitest run — both run in
 * Node — it fails `expo export`, i.e. the phone app's bundle, and nothing else notices.
 *
 * That is exactly how `avatar-url.ts` shipped a `node:crypto` import into a PR that was green.
 * This test walks the barrel's transitive relative imports over the SOURCE and fails on any
 * specifier Metro would treat that way, so the next one is caught by `pnpm test` rather than
 * by a build.
 *
 * The `node:` prefix is not what decides it. Expo's `isNodeExternal` STRIPS the prefix and
 * matches the bare name against its stdlib list (`@expo/cli/.../metro/externals.js`), so
 * `import crypto from 'crypto'` is the same thing to it as `node:crypto`. What then separates
 * the two is `requestNodeExternals` (`withMetroMultiPlatform.js`): for a bare name it first
 * tries an ordinary node_modules resolve, and only falls through to the native error when
 * nothing is installed under that name. A `node:`-prefixed specifier can never resolve that
 * way, so it always fails. That is exactly why `import { Buffer } from 'buffer'` is fine here
 * and `node:buffer` would not be — `buffer` is a real dependency of this package.
 *
 * So the rule below is: any `node:` specifier, plus any BARE builtin name with no installed
 * package to resolve to.
 *
 * Universal replacements already in use here: `@noble/hashes` for digests, `@noble/curves`,
 * `@noble/ciphers`, and the `buffer` package (a real dependency, shimmed on native) for Buffer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is a Node test ABOUT the barrel, not part of it, so its own `node:` imports are
// fine — nothing bundles them for a phone.

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `from '…'` / `import('…')` specifier in a module, static or dynamic, import or re-export. */
function specifiersOf(source: string): string[] {
    const found: string[] = [];
    // `import … from 'x'`, `export … from 'x'`, and bare `import 'x'`.
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
        found.push(m[1]);
    }
    for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
        found.push(m[1]);
    }
    // `await import('x')` / `import('x')`.
    for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        found.push(m[1]);
    }
    return found;
}

/** Resolve a relative `./foo.js` specifier back to the `./foo.ts` it is compiled from. */
function resolveRelative(fromFile: string, specifier: string): string | null {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, base]) {
        if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
    }
    return null;
}

/** Every source module reachable from the barrel by relative imports, the barrel included. */
function barrelModuleGraph(): Map<string, string> {
    const modules = new Map<string, string>();
    const queue = [resolve(SRC_DIR, 'index.ts')];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (modules.has(file)) continue;
        const source = readFileSync(file, 'utf8');
        modules.set(file, source);
        for (const specifier of specifiersOf(source)) {
            if (!specifier.startsWith('.')) continue;
            const next = resolveRelative(file, specifier);
            if (next && !modules.has(next)) queue.push(next);
        }
    }
    return modules;
}

const BUILTIN_NAMES = new Set(builtinModules);
const requireFromHere = createRequire(import.meta.url);

/**
 * Is there a real installed package under this name for Metro's optional resolve to find?
 *
 * Asked as `<name>/package.json`, because a bare `require.resolve('buffer')` answers with
 * Node's own builtin and would call every builtin installed. A subpath request is never
 * treated as a builtin, so it can only be satisfied from node_modules.
 */
function hasInstalledPackage(name: string): boolean {
    try {
        requireFromHere.resolve(`${name}/package.json`);
        return true;
    } catch { /* no package.json export, or no package — fall through */ }
    try {
        // A package that hides its package.json behind `exports` still resolves by name, and
        // the resolved path tells us it came from node_modules rather than from Node itself.
        return requireFromHere.resolve(name).includes(`${sep}node_modules${sep}`);
    } catch {
        return false;
    }
}

/** Specifiers in one module's source that `expo export` would fail on for android/ios. */
function nodeImportsIn(source: string): string[] {
    return specifiersOf(source).filter((s) => {
        if (s.startsWith('node:')) return true;
        return BUILTIN_NAMES.has(s) && !hasInstalledPackage(s);
    });
}

describe('the @beanpool/core barrel stays bundleable by Metro', () => {
    const graph = barrelModuleGraph();

    it('reaches the modules it re-exports', () => {
        // A sanity check on the walk itself: if the graph came back tiny, the assertion below
        // would pass by finding nothing rather than by there being nothing to find.
        expect(graph.size).toBeGreaterThan(20);
        expect([...graph.keys()].some((f) => f.endsWith('avatar-url.ts'))).toBe(true);
    });

    it('has no Node built-in import in any module the barrel exports', () => {
        const offenders: string[] = [];
        for (const [file, source] of graph) {
            for (const specifier of nodeImportsIn(source)) {
                offenders.push(`${file.slice(SRC_DIR.length + 1)} imports ${specifier}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('detects a `node:` import when there is one (the guard bites)', () => {
        // Proves the detector, not the current tree: the exact line avatar-url.ts shipped with.
        expect(nodeImportsIn("import crypto from 'node:crypto';")).toEqual(['node:crypto']);
        expect(nodeImportsIn("import { readFileSync } from 'node:fs';")).toEqual(['node:fs']);
        expect(nodeImportsIn("export { x } from 'node:os';")).toEqual(['node:os']);
        expect(nodeImportsIn("import 'node:process';")).toEqual(['node:process']);
        expect(nodeImportsIn("const { createHash } = await import('node:crypto');")).toEqual(['node:crypto']);
        expect(nodeImportsIn("import { sha256 } from '@noble/hashes/sha2.js';")).toEqual([]);
    });

    it('bites on a BARE built-in too — Expo strips the prefix before matching', () => {
        // The gap the confirmation review found: `crypto` and `fs` fail `expo export` on
        // android/ios exactly as `node:crypto` did, and the prefix-only guard waved them past.
        expect(nodeImportsIn("import crypto from 'crypto';")).toEqual(['crypto']);
        expect(nodeImportsIn("import { readFileSync } from 'fs';")).toEqual(['fs']);
        expect(nodeImportsIn("export { x } from 'os';")).toEqual(['os']);
        expect(nodeImportsIn("const { createHash } = await import('crypto');")).toEqual(['crypto']);
    });

    it('allows a built-in NAME that a real installed package answers to', () => {
        // `buffer` is a dependency of this package, so Metro's optional resolve finds it and
        // the bundle is fine — which is why six modules in the barrel import it today. The
        // prefixed form has no such escape: nothing resolves `node:buffer` from node_modules.
        expect(hasInstalledPackage('buffer')).toBe(true);
        expect(nodeImportsIn("import { Buffer } from 'buffer';")).toEqual([]);
        expect(nodeImportsIn("import { Buffer } from 'node:buffer';")).toEqual(['node:buffer']);
        // …and the names that bite are exactly the ones with nothing installed under them.
        expect(hasInstalledPackage('crypto')).toBe(false);
        expect(hasInstalledPackage('fs')).toBe(false);
    });

    it('leaves ordinary package names alone', () => {
        expect(nodeImportsIn("import { x } from '@beanpool/engine';")).toEqual([]);
        expect(nodeImportsIn("import bs58 from 'bs58';")).toEqual([]);
        expect(nodeImportsIn("import { z } from './local.js';")).toEqual([]);
    });
});
