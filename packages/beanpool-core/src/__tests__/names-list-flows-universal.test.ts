/**
 * The names list's shared flows are the same code on the phone and in the web app (DESIGN-names-list-web-fable.md S1, its
 * test "the module imports nothing from react-native, expo-* or the web"). A device's own modules come in only through
 * NamesPlatform (its store, its signed request, its address, its word), never by an import: one `import … from
 * 'expo-secure-store'` here would load on the phone and fail in the web app's bundle, and one from the web app's
 * IndexedDB code would do the reverse. Type checks and vitest run in Node and notice neither.
 *
 * This walks every module the four shared files reach by relative imports, over the SOURCE, and fails on any import of
 * react-native, @react-native/*, @react-native-async-storage/*, expo or expo-*, @expo/*, the web app (apps/pwa, by path
 * or by package name), or any path that leaves this package. The last test proves the detector bites.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = resolve(SRC_DIR, '..');
/** The shared modules S1 moved out of the phone (apps/native/utils/names-list.ts, community-health.ts, names-invite.ts, names-debts.ts). */
const SHARED = ['names-list-flows.ts', 'names-list-health.ts', 'names-list-invite.ts', 'names-list-debts.ts'];

/** Every `from '…'` / bare `import '…'` / `import('…')` / `require('…')` specifier in a module. */
function specifiersOf(source: string): string[] {
    const found: string[] = [];
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
    return found;
}

/** Why `specifier`, imported from `fromFile`, belongs to a device and not to the shared flows; null when it doesn't. */
function deviceImport(fromFile: string, specifier: string): string | null {
    if (/^react-native(\/|$)/.test(specifier) || /^@react-native(-[a-z-]+)?\//.test(specifier)) return 'react-native';
    if (/^expo(-[a-z0-9-]+)?(\/|$)/.test(specifier) || /^@expo\//.test(specifier)) return 'expo';
    if (/(^|\/)apps\/pwa(\/|$)/.test(specifier) || /^@beanpool\/pwa(\/|$)/.test(specifier)) return 'the web app';
    if (specifier.startsWith('.') && !resolve(dirname(fromFile), specifier).startsWith(PACKAGE_DIR + sep)) return 'outside @beanpool/core';
    return null;
}

/** A relative `./foo.js` back to the `./foo.ts` it is compiled from. */
function resolveRelative(fromFile: string, specifier: string): string | null {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, base]) {
        if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
    }
    return null;
}

/** The shared modules and every source module they reach by relative imports. */
function sharedGraph(): Map<string, string> {
    const modules = new Map<string, string>();
    const queue = SHARED.map((f) => resolve(SRC_DIR, f));
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

/** Each device import in `source` (as if it were `file`), as "file imports x (why)". */
function offendersIn(file: string, source: string): string[] {
    return specifiersOf(source).flatMap((s) => {
        const why = deviceImport(file, s);
        return why ? [`${file.slice(SRC_DIR.length + 1)} imports ${s} (${why})`] : [];
    });
}

describe('the names list\'s shared flows import nothing of a device\'s own', () => {
    const graph = sharedGraph();

    it('reaches the shared modules and what they import (the walk finds something to check)', () => {
        for (const f of SHARED) expect(graph.has(resolve(SRC_DIR, f)), f).toBe(true);
        expect(graph.has(resolve(SRC_DIR, 'names-list-trust.ts'))).toBe(true);
        expect(graph.has(resolve(SRC_DIR, 'names-list-crypto.ts'))).toBe(true);
        expect(graph.size).toBeGreaterThan(SHARED.length + 2);
    });

    it('no module they reach imports react-native, expo, the web app, or anything outside this package', () => {
        const offenders = [...graph].flatMap(([file, source]) => offendersIn(file, source));
        expect(offenders).toEqual([]);
    });

    it('the detector bites: each kind of device import is found (the guard can fail)', () => {
        const file = resolve(SRC_DIR, 'names-list-flows.ts');
        const planted = [
            "import * as SecureStore from 'expo-secure-store';",
            "import AsyncStorage from '@react-native-async-storage/async-storage';",
            "import { Platform } from 'react-native';",
            "import { getRandomBytes } from 'expo-crypto';",
            "import Constants from 'expo';",
            "import { openDB } from '../../../apps/pwa/src/lib/identity';",
            "export { buildSignedHeaders } from '../../../apps/native/utils/crypto';",
            "const store = require('@react-native-async-storage/async-storage');",
        ];
        for (const line of planted) expect(offendersIn(file, `${line}\n`), line).toHaveLength(1);
        // And what the shared modules do import passes.
        expect(offendersIn(file, "import { bytesToHex } from '@noble/hashes/utils.js';\nimport { syncNames } from './names-list-trust.js';\n")).toEqual([]);
    });
});
