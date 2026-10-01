/**
 * Every place in the app that writes or removes the phone's community (`beanpool_anchor_url`) says so
 * (utils/community-switch.ts `communitySwitched`), so the full-screen "Update required" (utils/force-update.ts) never
 * stays up over another community, or over none.
 *
 * #1415's re-review (NON-BLOCKING, community-switch.ts:2) found six that didn't: the deep link's Switch & Join,
 * Welcome's invite joins, the global joins, restore, "Wipe & Join Fresh" and People's "Wipe & Restart". The result was
 * a stale block over the new community, and a block that stayed with no community at all until a cold start.
 *
 * This reads the app's source, finds each write and removal, and fails on one with no `communitySwitched()` close after
 * it, unless it is one of the named exceptions below, each with its reason. Nothing here runs the app.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const NATIVE = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components', 'utils', 'services', 'modules', 'hooks', 'constants'];

/** The source without comments, so neither a write nor an announcement can be met by a comment. */
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

interface Write { file: string; line: number; text: string }

/** Every setItem / removeItem of the anchor: by its name, or through a constant that holds it. */
function anchorWrites(): Write[] {
    const writes: Write[] = [];
    for (const full of sourceFiles()) {
        const src = code(fs.readFileSync(full, 'utf8'));
        const constants = [...src.matchAll(/const\s+(\w+)\s*=\s*'beanpool_anchor_url'/g)].map((m) => m[1]);
        const names = ["'beanpool_anchor_url'", ...constants];
        const lines = src.split('\n');
        lines.forEach((text, i) => {
            if (names.some((n) => new RegExp(`\\b(setItem|removeItem)\\(\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text))) {
                writes.push({ file: path.relative(NATIVE, full), line: i + 1, text: text.trim() });
            }
        });
    }
    return writes;
}

/** How many lines after a write its announcement may come (a redeem, or the copy opened, in between). */
const WITHIN = 14;

/** Writes that announce elsewhere, each with why. */
const EXCEPTIONS: Record<string, string> = {
    // The phone's half of leaving a community: its callers open the next one's copy, then announce (pinned below).
    'utils/delete-here.ts': 'leaveThisCommunity: deleteAccountHere and the update block announce after it',
    // Discovery runs only in a development build with no community set: production has no candidates.
    'services/pillar-sync.ts': 'discoverAnchor: development builds only',
};

describe('every write or removal of the phone\'s community announces it', () => {
    const writes = anchorWrites();

    it('finds the writes (the sweep is looking at the real source)', () => {
        expect(writes.length).toBeGreaterThanOrEqual(15);
        const files = new Set(writes.map((w) => w.file));
        for (const f of ['app/_layout.tsx', 'app/welcome.tsx', 'app/(tabs)/people.tsx', 'utils/restore-account.ts', 'utils/global-join-existing.ts', 'utils/identity.ts']) {
            expect(files.has(f), f).toBe(true);
        }
    });

    for (const w of anchorWrites()) {
        it(`${w.file}:${w.line} ${w.text.slice(0, 70)}`, () => {
            if (EXCEPTIONS[w.file]) return;
            const lines = code(fs.readFileSync(path.join(NATIVE, w.file), 'utf8')).split('\n');
            const after = lines.slice(w.line - 1, w.line - 1 + WITHIN).join('\n');
            expect(after, `no communitySwitched() within ${WITHIN} lines of ${w.file}:${w.line}`).toMatch(/communitySwitched\(\)/);
        });
    }

    it('the exceptions: every caller of leaveThisCommunity announces once the next copy is open', () => {
        const callers = sourceFiles()
            .map((f) => [path.relative(NATIVE, f), code(fs.readFileSync(f, 'utf8'))] as const)
            .filter(([, src]) => /await leaveThisCommunity\(/.test(src));
        expect(callers.length).toBeGreaterThan(0);
        for (const [f] of callers) expect(['utils/delete-here.ts', 'utils/update-block-escape.ts']).toContain(f);
        for (const [, src] of callers) {
            expect(src).toMatch(/await leaveThisCommunity\([^)]*\);[\s\S]{0,400}?communitySwitched\(\);/);
        }
    });

    it('the exceptions: discovery writes a community only in a development build', () => {
        const sync = code(fs.readFileSync(path.join(NATIVE, 'services/pillar-sync.ts'), 'utf8'));
        const discover = sync.slice(sync.indexOf('async function discoverAnchor'), sync.indexOf("await AsyncStorage.setItem('beanpool_anchor_url', winningUrl)"));
        // Before the write: a saved community returns early, and every candidate is pushed inside `if (__DEV__)`.
        expect(discover).toMatch(/if \(savedAnchor\) \{[\s\S]*?return savedAnchor;/);
        const pushes = [...discover.matchAll(/candidates\.push\(/g)].length;
        const devBlock = discover.slice(discover.indexOf('if (__DEV__) {'));
        expect(pushes).toBeGreaterThan(0);
        expect([...devBlock.matchAll(/candidates\.push\(/g)].length).toBe(pushes);
    });
});
