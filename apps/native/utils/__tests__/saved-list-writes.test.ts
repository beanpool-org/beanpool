/**
 * A community comes off the phone's saved list one way only, and its record goes with it (addresses S3, #3227's deciding
 * review: "Delete here" and the update block's two Leave paths wrote the list directly, so the record they left behind
 * stayed on the phone for good).
 *
 * The rule: the saved list (storage-keys.ts SAVED_NODES_STORE_KEY) is written in the places below and nowhere else.
 * Taking a row off is nodes.ts `takeOffSavedList`, which forgets the record of every row it takes; the whole list goes
 * only as an account leaves the phone (account-leaves-phone.ts `forgetCommunities`), with every record. Any other code
 * under apps/native that names the list for anything but a read fails here, whatever it writes with: setItem,
 * removeItem, multiSet, the key held in another name, or the key's text itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const NATIVE = join(__dirname, '..', '..');
const KEY = 'SAVED_NODES_STORE_KEY';
const KEY_TEXT = 'beanpool_saved_nodes';

/** Every write of the saved list there may be, as `file function`, and what each one is. */
const WRITES: Record<string, string> = {
    'utils/nodes.ts getSavedNodes': 'adds the community the phone is set to',
    'utils/nodes.ts addSavedNode': 'adds a community, and makes its record',
    'utils/nodes.ts takeOffSavedList': 'the one way a row comes off, with its record',
    'utils/account-leaves-phone.ts forgetCommunities': 'the account leaves the phone: the list goes, with every record',
};

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'e2e', 'android', 'ios', 'dist', 'build', 'coverage']);

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sources(path, out);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
    }
    return out;
}

/** Comments out, so a sentence that names the list is no write. A `//` after `:` (an address) is no comment. */
function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Imports and re-exports name the key without using it: blanked, so every index stays where it was. */
function withoutImports(src: string): string {
    return src.replace(/(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, (s) => ' '.repeat(s.length));
}

/**
 * Where `src` (comments and imports out) names the key for anything but a read. A read is the key alone as the
 * argument of `getItem(...)` or of a `read(...)` that wraps it; the key's own definition in storage-keys.ts is no use.
 */
function writesIn(src: string): number[] {
    return [...src.matchAll(new RegExp(`\\b${KEY}\\b`, 'g'))].map((m) => m.index!).filter((i) => {
        const before = src.slice(Math.max(0, i - 40), i);
        const after = src.slice(i + KEY.length, i + KEY.length + 3);
        if (/\b(?:getItem|read)\(\s*$/.test(before) && /^\s*\)/.test(after)) return false;
        return !/^export const\s+$/.test(src.slice(src.lastIndexOf('\n', i) + 1, i));
    });
}

/** The top-level function `index` sits in: the last one declared before it whose body hasn't closed yet. */
function enclosingFunction(src: string, index: number): string {
    let name = '(top level)';
    for (const m of src.slice(0, index).matchAll(/^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)\s*[(<]|const\s+(\w+)\s*=\s*(?:async\s*)?\()/gm)) {
        const end = src.indexOf('\n}', m.index!);
        if (end === -1 || end > index) name = m[1] ?? m[2];
    }
    return name;
}

/** The body of `fn` in `src`: from its declaration to the next closing brace at the start of a line. */
function bodyOf(src: string, fn: string): string {
    const start = src.search(new RegExp(`function\\s+${fn}\\s*\\(`));
    expect(start, `${fn} is declared`).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n}', start) + 2);
}

interface Use { where: string; line: string }

function scan(): { writes: Use[]; keyText: Use[] } {
    const writes: Use[] = [];
    const keyText: Use[] = [];
    for (const path of sources(NATIVE)) {
        const file = relative(NATIVE, path).split(sep).join('/');
        const src = withoutImports(code(readFileSync(path, 'utf8')));
        const lineAt = (i: number) => src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i) === -1 ? undefined : src.indexOf('\n', i)).trim();
        for (const m of src.matchAll(new RegExp(KEY_TEXT, 'g'))) {
            if (file === 'utils/storage-keys.ts' && lineAt(m.index!) === `export const ${KEY} = '${KEY_TEXT}';`) continue;
            keyText.push({ where: `${file} ${enclosingFunction(src, m.index!)}`, line: lineAt(m.index!) });
        }
        for (const i of writesIn(src)) writes.push({ where: `${file} ${enclosingFunction(src, i)}`, line: lineAt(i) });
    }
    return { writes, keyText };
}

describe('the saved list is written in one place per job, and a row comes off it one way', () => {
    const { writes, keyText } = scan();

    it('finds the writes it is meant to police, and no other', () => {
        const unknown = writes.filter((w) => !(w.where in WRITES));
        expect(unknown, `the saved list is written outside the places allowed. Take a row off with nodes.ts takeOffSavedList, which takes its record too:\n${unknown.map((w) => `  ${w.where}: ${w.line}`).join('\n')}`).toEqual([]);
        expect([...new Set(writes.map((w) => w.where))].sort()).toEqual(Object.keys(WRITES).sort());
    });

    it('nobody spells the key out to get round the rule', () => {
        expect(keyText, keyText.map((w) => `  ${w.where}: ${w.line}`).join('\n')).toEqual([]);
    });

    it('a row taken off takes its record; removeSavedNode goes through it; the whole list goes with every record', () => {
        const nodes = code(readFileSync(join(NATIVE, 'utils', 'nodes.ts'), 'utf8'));
        const takeOff = bodyOf(nodes, 'takeOffSavedList');
        expect(takeOff).toMatch(/storage\.setItem\(SAVED_NODES_STORE_KEY,/);
        expect(takeOff).toMatch(/finally\s*\{[\s\S]*forgetCommunityRecord\(/);
        expect(bodyOf(nodes, 'removeSavedNode')).toMatch(/await takeOffSavedList\(url\)/);
        const leaves = code(readFileSync(join(NATIVE, 'utils', 'account-leaves-phone.ts'), 'utf8'));
        expect(bodyOf(leaves, 'forgetCommunities')).toMatch(/removeItem\(SAVED_NODES_STORE_KEY\);\s*await forgetEveryCommunityRecord\(/);
    });

    it('the rule can fail: a direct write, a key held in another name, a batch and a spelled-out key are each caught', () => {
        const uses = (src: string) => writesIn(withoutImports(code(src))).length;
        expect(uses(`import { ${KEY} } from './storage-keys';\nconst raw = await storage.getItem(${KEY});`)).toBe(0);
        expect(uses(`const raw = parseList(await read(${KEY}));`)).toBe(0);
        expect(uses(`// await storage.setItem(${KEY}, '[]')`)).toBe(0);
        expect(uses(`await storage.setItem(${KEY}, JSON.stringify(kept));`)).toBe(1);
        expect(uses(`for (const [key] of [[${KEY}, 1]]) await storage.setItem(key, '[]');`)).toBe(1);
        expect(uses(`const listKey = ${KEY};`)).toBe(1);
        expect(uses(`await storage.multiRemove([${KEY}]);`)).toBe(1);
        expect(code(`await storage.removeItem('${KEY_TEXT}'); // https://riverside.example`)).toContain(KEY_TEXT);
        const src = 'export async function a() {\n    const isHere = (u: unknown) => u === 1;\n    x();\n}\nconst y = 1; setItem(K);\n';
        expect(enclosingFunction(src, src.indexOf('x()'))).toBe('a');
        expect(enclosingFunction(src, src.indexOf('setItem'))).toBe('(top level)');
    });
});
