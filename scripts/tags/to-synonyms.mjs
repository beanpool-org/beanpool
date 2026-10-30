#!/usr/bin/env node
// to-synonyms.mjs — makes packages/beanpool-core/src/synonyms.ts from the tag library (DESIGN-owner-seeding-tags-fable.md §4.6).
//
//   node scripts/tags/to-synonyms.mjs           writes synonyms.ts
//   node scripts/tags/to-synonyms.mjs --check   exits 1 when synonyms.ts is not what the library makes
//
// Each synonym key a tag carries (`synonymKeys`) maps to the words of the tag and of every tag above it, then the tag's
// aliases, without the key itself: "lemon" on food.fruit.lemon → food, fruit, produce, citrus, tree. So searchTermsFor and
// the node's keyword builder find what they found before the library. Only tags with synonymKeys are written: a tag new to
// the library reaches search through T2 (the node reads the library), never by growing this map. The map goes after two
// app releases (§4.6); core's tags-library test makes the same map and checks this file is in step.
//
// It reads library.ts with the TypeScript the repo already has (as scripts/words/words.mjs reads core), so it never needs
// a built dist.

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIBRARY = path.join(ROOT, 'packages/beanpool-core/src/tags/library.ts');
const OUT = path.join(ROOT, 'packages/beanpool-core/src/synonyms.ts');

export async function loadLibrary() {
    const source = fs.readFileSync(LIBRARY, 'utf8')
        // word() is the identity on its English (with the context after \u0004); the map needs only ids and English words.
        .replace(/^import \{[^}]*\} from '\.\.\/words\.js';$/m, "const word = (s, c) => (c ? s + '\\u0004' + c : s);");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
    const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    return mod.TAG_LIBRARY;
}

/** The synonym map the library makes: key → the words of its tag and the tags above it, then its aliases, less the key. */
export function synonymMap(library) {
    const byId = new Map(library.map((t) => [t.id, t]));
    const map = {};
    for (const tag of library) {
        if (!tag.synonymKeys?.length) continue;
        const parts = tag.id.split('.');
        const chain = parts.map((_, i) => byId.get(parts.slice(0, i + 1).join('.')));
        const all = [...new Set([...chain.flatMap((t) => t?.words ?? []), ...(tag.aliases ?? [])])];
        for (const key of tag.synonymKeys) map[key] = all.filter((w) => w !== key);
    }
    return map;
}

export function render(map) {
    const lines = Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: [${v.map((w) => JSON.stringify(w)).join(', ')}],`);
    return `/**
 * BeanPool Marketplace synonym map: maps specific items to broader search terms so searches for "lemon" also match
 * "fruit", "citrus", "produce", etc.
 *
 * GENERATED from the tag library (src/tags/library.ts) by scripts/tags/to-synonyms.mjs: never edit it by hand. Change
 * the library and run the script. It goes once the node and the apps read the library directly (tags slices T2, T3).
 */

export const SYNONYM_MAP: Record<string, string[]> = {
${lines.join('\n')}
};

export default SYNONYM_MAP;
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const text = render(synonymMap(await loadLibrary()));
    if (process.argv.includes('--check')) {
        if (fs.readFileSync(OUT, 'utf8') !== text) {
            console.error('synonyms.ts is not what the tag library makes: run node scripts/tags/to-synonyms.mjs');
            process.exit(1);
        }
        console.log('synonyms.ts matches the tag library');
    } else {
        fs.writeFileSync(OUT, text);
        console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(synonymMap(await loadLibrary())).length} keys`);
    }
}
