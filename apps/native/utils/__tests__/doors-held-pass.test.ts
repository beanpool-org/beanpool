/**
 * The doors behind the phone's lock act only on a pass given for this request, just now: never on one the phone held
 * while the app was away (#1311's deciding review, 2026-09-29, "Confirmed, predates this PR").
 *
 * Android 8-10 holds the PIN screen's result until BeanPool is back in front: a member passes the PIN and presses home
 * during the moment it closes, and whoever opens BeanPool an hour later on the still-unlocked phone gets the held pass.
 * #1307, #1309 and #1311 made App Lock refuse it (utils/return-lock.ts), but the doors acted on it whatever App Lock did:
 * after a pass held an hour, readWordsBehindLock gave the 12 words and requireDeviceUnlock said 'ok', in both shapes.
 * - Inside the app App Lock's lock screen was over the words; with App Lock off nothing was.
 * - Manage / Moderate community, sign in on a computer and take over with this phone hand off outside the app (a browser,
 *   another computer, a server), where App Lock's lock screen covers nothing: whoever held the phone got an owner's
 *   session.
 *
 * - A door's pass counts only when it reached the app within PROMPT_COVER_MAX_MS (two minutes, #1311's) of that prompt
 *   opening, on App Lock's clock (the phone's since-boot clock), read and trusted throughout. Otherwise the door does
 *   nothing, as for a cancelled prompt, and the member asks again. With App Lock on or off.
 * - A real slow prompt (Android's 30-second wait after five wrong PINs, a member reading the prompt) still passes.
 * - An unreadable clock refuses: the door can't tell how late the pass came.
 * - App Lock's own unlock keeps #1311's rule (the return lock's).
 * - The 12 words, once on screen, are put away after the app has been left for 15 seconds or more, App Lock or not.
 *
 * Screens can't be rendered here (see vitest.config.ts): the doors are called as their screens call them, the phone's
 * prompt mocked at expo-local-authentication, time faked, and the since-boot clock a fake native module on
 * globalThis.expo.modules, where the app reads it (as in return-lock.test.ts). The screens' wiring is read from source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const phoneState = vi.hoisted(() => ({
    appLock: 'true' as string | null,
    /** Whether the app has the phone's since-boot clock (modules/boot-clock). */
    bootClock: true,
    /** The since-boot clock reads bootBase + performance.now(). */
    bootBase: 0,
    /** While set, the since-boot clock's elapsedMs answers this instead. */
    bootClockFault: null as null | (() => unknown),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => (key === 'beanpool_app_lock_enabled' ? phoneState.appLock : null)),
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

type AppStateStatus = 'active' | 'background' | 'inactive';
type Answer = { success: boolean; error?: string };

const SEC = 1000;
const START = new Date('2026-09-29T09:00:00Z');
// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
// A test seed only, never a real account's.
const SEED_HEX = 'cd'.repeat(32);
const ACCOUNT = {
    publicKey: Buffer.from(ed25519.getPublicKey(Buffer.from(SEED_HEX, 'hex'))).toString('hex'),
    privateKey: SEED_HEX, callsign: 'Kim', createdAt: '', mnemonic: WORDS,
};
const NODE = 'https://mullum.beanpool.org';
const CHALLENGE_ID = 'c1'.repeat(32);
const PAIRING_ID = '0123456789abcdef'.repeat(4);

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };
type Reply = { status: number; body: unknown };

/**
 * A phone with a PIN, BeanPool open on it with an account, App Lock on or off, the return lock listening, and no network
 * but the replies a test gives. Fresh modules each time: the prompt marker is module state.
 */
async function phone() {
    vi.resetModules();
    phoneState.bootBase = Date.now() - performance.now();
    if (phoneState.bootClock) {
        (globalThis as ExpoGlobalForTests).expo = {
            modules: {
                BeanPoolBootClock: {
                    elapsedMs: () => (phoneState.bootClockFault ? phoneState.bootClockFault() : phoneState.bootBase + performance.now()) as number,
                },
            },
        };
    }
    const LA = await import('expo-local-authentication');
    const LocalAuth = await import('../LocalAuth');
    const ReturnLock = await import('../return-lock');
    const doors = {
        ...(await import('../words-behind-lock')),
        ...(await import('../node-admin')),
        ...(await import('../settings-signin')),
        ...(await import('../takeover-unlock')),
    };

    const open: Array<(answer: Answer) => void> = [];
    vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
    vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
    vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
    vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise<Answer>(resolve => open.push(resolve)) as never);

    const replies: Reply[] = [];
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        fetched.push(url);
        const r = replies.shift();
        if (!r) throw new Error(`no network in this test: ${url}`);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    }));

    let locked = false;
    const onChange = ReturnLock.createReturnLock(v => { locked = v; });

    return {
        LocalAuth,
        ReturnLock,
        doors,
        account: ACCOUNT,
        change(next: AppStateStatus) {
            void onChange(next, true);
        },
        wait(ms: number) {
            vi.advanceTimersByTime(ms);
        },
        setWallClock(byMs: number) {
            vi.setSystemTime(Date.now() + byMs);
        },
        locked: () => locked,
        reasons: () => vi.mocked(LA.authenticateAsync).mock.calls.map(c => c[0]?.promptMessage),
        answer(passes: boolean) {
            const resolve = open.shift();
            expect(resolve, 'no prompt is open to answer').toBeDefined();
            resolve!(passes ? { success: true } : { success: false, error: 'user_cancel' });
        },
        /** What the node answers, in order, if the door ever asks it. */
        replies,
        fetched,
    };
}
type Phone = Awaited<ReturnType<typeof phone>>;

type Door = {
    /** Presses the door's button: its prompt opens. Resolves with whether the door acted (showed, signed, handed off). */
    press: (p: Phone) => Promise<boolean>;
};

const openedUrls: string[] = [];
const DOORS: Record<string, Door> = {
    // Settings' View Recovery Phrase and Account Protection's Show, the replace screen's and Safety Backup's Show,
    // node-mismatch's delete: every screen that draws the words reads them here.
    'the 12 words (readWordsBehindLock)': {
        press: async (p) => {
            const words = await p.doors.readWordsBehindLock(p.account, 'Confirm your security to view your recovery phrase.');
            if (words !== null) expect(words).toEqual(WORDS);
            return words !== null;
        },
    },
    // Pairing a computer, linking a sign-in, App Lock on or off, Sign Out, Purge, deleting or replacing the account.
    "the check every other door asks (LocalAuth.authenticateUser)": {
        press: async (p) => p.LocalAuth.authenticateUser('Confirm authentication to send your account to this computer.'),
    },
    "Manage / Moderate community (node-admin's manageNode): the browser opens signed in": {
        press: async (p) => {
            p.replies.push(
                { status: 200, body: { challengeId: CHALLENGE_ID, challenge: `beanpool-admin-auth:${CHALLENGE_ID}:${Date.now()}` } },
                { status: 200, body: { handshakeToken: 'handoff-token' } },
            );
            const before = openedUrls.length;
            const out = await p.doors.manageNode({
                nodeUrl: NODE, identity: p.account, communityName: 'Mullum',
                openUrl: async (url) => { openedUrls.push(url); },
            });
            const handedOff = openedUrls.length > before;
            expect(handedOff).toBe(out.kind === 'opened');
            if (!handedOff) expect(out).toEqual({ kind: 'unlock-failed' });
            return handedOff;
        },
    },
    'sign in on a computer (settings-signin approveComputerSignin): the computer is signed in': {
        press: async (p) => {
            p.replies.push({ status: 200, body: { success: true } });
            const out = await p.doors.approveComputerSignin({
                qr: { nodeUrl: NODE, pairingId: PAIRING_ID, shortCode: 'K7F3QX' }, identity: p.account, communityName: 'Mullum',
            });
            if (out.kind !== 'approved') expect(out).toEqual({ kind: 'unlock-failed' });
            return out.kind === 'approved';
        },
    },
    // Past the phone's lock it re-wraps the owner's key for the session; the stand-in check below isn't a real lock, so
    // a door that let the pass through answers "did not open" instead of 'unlocked'. Either way it went past the lock.
    'take over with this phone (takeover-unlock approveUnlock): past the phone lock': {
        press: async (p) => {
            const qr = { serverUrl: NODE, sessionId: 'session', purpose: 'takeover' } as never;
            const out = await p.doors.approveUnlock({ qr, check: { header: {} } as never, identity: p.account, communityName: 'Mullum' });
            return out.kind !== 'unlock-failed';
        },
    },
};
const DOOR_NAMES = Object.keys(DOORS);

const SHAPES = [
    ['Android 8-10: the PIN screen backgrounds the app', 'background'],
    ['iOS: the passcode prompt makes the app inactive', 'inactive'],
] as const;
const ORDERS = [
    ['the pass arrives before the app is active again', 'answer first'],
    ['the app is active again before the pass arrives', 'active first'],
] as const;
const APP_LOCK = [
    ['App Lock on', 'true'],
    ['App Lock off', 'false'],
] as const;

/**
 * The door's prompt takes the app out of the front, `ms` go by, and the prompt's answer and the app's return reach JS
 * in `order`. Resolves with whether the door acted.
 */
async function promptThatTakes(p: Phone, door: Door, leave: AppStateStatus, order: 'answer first' | 'active first', ms: number, passes = true) {
    const acted = door.press(p);
    await flush();
    expect(p.LocalAuth.isLocalAuthPromptOpen(), "the door's prompt is open").toBe(true);
    p.change(leave);
    p.wait(ms);
    if (order === 'answer first') {
        p.answer(passes);
        await flush();
        p.change('active');
    } else {
        p.change('active');
        await flush();
        p.answer(passes);
    }
    await flush();
    return acted;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(START);
    phoneState.appLock = 'true';
    phoneState.bootClock = true;
    phoneState.bootClockFault = null;
    openedUrls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    delete (globalThis as ExpoGlobalForTests).expo;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('a pass the phone held an hour opens no door', () => {
    describe.each(DOOR_NAMES)('%s', (name) => {
        describe.each(APP_LOCK)('%s', (_appLock, appLock) => {
            describe.each(SHAPES)('%s', (_shape, leave) => {
                it.each(ORDERS)('when %s: nothing shown, nothing handed off', async (_order, order) => {
                    phoneState.appLock = appLock;
                    const p = await phone();

                    // The member passes the PIN and presses home as it closes; the pass reaches the app an hour later.
                    const acted = await promptThatTakes(p, DOORS[name], leave, order, 3600 * SEC);

                    expect(await acted).toBe(false);
                    expect(p.fetched).toEqual([]);
                    expect(openedUrls).toEqual([]);
                });
            });
        });
    });

    it('the member asks again, and a pass given now opens the door', async () => {
        phoneState.appLock = 'false';
        const p = await phone();
        const door = DOORS["Manage / Moderate community (node-admin's manageNode): the browser opens signed in"];
        expect(await promptThatTakes(p, door, 'background', 'answer first', 3600 * SEC)).toBe(false);
        p.replies.length = 0;

        expect(await promptThatTakes(p, door, 'background', 'answer first', 3 * SEC)).toBe(true);
        expect(openedUrls).toHaveLength(1);
        expect(openedUrls[0]).toMatch(/^https:\/\/mullum\.beanpool\.org\/settings#handoff=handoff-token/);
    });
});

describe('a real slow prompt still opens the door', () => {
    describe.each(DOOR_NAMES)('%s', (name) => {
        describe.each(SHAPES)('%s', (_shape, leave) => {
            it.each(ORDERS)('a 40-second prompt (Android waits 30 seconds after five wrong PINs) that passes, when %s', async (_order, order) => {
                const p = await phone();
                expect(await promptThatTakes(p, DOORS[name], leave, order, 40 * SEC)).toBe(true);
            });
        });

        it('a prompt that never takes the app out of the front, passed after 40 seconds', async () => {
            const p = await phone();
            const acted = DOORS[name].press(p);
            await flush();
            p.wait(40 * SEC);
            p.answer(true);
            expect(await acted).toBe(true);
        });

        it('a prompt cancelled after 40 seconds opens nothing, as before', async () => {
            const p = await phone();
            expect(await promptThatTakes(p, DOORS[name], 'background', 'answer first', 40 * SEC, false)).toBe(false);
            expect(p.fetched).toEqual([]);
        });
    });
});

describe('the edge: a pass counts up to PROMPT_COVER_MAX_MS after its prompt opened', () => {
    it('two minutes: the same constant as the return lock', async () => {
        const p = await phone();
        expect(p.ReturnLock.PROMPT_COVER_MAX_MS).toBe(120 * SEC);
        expect(p.LocalAuth.PROMPT_COVER_MAX_MS).toBe(120 * SEC);
    });

    describe.each(DOOR_NAMES)('%s', (name) => {
        it.each([
            [120 * SEC, true],
            [120 * SEC + 1, false],
            [135 * SEC, false],
        ] as const)('a pass that reaches the app %s ms after its prompt opened: acted %s', async (ms, acts) => {
            const p = await phone();
            expect(await promptThatTakes(p, DOORS[name], 'background', 'answer first', ms)).toBe(acts);
        });
    });
});

const UNREADABLE = [
    ['the module missing (a phone app built before it)', () => { phoneState.bootClock = false; }],
    ['elapsedMs throwing', () => { phoneState.bootClockFault = () => { throw new Error('native'); }; }],
    ['elapsedMs answering NaN', () => { phoneState.bootClockFault = () => Number.NaN; }],
    ['elapsedMs answering a string', () => { phoneState.bootClockFault = () => '123456'; }],
] as const;

describe("a phone whose since-boot clock can't be read: the door can't tell how late the pass came, so it refuses", () => {
    describe.each(DOOR_NAMES)('%s', (name) => {
        it.each(UNREADABLE)('%s: a 2-second prompt that passes opens nothing', async (_clock, breakClock) => {
            breakClock();
            const p = await phone();
            expect(await promptThatTakes(p, DOORS[name], 'background', 'answer first', 2 * SEC)).toBe(false);
            expect(p.fetched).toEqual([]);
        });

        it('only the reading at the answer fails: nothing', async () => {
            const p = await phone();
            const acted = DOORS[name].press(p);
            await flush();
            p.change('background');
            p.wait(2 * SEC);
            phoneState.bootClockFault = () => { throw new Error('native'); };
            p.answer(true);
            await flush();
            p.change('active');
            expect(await acted).toBe(false);
        });
    });

    it("a phone with no screen lock opens no prompt, so there's no pass to be late: let through, as always", async () => {
        phoneState.bootClock = false;
        const p = await phone();
        const LA = await import('expo-local-authentication');
        vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.NONE);
        expect(await p.LocalAuth.authenticateUser('Confirm your security to view your recovery phrase.')).toBe(true);
        expect(await p.doors.readWordsBehindLock(p.account, 'Confirm your security to view your recovery phrase.')).toEqual(WORDS);
    });
});

describe('the wall clock set back while a door is asking: the times cannot be trusted, so it refuses', () => {
    it.each(DOOR_NAMES)('%s', async (name) => {
        const p = await phone();
        const acted = DOORS[name].press(p);
        await flush();
        p.change('background');
        p.wait(2 * SEC);
        p.setWallClock(-60 * SEC);
        p.wait(1 * SEC);
        p.answer(true);
        await flush();
        p.change('active');
        expect(await acted).toBe(false);
    });
});

describe("the rule (LocalAuth.doorPassCounts)", () => {
    it.each([
        ['answered at once', 0, 0, false, true],
        ['answered 40 s after it opened', 0, 40 * SEC, false, true],
        ['answered exactly at the cap', 0, 120 * SEC, false, true],
        ['1 ms past the cap', 0, 120 * SEC + 1, false, false],
        ['an hour later', 0, 3600 * SEC, false, false],
        ['answered before it opened (the clock ran backwards)', 10 * SEC, 5 * SEC, false, false],
        ['the opening unreadable', Number.NaN, 5 * SEC, false, false],
        ['the answer unreadable', 0, Number.NaN, false, false],
        ['the answer not a finite time', 0, Number.POSITIVE_INFINITY, false, false],
        ['a clock seen set back or unreadable in between', 0, 1 * SEC, true, false],
    ] as const)('%s: %s', async (_name, openedAt, answeredAt, untrusted, counts) => {
        const { doorPassCounts } = await import('../LocalAuth');
        expect(doorPassCounts(openedAt, answeredAt, untrusted)).toBe(counts);
    });
});

describe("App Lock's own unlock keeps #1311's rule", () => {
    it.each(SHAPES)('%s: the launch lock passed 2 min 5 s after it opened, the return within the cap and its grace: the app opens', async (_shape, leave) => {
        const p = await phone();
        let locked = true;
        void p.ReturnLock.unlockWithPhoneLock('Unlock BeanPool').then(ok => { if (ok) locked = false; });
        await flush();
        p.change(leave);
        p.wait(125 * SEC);
        p.answer(true);
        await flush();
        p.change('active');
        await flush();
        expect(locked).toBe(false);
        expect(p.locked()).toBe(false);
        expect(p.reasons()).toEqual(['Unlock BeanPool']);
    });
});

describe('every door asks through the held-pass rule', () => {
    const NATIVE = path.resolve(__dirname, '../..');
    const read = (f: string) => fs.readFileSync(path.join(NATIVE, f), 'utf-8');
    /** Code only: what a comment says is not what the code does. */
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it("authenticateUser and requireDeviceUnlock time their own prompt and act only on a pass in time", () => {
        const localAuth = code(read('utils/LocalAuth.ts'));
        expect(localAuth).toMatch(/async function askPhoneLock\([\s\S]*?const passCounts = timeDoorPrompt\(\);\s*const res = await phoneLockPrompt\(\{[\s\S]*?return res\.success && \(!door \|\| passCounts\(\)\);/);
        expect(localAuth).toMatch(/export async function authenticateUser\(reason: string\): Promise<boolean> \{\s*return askPhoneLock\(reason, true\);/);
        const nodeAdmin = code(read('utils/node-admin.ts'));
        expect(nodeAdmin).toMatch(/export async function requireDeviceUnlock[\s\S]*?const passCounts = timeDoorPrompt\(\);\s*const res = await phoneLockPrompt\(\{[\s\S]*?return res\.success && passCounts\(\) \? 'ok' : 'failed';/);
    });

    it("only App Lock's unlock asks without it: authenticateForAppLock is called from unlockWithPhoneLock and nowhere else", () => {
        const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
            return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
        });
        const callers = ['app', 'components', 'utils']
            .flatMap(d => sources(path.join(NATIVE, d)))
            .filter(f => /authenticateForAppLock\(/.test(code(fs.readFileSync(f, 'utf-8'))))
            .map(f => path.relative(NATIVE, f))
            .sort();
        expect(callers).toEqual([path.join('utils', 'LocalAuth.ts'), path.join('utils', 'return-lock.ts')]);
        expect(code(read('utils/return-lock.ts'))).toMatch(/export async function unlockWithPhoneLock\(reason: string\)[\s\S]*?const passed = await authenticateForAppLock\(reason\);/);
    });
});

describe('the 12 words, once on screen, are put away after 15 seconds or more away, App Lock or not', () => {
    async function watcher() {
        vi.resetModules();
        phoneState.bootBase = Date.now() - performance.now();
        if (phoneState.bootClock) {
            (globalThis as ExpoGlobalForTests).expo = {
                modules: {
                    BeanPoolBootClock: {
                        elapsedMs: () => (phoneState.bootClockFault ? phoneState.bootClockFault() : phoneState.bootBase + performance.now()) as number,
                    },
                },
            };
        }
        const { wordsLeaveWatcher } = await import('../words-put-away');
        const putAway = vi.fn();
        return { onChange: wordsLeaveWatcher(putAway), putAway };
    }

    it.each([
        [15 * SEC, true],
        [60 * SEC, true],
        [3600 * SEC, true],
        [15 * SEC - 1, false],
        [3 * SEC, false],
    ] as const)('away %s ms: put away %s', async (ms, away) => {
        for (const appLock of ['true', 'false']) {
            phoneState.appLock = appLock;
            const w = await watcher();
            w.onChange('background');
            vi.advanceTimersByTime(ms);
            w.onChange('active');
            expect(w.putAway).toHaveBeenCalledTimes(away ? 1 : 0);
        }
    });

    it('iOS: inactive, then background, then back: the time counts from the first', async () => {
        const w = await watcher();
        w.onChange('inactive');
        vi.advanceTimersByTime(10 * SEC);
        w.onChange('background');
        vi.advanceTimersByTime(10 * SEC);
        w.onChange('active');
        expect(w.putAway).toHaveBeenCalledTimes(1);
    });

    it('each leave counts on its own: two short ones put nothing away', async () => {
        const w = await watcher();
        for (let i = 0; i < 2; i++) {
            w.onChange('background');
            vi.advanceTimersByTime(10 * SEC);
            w.onChange('active');
            vi.advanceTimersByTime(10 * SEC);
        }
        expect(w.putAway).not.toHaveBeenCalled();
    });

    it('the wall clock set back during a short leave: put away, as the times cannot be trusted', async () => {
        const w = await watcher();
        w.onChange('background');
        vi.advanceTimersByTime(3 * SEC);
        vi.setSystemTime(Date.now() - 60 * SEC);
        w.onChange('active');
        expect(w.putAway).toHaveBeenCalledTimes(1);
    });

    it.each(UNREADABLE)("%s: a 3-second leave puts them away", async (_clock, breakClock) => {
        breakClock();
        const w = await watcher();
        w.onChange('background');
        vi.advanceTimersByTime(3 * SEC);
        w.onChange('active');
        expect(w.putAway).toHaveBeenCalledTimes(1);
    });

    it('an active with no leave seen puts nothing away', async () => {
        const w = await watcher();
        w.onChange('active');
        expect(w.putAway).not.toHaveBeenCalled();
    });

    describe('every screen that shows the words behind the lock puts them away so', () => {
        const NATIVE = path.resolve(__dirname, '../..');
        const read = (f: string) => fs.readFileSync(path.join(NATIVE, f), 'utf-8');
        it.each([
            ["Settings' Account Protection", 'app/(tabs)/settings.tsx', 'usePutAwayAfterLeave(revealWords, putProtectionWordsAway);'],
            ["Settings' View Recovery Phrase", 'app/(tabs)/settings.tsx', 'usePutAwayAfterLeave(seedWords !== null, putSeedWordsAway);'],
            ['"Replace this phone\'s account?"', 'app/welcome.tsx', 'usePutAwayAfterLeave(outgoingWords !== null, putOutgoingWordsAway);'],
            ["Safety Backup's Show for a key the phone already had", 'app/welcome.tsx', 'usePutAwayAfterLeave(pendingWords !== null, putPendingWordsAway);'],
            ["node-mismatch's delete", 'app/node-mismatch.tsx', 'usePutAwayAfterLeave(words !== null, putWipeWordsAway);'],
        ] as const)('%s', (_screen, file, wiring) => {
            const src = read(file);
            expect(src).toContain("import { usePutAwayAfterLeave } from '");
            expect(src).toContain(wiring);
        });
    });
});
