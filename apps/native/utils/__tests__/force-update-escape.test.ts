/**
 * The ways out of the full-screen "Update required" (components/ForceUpdateBlock.tsx, utils/update-block-escape.ts).
 *
 * #1415's deciding review (BLOCKING): one community's block covered the whole phone, including the member's other
 * communities, their 12 words and the way to leave, and any node can raise it. Now:
 * - with other communities saved on the phone, the block offers each; using one takes the block down and asks that
 *   community at once, and switching back asks the first again (driven on the gate at the end);
 * - with an account on the phone, it always offers the 12 words and leaving, as Settings' own sections, which it steps
 *   aside for while one of them is in front.
 *
 * Nothing here contacts a node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BLOCK, CLEAR, phone } from './force-update-phone';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

const NATIVE = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(NATIVE, rel), 'utf8');

/** The phone's storage, as AsyncStorage holds it. */
function storage(items: Record<string, string | null>) {
    const store = new Map(Object.entries(items));
    return {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        store,
    };
}

describe('otherCommunitiesOnPhone: "Use another community"', () => {
    beforeEach(() => { vi.resetModules(); });

    it('every saved community but the one the phone is set to, in the saved order, named as the BeanPool sheet names it', async () => {
        const { otherCommunitiesOnPhone } = await import('../update-block-escape');
        const s = storage({
            beanpool_anchor_url: 'https://mullum.beanpool.org',
            beanpool_saved_nodes: JSON.stringify([
                { url: 'https://mullum.beanpool.org', alias: 'Mullum' },
                { url: 'https://castlemaine.beanpool.org/', alias: 'Castlemaine' },
                { url: 'https://bellingen.example' },
            ]),
        });
        expect(await otherCommunitiesOnPhone(s)).toEqual([
            { url: 'https://castlemaine.beanpool.org/', name: 'Castlemaine' },
            { url: 'https://bellingen.example', name: 'bellingen.example' },
        ]);
    });

    it('none when the phone has only the one: the block then offers the words and leaving only', async () => {
        const { otherCommunitiesOnPhone } = await import('../update-block-escape');
        const s = storage({
            beanpool_anchor_url: 'https://mullum.beanpool.org',
            beanpool_saved_nodes: JSON.stringify([{ url: 'https://mullum.beanpool.org/' }]),
        });
        expect(await otherCommunitiesOnPhone(s)).toEqual([]);
    });

    it('never an address the phone would not switch to, never one twice, and an unreadable list is none', async () => {
        const { otherCommunitiesOnPhone } = await import('../update-block-escape');
        const s = storage({
            beanpool_anchor_url: 'https://mullum.beanpool.org',
            beanpool_saved_nodes: JSON.stringify([
                { url: 'https://evil.example@mullum.beanpool.org' },
                { url: 'https://castlemaine.beanpool.org' },
                { url: 'https://castlemaine.beanpool.org/path' },
                { url: 'HTTPS://Castlemaine.beanpool.org:443' },
                { url: 'https://castlemaine.beanpool.org/' },
                'junk', null, { alias: 'no url' },
            ]),
        });
        expect((await otherCommunitiesOnPhone(s)).map((c) => c.url)).toEqual(['https://castlemaine.beanpool.org']);
        expect(await otherCommunitiesOnPhone(storage({ beanpool_saved_nodes: '{not json' }))).toEqual([]);
        expect(await otherCommunitiesOnPhone({ getItem: async () => { throw new Error('storage'); } })).toEqual([]);
    });
});

describe('switchFromUpdateBlock: the phone moves, and says so', () => {
    beforeEach(() => { vi.resetModules(); });

    it('closes the copy, sets the community, opens its copy, then tells the update screen', async () => {
        const { switchFromUpdateBlock } = await import('../update-block-escape');
        const { onCommunitySwitched } = await import('../community-switch');
        const order: string[] = [];
        const stop = onCommunitySwitched(() => order.push('switched'));
        const s = storage({ beanpool_anchor_url: 'https://mullum.beanpool.org' });
        await switchFromUpdateBlock('https://castlemaine.beanpool.org', {
            storage: { setItem: async (k, v) => { order.push(`set ${k}=${v}`); await s.setItem(k, v); } },
            closeDB: async () => { order.push('closeDB'); },
            initDB: async () => { order.push('initDB'); },
        });
        stop();
        expect(order).toEqual(['closeDB', 'set beanpool_anchor_url=https://castlemaine.beanpool.org', 'initDB', 'switched']);
    });

    it('refuses an address that is not plain before anything moves', async () => {
        const { switchFromUpdateBlock } = await import('../update-block-escape');
        const closeDB = vi.fn(async () => {});
        const setItem = vi.fn(async () => {});
        await expect(switchFromUpdateBlock('https://evil.example@mullum.beanpool.org', { storage: { setItem }, closeDB, initDB: vi.fn() })).rejects.toThrow();
        expect(closeDB).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });

    it("a listener that throws doesn't stop the others", async () => {
        const { communitySwitched, onCommunitySwitched } = await import('../community-switch');
        const seen: string[] = [];
        const a = onCommunitySwitched(() => { throw new Error('boom'); });
        const b = onCommunitySwitched(() => seen.push('b'));
        communitySwitched();
        a(); b();
        communitySwitched();
        expect(seen).toEqual(['b']);
    });
});

describe("Settings' account sections, which the block steps aside for", () => {
    it('only the words, Account Protection and Account Deletion & Sign Out', async () => {
        vi.resetModules();
        const { isAccountSection, ACCOUNT_SECTIONS } = await import('../update-block-escape');
        expect([...ACCOUNT_SECTIONS]).toEqual(['seed', 'protection', 'wipe']);
        for (const other of ['menu', 'profile', 'advanced', 'notifications', 'diagnostics', undefined]) {
            expect(isAccountSection(other)).toBe(false);
        }
    });

    it('says when one comes in front and when it goes, once each', async () => {
        vi.resetModules();
        const m = await import('../update-block-escape');
        const seen: boolean[] = [];
        const stop = m.onAccountSectionInFront((open) => seen.push(open));
        m.setAccountSectionInFront(true);
        m.setAccountSectionInFront(true);
        expect(m.accountSectionInFront()).toBe(true);
        m.setAccountSectionInFront(false);
        stop();
        m.setAccountSectionInFront(true);
        expect(seen).toEqual([true, false]);
    });
});

/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the block, as it is wired (components/ForceUpdateBlock.tsx)', () => {
    const block = code(read('components/ForceUpdateBlock.tsx'));

    it('"Use another community" whenever the phone has another, and each switches through switchFromUpdateBlock', () => {
        expect(block).toContain('otherCommunitiesOnPhone().then(');
        expect(block).toMatch(/\{others\.length > 0 && \(/);
        expect(block).toContain('Use another community');
        expect(block).toMatch(/await switchFromUpdateBlock\(c\.url\);\s*if \(router\.canDismiss\(\)\) router\.dismissAll\(\);\s*router\.replace\('\/welcome'\);/);
    });

    it('with an account on the phone, always the 12 words and leaving, as Settings has them', () => {
        expect(block).toMatch(/\{identity && \(/);
        expect(block).toContain("openAccountSection('seed')");
        expect(block).toContain("openAccountSection('wipe')");
        expect(block).toContain('Leave this community');
        expect(block).toMatch(/router\.navigate\(\{ pathname: '\/\(tabs\)\/settings', params: \{ section, open: String\(Date\.now\(\)\) \} \}\)/);
        // The words are never read or drawn here: Settings' section does that behind the phone's lock.
        expect(block).not.toMatch(/readWordsBehindLock|getMnemonic|deleteAccountHere|signOutOfThisPhone/);
    });

    it('steps aside only while an account section is in front, and its back button only works while it shows', () => {
        expect(block).toContain('useState(accountSectionInFront)');
        expect(block).toContain('onAccountSectionInFront(setAside)');
        expect(block).toContain('if (!block || aside) return null;');
        expect(block).toMatch(/if \(!showing \|\| Platform\.OS !== 'android'\) return;/);
    });

    it('the gate hears every switch of community', () => {
        expect(block).toContain('onCommunitySwitched(() => { void gate.communitySwitched(); })');
        expect(block).toContain('stopSwitches();');
    });

    it('mounted inside the identity (for the account options), after the screens, so it shows with or without an account', () => {
        const layout = code(read('app/_layout.tsx'));
        // (A JSX comment between them reads `{}` once comments are taken out.)
        expect(layout).toMatch(/<IdentityProvider>\s*<NodeStatusProvider>\s*<RootLayoutNav \/>\s*<\/NodeStatusProvider>\s*(\{\}\s*)?<ForceUpdateBlock \/>\s*<\/IdentityProvider>/);
        expect(layout.match(/<ForceUpdateBlock \/>/g)).toHaveLength(1);
    });
});

describe('Settings opens the sections the block asks for, and says when one is in front', () => {
    const settings = code(read('app/(tabs)/settings.tsx'));

    it("section=seed opens View Recovery Phrase; section=wipe opens Account Deletion & Sign Out from its start; each tap is new", () => {
        expect(settings).toMatch(/params\.section === 'seed'\) \{\s*openViewWords\(\);/);
        expect(settings).toMatch(/params\.section === 'wipe'\) \{\s*setMode\('wipe'\);\s*setWipeType\('options'\);\s*setWipeConfirm\(''\);\s*setPurgeConfirm\(''\);/);
        expect(settings).toContain('}, [params.section, params.open])');
    });

    it('in front means the Settings tab focused and one of the account sections open; gone when it unmounts', () => {
        expect(settings).toContain('setAccountSectionInFront(settingsFocused && isAccountSection(mode));');
        expect(settings).toContain('useEffect(() => () => setAccountSectionInFront(false), []);');
    });
});

describe('every way a member moves the phone to another community tells the update screen', () => {
    const sites: Array<[string, RegExp]> = [
        ['utils/use-communities.ts', /await AsyncStorage\.setItem\('beanpool_anchor_url', url\);\s*await initDB\(\);\s*communitySwitched\(\);/],
        ['app/(tabs)/settings.tsx', /await AsyncStorage\.setItem\('beanpool_anchor_url', targetUrl\);\s*await initDB\(\);\s*communitySwitched\(\);/],
        ['app/(tabs)/settings.tsx', /await AsyncStorage\.setItem\('beanpool_anchor_url', finalAnchorUrl\);\s*communitySwitched\(\);/],
        ['app/node-mismatch.tsx', /await AsyncStorage\.setItem\('beanpool_anchor_url', url\);\s*await initDB\(\);\s*communitySwitched\(\);/],
        ['utils/join-another-community.ts', /communitySwitched\(\);\s*await deps\.clearGuestNode\(targetUrl\)/],
        ['utils/delete-here.ts', /await leaveThisCommunity\(plan\.here, plan\.next\.url\);\s*const \{ initDB \} = await import\('\.\/db'\);\s*await initDB\(\);\s*communitySwitched\(\);/],
        ['utils/account-leaves-phone.ts', /await releaseAccountFromPhone\(account\);\s*await wipeIdentity\(\);\s*communitySwitched\(\);/],
        ['utils/account-leaves-phone.ts', /await stopPushAlerts\(account\);\s*await wipeIdentity\(\);\s*communitySwitched\(\);/],
        ['utils/update-block-escape.ts', /await deps\.initDB\(\);\s*communitySwitched\(\);/],
    ];
    for (const [file, pin] of sites) {
        it(`${file}: ${pin.source.slice(0, 60)}…`, () => {
            expect(code(read(file))).toMatch(pin);
        });
    }
});

describe('a switch of community, on the gate', () => {
    it("the block is the community left's: it comes down, and the community now in use is asked at once", async () => {
        const p = phone({ answerMs: 300 });
        p.start(0);
        await p.run(1_000);
        expect(p.current).toEqual({ version: '1.2.61' });

        // "Use another community": the other one has no floor for this app.
        p.answer = CLEAR;
        p.switched(2_000);
        await p.run(3_000);
        expect(p.current).toBeNull();
        expect(p.asked).toBe(2);
    });

    it('switching back puts it up again: the floor still holds where it was set', async () => {
        const p = phone({ answerMs: 300 });
        p.start(0);
        p.answer = BLOCK;
        await p.run(1_000);
        p.answer = CLEAR;
        p.switched(2_000);
        await p.run(3_000);
        expect(p.current).toBeNull();

        // In use on the other community for an hour, then back to the first from the BeanPool sheet.
        p.answer = BLOCK;
        p.switched(3_000 + 60 * 60 * 1000);
        await p.run(3_000 + 60 * 60 * 1000 + 1_000);
        expect(p.current).toEqual({ version: '1.2.61' });
    });

    it('a community that does not answer (offline, or no community left) never puts it up', async () => {
        const p = phone({ answerMs: 300 });
        p.start(0);
        await p.run(1_000);
        p.answer = { kind: 'unknown' };
        p.switched(2_000);
        await p.run(3_000);
        expect(p.current).toBeNull();
    });

    it('the community removed while the block is up, by a way that never said so: it comes down at the next return', async () => {
        vi.resetModules();
        const { checkCommunityForUpdate, createForceUpdateGate } = await import('../force-update');
        let anchor: string | null = 'https://mullum.test';
        let t = 0;
        const shown: Array<{ version: string } | null> = [];
        const gate = createForceUpdateGate({
            now: () => t,
            check: () => checkCommunityForUpdate({
                anchorUrl: async () => anchor,
                fetchJson: async () => ({
                    appFloors: { android: { min: '1.2.61', blocking: true } }, appVersions: { android: '1.2.61' },
                }),
                localVersion: '1.2.57',
                platform: 'android',
            }),
            show: (b) => shown.push(b),
        });
        await gate.start('active');
        expect(shown).toEqual([{ version: '1.2.61' }]);
        // Taken off the phone with no word to the gate, then a short trip away and back.
        anchor = null;
        await gate.appStateChanged('background');
        t = 2_000;
        await gate.appStateChanged('active');
        expect(shown).toEqual([{ version: '1.2.61' }, null]);
    });

    it('a removal that says so takes it down at once, and with no community nothing puts it back', async () => {
        const p = phone({ answerMs: 300 });
        p.start(0);
        await p.run(1_000);
        expect(p.current).toEqual({ version: '1.2.61' });
        p.answer = CLEAR;
        p.switched(2_000);
        await p.run(2_000);
        expect(p.current).toBeNull();
        await p.run(10_000);
        expect(p.current).toBeNull();
    });

    it("an answer still on its way from the community left says nothing once the phone has switched", async () => {
        const p = phone({ answerMs: 2_000 });
        p.start(0);
        // Switched at 500 ms, before the first community's block answer (due at 2 s) lands; the next one answers clear.
        p.answerFrom(400, CLEAR);
        p.switched(500);
        await p.run(10_000);
        expect(p.shown.filter((s) => s.block !== null)).toEqual([]);
    });
});
