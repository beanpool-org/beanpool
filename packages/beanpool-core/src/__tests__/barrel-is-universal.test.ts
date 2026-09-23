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
 * `node:` specifier it finds, so the next one is caught by `pnpm test` rather than by a build.
 *
 * Universal replacements already in use here: `@noble/hashes` for digests, `@noble/curves`,
 * `@noble/ciphers`, and the `buffer` package (a real dependency, shimmed on native) for Buffer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** `node:*` specifiers in one module's source. */
function nodeImportsIn(source: string): string[] {
    return specifiersOf(source).filter((s) => s.startsWith('node:'));
}

describe('the @beanpool/core barrel stays bundleable by Metro', () => {
    const graph = barrelModuleGraph();

    it('reaches the modules it re-exports', () => {
        // A sanity check on the walk itself: if the graph came back tiny, the assertion below
        // would pass by finding nothing rather than by there being nothing to find.
        expect(graph.size).toBeGreaterThan(20);
        expect([...graph.keys()].some((f) => f.endsWith('avatar-url.ts'))).toBe(true);
    });

    it('has no `node:` import in any module the barrel exports', () => {
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
});
