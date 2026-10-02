/**
 * The full-screen "Update required" (utils/force-update.ts) with App Lock on.
 *
 * App Lock's own unlock prompt opens at the very safe moments the block waits for (at launch, and on every return after
 * 15 seconds), and takes the app out of the front while it is open: iOS's Face ID and passcode make it 'inactive',
 * Android 8-10's PIN screen sends it to 'background'. #1415's deciding review drove the gate through those AppState
 * sequences on a virtual clock and found the block was never shown in four of them. Each is driven here the same way,
 * and in each the block now goes up right after the unlock, never before it.
 *
 * The prompt marker itself (LocalAuth.isAppLockPromptOpen) is driven at the end, with the real gate on top of it.
 *
 * Nothing here contacts a node: the clock, the community's answer and the phone's prompt are the test's.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SAFE_RETURN_MS } from '../force-update';
import { BLOCK, CLEAR, phone, type Phone } from './force-update-phone';

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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const NATIVE = path.resolve(__dirname, '../..');
/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');


/** In use since a cold start that found nothing, left at 1 s, back after six minutes: the return's time. */
function backAfterSixMinutes(p: Phone): number {
    p.answer = CLEAR;
    p.start(0);
    p.appState(1_000, 'background');
    const back = 1_000 + 6 * 60 * 1000;
    // The floor was raised while the member was away.
    return back;
}

describe("the reviewer's table: App Lock's own prompt is not the member leaving", () => {
    it('return after 6 min, answer in 600 ms, no App Lock: the block goes up', async () => {
        const p = phone();
        const back = backAfterSixMinutes(p);
        await p.run(back - 1);
        p.answer = BLOCK;
        p.appState(back, 'active');
        await p.run(back + 10_000);
        expect(p.firstShownAt()).toBe(back + 600);
    });

    for (const order of ['prompt answer, then active', 'active, then prompt answer'] as const) {
        it(`same, iOS Face ID prompt at +80 ms that passes at +1.3 s (${order}): shown right after the unlock, never before`, async () => {
            const p = phone();
            const back = backAfterSixMinutes(p);
            await p.run(back - 1);
            p.answer = BLOCK;
            p.appState(back, 'active');
            p.appLockPrompt(back + 80, order === 'prompt answer, then active' ? back + 1_300 : back + 1_310);
            p.appState(back + 80, 'inactive');
            p.appState(order === 'prompt answer, then active' ? back + 1_310 : back + 1_300, 'active');
            await p.run(back + 1_299);
            expect(p.shown).toEqual([]);
            await p.run(back + 10_000);
            expect(p.current).toEqual({ version: '1.2.61' });
            expect(p.firstShownAt()).toBe(back + 1_310);
            expect(p.asked).toBe(2);
        });
    }

    for (const order of ['prompt answer, then active', 'active, then prompt answer'] as const) {
        it(`same, Android 8-10 PIN at +80 ms, done at +6 s (${order}): shown right after the unlock, never before`, async () => {
            const p = phone();
            const back = backAfterSixMinutes(p);
            await p.run(back - 1);
            p.answer = BLOCK;
            p.appState(back, 'active');
            p.appLockPrompt(back + 80, order === 'prompt answer, then active' ? back + 6_000 : back + 6_040);
            p.appState(back + 80, 'background');
            p.appState(order === 'prompt answer, then active' ? back + 6_040 : back + 6_000, 'active');
            await p.run(back + 5_999);
            expect(p.shown).toEqual([]);
            await p.run(back + 20_000);
            expect(p.current).toEqual({ version: '1.2.61' });
            expect(p.firstShownAt()).toBe(back + 6_040);
        });
    }

    it('same, slow network: the answer at 3 s, after the prompt closed: shown when it lands', async () => {
        const p = phone({ answerMs: 3_000 });
        const back = backAfterSixMinutes(p);
        await p.run(back - 1);
        p.answer = BLOCK;
        p.appState(back, 'active');
        p.appLockPrompt(back + 80, back + 1_300);
        p.appState(back + 80, 'inactive');
        p.appState(back + 1_300, 'active');
        await p.run(back + 10_000);
        expect(p.firstShownAt()).toBe(back + 3_000);
    });

    it('cold start, answer in 900 ms, no App Lock: the block goes up', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        await p.run(10_000);
        expect(p.firstShownAt()).toBe(900);
    });

    it('same, launch prompt at +400 ms that passes at +1.6 s: shown right after the unlock', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        p.appLockPrompt(400, 1_600);
        p.appState(400, 'inactive');
        p.appState(1_600, 'active');
        await p.run(1_599);
        expect(p.shown).toEqual([]);
        await p.run(10_000);
        expect(p.firstShownAt()).toBe(1_600);
    });

    it('same, the passcode typed from +400 ms to +8 s: shown right after the unlock', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        p.appLockPrompt(400, 8_000);
        p.appState(400, 'inactive');
        p.appState(8_000, 'active');
        await p.run(7_999);
        expect(p.shown).toEqual([]);
        await p.run(20_000);
        expect(p.firstShownAt()).toBe(8_000);
    });

    it('a launch prompt that is cancelled, then Unlock App asked straight after: shown once the second one closes', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        p.appLockPrompt(400, 1_500);
        p.appState(400, 'inactive');
        p.appState(1_500, 'active');
        // The member taps Unlock App at once: another prompt, the app leaves the front again.
        p.appLockPrompt(1_700, 4_000);
        p.appState(1_700, 'inactive');
        p.appState(4_000, 'active');
        await p.run(20_000);
        // The answer was held at 900 ms; the first prompt's close at 1.5 s, with the app back, shows it.
        expect(p.firstShownAt()).toBe(1_500);
    });
});

describe('what App Lock does not cover', () => {
    it("a door's prompt (the words, a payment) is the member in the middle of something: still a leave, never shown on it", async () => {
        // The gate is not told about door prompts: isAppLockPromptOpen counts App Lock's own only (LocalAuth.ts).
        const p = phone({ withPromptDeps: false, answerMs: 900 });
        p.start(0);
        p.appState(400, 'inactive');
        p.appState(1_600, 'active');
        await p.run(SAFE_RETURN_MS);
        expect(p.shown).toEqual([]);
    });

    it('a gate built without the prompt hooks behaves as before: the prompt counts as leaving', async () => {
        const p = phone({ withPromptDeps: false });
        const back = backAfterSixMinutes(p);
        await p.run(back - 1);
        p.answer = BLOCK;
        p.appState(back, 'active');
        p.appState(back + 80, 'inactive');
        p.appState(back + 1_300, 'active');
        await p.run(back + 10_000);
        expect(p.shown).toEqual([]);
    });

    it('a member who presses home while the prompt is open: the leave starts when the prompt closes', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        p.appLockPrompt(400, 2_000);
        p.appState(400, 'inactive');
        // Home pressed during the prompt; the phone cancels it at 2 s. The answer landed at 900 ms, held.
        p.appState(1_900, 'background');
        // Back two minutes later: not a safe moment of its own, but what was held goes up (nothing was started since).
        p.appState(2_000 + 2 * 60 * 1000, 'active');
        await p.run(2_000 + 2 * 60 * 1000 + 5_000);
        expect(p.firstShownAt()).toBe(2_000 + 2 * 60 * 1000);
        expect(p.asked).toBe(1);
    });

    it('back five minutes or more after that leave: a safe moment of its own, so the community is asked again', async () => {
        const p = phone({ answerMs: 900 });
        p.start(0);
        p.appLockPrompt(400, 2_000);
        p.appState(400, 'inactive');
        p.appState(1_900, 'background');
        await p.run(2_000 + SAFE_RETURN_MS - 1);
        // The operator lowered the floor meanwhile: the fresh answer decides, not the held one.
        p.answer = CLEAR;
        p.appState(2_000 + SAFE_RETURN_MS, 'active');
        await p.run(2_000 + SAFE_RETURN_MS + 5_000);
        expect(p.shown).toEqual([]);
        expect(p.asked).toBe(2);
    });

    it('an ordinary leave once the app is back in use is the member leaving: an answer landing after it is dropped', async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        p.appLockPrompt(400, 1_000);
        p.appState(400, 'inactive');
        p.appState(1_000, 'active');
        // In use from 1 s, then off to another app at 2 s with no prompt open; the answer lands at 3 s.
        p.appState(2_000, 'background');
        p.appState(2_000 + 60_000, 'active');
        await p.run(2_000 + 70_000);
        expect(p.shown).toEqual([]);
    });
});

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };

/** A phone with a PIN whose prompts the test answers, and fresh LocalAuth state. */
async function phoneWithPin() {
    vi.resetModules();
    // The phone's since-boot clock (modules/boot-clock), which a door's prompt reads to time its pass.
    (globalThis as ExpoGlobalForTests).expo = { modules: { BeanPoolBootClock: { elapsedMs: () => performance.now() } } };
    const LA = await import('expo-local-authentication');
    const LocalAuth = await import('../LocalAuth');
    const open: Array<(a: { success: boolean; error?: string }) => void> = [];
    vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
    vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
    vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
    vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise((resolve) => open.push(resolve)) as never);
    return {
        LA,
        LocalAuth,
        answer(passes: boolean) {
            const resolve = open.shift();
            expect(resolve, 'no prompt is open').toBeDefined();
            resolve!(passes ? { success: true } : { success: false, error: 'user_cancel' });
        },
    };
}

describe("LocalAuth.isAppLockPromptOpen: App Lock's own prompt, apart from a door's", () => {
    it("open from just before App Lock's prompt opens until its answer, pass or fail", async () => {
        const phone = await phoneWithPin();
        const { LocalAuth } = phone;
        expect(LocalAuth.isAppLockPromptOpen()).toBe(false);
        const asked = LocalAuth.authenticateForAppLock('Unlock BeanPool');
        await flush();
        expect(LocalAuth.isAppLockPromptOpen()).toBe(true);
        let closed = false;
        void LocalAuth.whenAppLockPromptsClose().then(() => { closed = true; });
        await flush();
        expect(closed).toBe(false);
        phone.answer(false);
        expect(await asked).toBe(false);
        await flush();
        expect(LocalAuth.isAppLockPromptOpen()).toBe(false);
        expect(closed).toBe(true);
    });

    it("a door's prompt (the 12 words, a payment) is not App Lock's: the update screen never waits on it", async () => {
        const phone = await phoneWithPin();
        const { LocalAuth } = phone;
        const asked = LocalAuth.authenticateUser('Confirm your security to view your recovery phrase.');
        await flush();
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(true);
        expect(LocalAuth.isAppLockPromptOpen()).toBe(false);
        phone.answer(true);
        expect(await asked).toBe(true);
    });

    it('a prompt that throws closes it too; a phone with no screen lock never opens one', async () => {
        const phone = await phoneWithPin();
        const { LA, LocalAuth } = phone;
        vi.mocked(LA.authenticateAsync).mockRejectedValueOnce(new Error('prompt failed'));
        expect(await LocalAuth.authenticateForAppLock('Unlock BeanPool')).toBe(false);
        expect(LocalAuth.isAppLockPromptOpen()).toBe(false);

        vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.NONE);
        expect(await LocalAuth.authenticateForAppLock('Unlock BeanPool')).toBe(true);
        expect(LocalAuth.isAppLockPromptOpen()).toBe(false);
        await expect(LocalAuth.whenAppLockPromptsClose()).resolves.toBeUndefined();
    });

    it('the real prompt and the real gate: the block held through the unlock goes up right after it', async () => {
        const phone = await phoneWithPin();
        const { LocalAuth } = phone;
        const { createForceUpdateGate } = await import('../force-update');
        let t = 0;
        let release!: (d: { kind: 'block'; version: string }) => void;
        const shown: unknown[] = [];
        const gate = createForceUpdateGate({
            now: () => t,
            check: () => new Promise((resolve) => { release = resolve; }),
            show: (b) => shown.push(b),
            appLockPromptOpen: LocalAuth.isAppLockPromptOpen,
            whenAppLockPromptsClose: LocalAuth.whenAppLockPromptsClose,
        });
        // A cold start; App Lock's launch prompt opens and takes the app out of the front (iOS: inactive).
        void gate.start('active');
        const unlocked = LocalAuth.authenticateForAppLock('Unlock BeanPool');
        await flush();
        await gate.appStateChanged('inactive');
        t = 900;
        release({ kind: 'block', version: '1.2.61' });
        await flush();
        expect(shown).toEqual([]);
        // The member passes it.
        t = 1_600;
        phone.answer(true);
        expect(await unlocked).toBe(true);
        await gate.appStateChanged('active');
        await flush();
        expect(shown).toEqual([{ version: '1.2.61' }]);
    });
});

describe('the block, as it is wired: its gate hears App Lock (components/ForceUpdateBlock.tsx)', () => {
    it("asks LocalAuth whether App Lock's own prompt is open, and waits for it to close", () => {
        const block = code(fs.readFileSync(path.join(NATIVE, 'components/ForceUpdateBlock.tsx'), 'utf8'));
        expect(block).toContain('appLockPromptOpen: isAppLockPromptOpen,');
        expect(block).toContain('whenAppLockPromptsClose,');
        expect(block).toMatch(/import \{[^}]*\bisAppLockPromptOpen, whenAppLockPromptsClose \} from '\.\.\/utils\/LocalAuth';/);
    });
});
