/**
 * ONE function writes the phone's community address (`beanpool_anchor_url`): community-move-lock.ts writeCommunityAddress,
 * which runs only inside the one move lock (addresses S5 round 2, PR #3251's deciding review: four member moves waited in
 * closeDB and then wrote the address outside the lock, so the address check could put the phone back into the community
 * just left). Every member move calls it.
 *
 * This reads the app's source and fails on any other write or removal of the address: by its name, through a constant
 * that holds it, inside a multiSet / multiRemove, or a storage `clear()` that would take it with everything else. The
 * allow-list is EMPTY: the one writer's module is the only place a write may sit, and inside it only the writer itself.
 * Nothing here runs the app; address-verify.test.ts runs every member move against a round in flight.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components', 'utils', 'services', 'modules', 'hooks', 'constants', 'tools'];
const LOCK_MODULE = 'utils/community-move-lock.ts';
/** Files other than the lock module allowed to write the address: none. */
const ALLOWED: readonly string[] = [];

/** The source without comments, so a comment can neither hide nor fake a write. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
                walk(full);
            } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
                out.push(full);
            }
        }
    };
    for (const d of DIRS) walk(path.join(NATIVE, d));
    return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every write of the address in `src` (comments stripped): where it starts, and its text. */
function addressWrites(src: string): Array<{ at: number; text: string }> {
    const constants = [...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*string\s*)?=\s*['"`]beanpool_anchor_url['"`]/g)].map((m) => m[1]);
    const names = ["'beanpool_anchor_url'", '"beanpool_anchor_url"', '`beanpool_anchor_url`', ...constants].map(escape);
    const found: Array<{ at: number; text: string }> = [];
    const single = new RegExp(`\\b(?:setItem|removeItem|mergeItem)\\(\\s*(?:${names.join('|')})(?![\\w$])`, 'g');
    for (const m of src.matchAll(single)) found.push({ at: m.index!, text: m[0] });
    // A many-key write: the address among its keys (the call's own parentheses, nested ones included).
    for (const m of src.matchAll(/\b(?:multiSet|multiRemove|multiMerge)\(/g)) {
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (; end < src.length; end++) {
            if (src[end] === '(') depth++;
            else if (src[end] === ')' && --depth === 0) break;
        }
        const args = src.slice(m.index!, end + 1);
        // A key among them, not one read inside them (`getItem('beanpool_anchor_url')` to name another key).
        if (new RegExp(`(?<!getItem\\(\\s*)(?:${names.join('|')})(?![\\w$])`).test(args)) found.push({ at: m.index!, text: args.slice(0, 80) });
    }
    // Everything at once, the address with it.
    for (const m of src.matchAll(/\bAsyncStorage\s*\.\s*clear\(/g)) found.push({ at: m.index!, text: m[0] });
    return found;
}

describe('the phone\'s community address has ONE writer, and it runs inside the move lock', () => {
    it('the scan catches every way of writing it (a check that can fail)', () => {
        const planted = [
            "await AsyncStorage.setItem('beanpool_anchor_url', url);",
            'await AsyncStorage.setItem("beanpool_anchor_url", url);',
            "await storage.removeItem('beanpool_anchor_url');",
            "const ANCHOR_STORE_KEY = 'beanpool_anchor_url';\nawait deps.storage.setItem(ANCHOR_STORE_KEY, url);",
            "const OPEN = 'beanpool_anchor_url';\nawait AsyncStorage.multiRemove(['a', OPEN, 'b']);",
            "await AsyncStorage.multiSet([['beanpool_anchor_url', url]]);",
            'await AsyncStorage.clear();',
        ];
        for (const src of planted) expect(addressWrites(code(src)), src).toHaveLength(1);
        // Reads, other keys, a key that only starts with the name, and comments are not writes.
        const clean = [
            "await AsyncStorage.getItem('beanpool_anchor_url');",
            "await AsyncStorage.setItem('beanpool_anchor_url_seen', '1');",
            "const ANCHOR_STORE_KEY = 'beanpool_anchor_url';\nawait storage.setItem(ANCHOR_STORE_KEY_OLD, url);",
            "await AsyncStorage.multiRemove(['pillar:anchor-url']);",
            "await AsyncStorage.multiRemove(cursorKeysOf(fileFor(await AsyncStorage.getItem('beanpool_anchor_url'))));",
            "// await AsyncStorage.setItem('beanpool_anchor_url', url);",
            "/* storage.removeItem('beanpool_anchor_url') */",
        ];
        for (const src of clean) expect(addressWrites(code(src)), src).toEqual([]);
    });

    it('no file but the lock module writes it (allow-list empty)', () => {
        const outside: string[] = [];
        let scanned = 0;
        for (const full of sourceFiles()) {
            const rel = path.relative(NATIVE, full);
            scanned++;
            if (rel === LOCK_MODULE) continue;
            const src = code(fs.readFileSync(full, 'utf8'));
            for (const w of addressWrites(src)) {
                if (ALLOWED.includes(rel)) continue;
                outside.push(`${rel}:${src.slice(0, w.at).split('\n').length} ${w.text}`);
            }
        }
        expect(scanned).toBeGreaterThan(300);
        expect(outside).toEqual([]);
        expect(ALLOWED).toEqual([]);
    });

    it('inside the lock module, only writeCommunityAddress writes it, after it refuses a write outside a move and an address that isn\'t plain', () => {
        const src = code(fs.readFileSync(path.join(NATIVE, LOCK_MODULE), 'utf8'));
        const start = src.indexOf('export async function writeCommunityAddress(');
        const end = src.indexOf('\n}\n', start);
        expect(start).toBeGreaterThan(0);
        const writes = addressWrites(src);
        // Through its one constant: a set and a removal, both inside the writer.
        expect(writes.map((w) => w.text.replace(/\s+/g, '')).sort()).toEqual(['removeItem(ANCHOR_KEY', 'setItem(ANCHOR_KEY']);
        for (const w of writes) expect(w.at > start && w.at < end, w.text).toBe(true);
        const body = src.slice(start, end);
        // Its first step: no move under way (or a proof that isn't the lock's) throws before anything is written.
        expect(body).toMatch(/\{\s*if \(held !== HELD \|\| !moving\) throw new Error\(/);
        expect(body.indexOf('assertPlainNodeAddress(url)')).toBeGreaterThan(body.indexOf('!moving'));
        expect(body.indexOf('assertPlainNodeAddress(url)')).toBeLessThan(Math.min(...writes.map((w) => w.at - start)));
        // `moving` is set only by whileCommunityMoves, around its task.
        expect([...src.matchAll(/\bmoving = (true|false)/g)].map((m) => m[1])).toEqual(['false', 'true', 'false']);
        expect(src).toMatch(/moving = true;\s*try \{\s*return await task\(HELD\);\s*\} finally \{\s*moving = false;\s*\}/);
        // Only the lock makes the proof: it is never exported, and its type can't be written by hand elsewhere.
        expect(src).not.toMatch(/export\s+(const|let)\s+HELD/);
        expect(src).toMatch(/declare const heldMark: unique symbol;/);
    });

    it('every member move reaches the writer: the files that move the phone each call it (or the one switch)', () => {
        const callers = sourceFiles()
            .map((f) => [path.relative(NATIVE, f), code(fs.readFileSync(f, 'utf8'))] as const)
            .filter(([rel, src]) => rel !== LOCK_MODULE && /\b(writeCommunityAddress|moveCommunityAddress)\(/.test(src))
            .map(([rel]) => rel)
            .sort();
        // Each place that used to write the address itself (PR #3251 round 2's list, and the rest the sweep found).
        expect(callers).toEqual([
            'app/(tabs)/people.tsx',
            'app/(tabs)/settings.tsx',
            'app/_layout.tsx',
            'app/claim-community.tsx',
            'app/rekey-code.tsx',
            'app/welcome.tsx',
            'services/pillar-sync.ts',
            'utils/claim-key.ts',
            'utils/delete-here.ts',
            'utils/global-join-existing.ts',
            'utils/identity.ts',
            'utils/join-another-community.ts',
            'utils/knock-key.ts',
            'utils/open-door-key.ts',
            'utils/reconnect.ts',
            'utils/restore-account.ts',
            'utils/update-block-escape.ts',
        ]);
        // A move that closes or clears the copy does it inside the same move as the write: the close, then the write.
        for (const rel of callers) {
            const src = code(fs.readFileSync(path.join(NATIVE, rel), 'utf8'));
            for (const m of src.matchAll(/whileCommunityMoves\(async \(held\) => \{([\s\S]*?)\n\s*\}\);/g)) {
                const inside = m[1];
                if (!/writeCommunityAddress\(held,/.test(inside)) continue;
                const close = inside.search(/\b(closeDB|clearDB|removeCommunityCaches)\(/);
                if (close >= 0) expect(close, `${rel}: the copy closes inside the move, before the write`).toBeLessThan(inside.indexOf('writeCommunityAddress('));
            }
            // And nowhere does a close of the copy come right before a write made outside a move.
            expect(src, rel).not.toMatch(/await (deps\.|db\.)?(closeDB|clearDB)\(\);\s*await moveCommunityAddress\(/);
        }
        // Settings' saved-community Switch is the one switch (reconnect.ts switchPhoneTo), as the BeanPool sheet's.
        const settings = code(fs.readFileSync(path.join(NATIVE, 'app/(tabs)/settings.tsx'), 'utf8'));
        const handleSwitch = settings.slice(settings.indexOf('async function handleSwitchNode('), settings.indexOf('async function handleSwitchNode(') + 1500);
        expect(handleSwitch).toMatch(/await switchPhoneTo\(targetUrl\);/);
        expect(handleSwitch).not.toMatch(/closeDB\(\)/);
    });
});
