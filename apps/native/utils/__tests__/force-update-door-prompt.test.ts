/**
 * The full-screen "Update required" (utils/force-update.ts) never lands on a door's prompt (the 12 words, a payment),
 * even on a phone where that prompt never changes AppState.
 *
 * #1415's third deciding review (NON-BLOCKING, force-update.ts:185, fix before the build): the gate counted a door's
 * prompt as leaving only through AppState. On iOS ('inactive') and Android 8-10's PIN screen ('background') that works.
 * On Android 11 and later, and with a fingerprint on 8-10, expo-local-authentication asks through androidx
 * BiometricPrompt, a system window over the app: the app is never paused, AppState never changes, and the block landed
 * over the words just confirmed, or behind a payment's open prompt. Measured there with the real LocalAuth under the real
 * gate on a virtual clock; each row is driven here the same way, with expo-local-authentication mocked to change nothing
 * in AppState. LocalAuth now counts every door's prompt (LocalAuth.doorPrompts), and the gate drops a "block" answer
 * when one opened since its safe moment or is open when it lands.
 *
 * Nothing here contacts a node: the clock, the community's answer and the phone's prompts are the test's.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SAFE_RETURN_MS, type ForceUpdateDecision } from '../force-update';

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

const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const NATIVE = path.resolve(__dirname, '../..');
/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const BLOCK: ForceUpdateDecision = { kind: 'block', version: '1.2.61' };
const WORDS = 'Confirm your security to view your recovery phrase.';
const SEND = 'Confirm to send Beans.';

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };

/**
 * A phone with a PIN on Android 11 or later: the real LocalAuth, whose prompts the test answers and which change nothing
 * in AppState, under the real gate wired as components/ForceUpdateBlock.tsx wires it, on a virtual clock. The community
 * answers when the test says.
 */
async function android11Phone() {
    vi.resetModules();
    vi.clearAllMocks();
    (globalThis as ExpoGlobalForTests).expo = { modules: { BeanPoolBootClock: { elapsedMs: () => performance.now() } } };
    const LA = await import('expo-local-authentication');
    const LocalAuth = await import('../LocalAuth');
    const prompts: Array<(a: { success: boolean; error?: string }) => void> = [];
    vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
    vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
    vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
    vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise((resolve) => prompts.push(resolve)) as never);
    const { createForceUpdateGate } = await import('../force-update');
    let t = 0;
    const answers: Array<(d: ForceUpdateDecision) => void> = [];
    const shown: Array<{ at: number; block: { version: string } | null }> = [];
    let asked = 0;
    const gate = createForceUpdateGate({
        now: () => t,
        check: () => { asked++; return new Promise((resolve) => answers.push(resolve)); },
        show: (block) => shown.push({ at: t, block }),
        appLockPromptOpen: LocalAuth.isAppLockPromptOpen,
        whenAppLockPromptsClose: LocalAuth.whenAppLockPromptsClose,
        doorPrompts: LocalAuth.doorPrompts,
    });
    return {
        LA,
        LocalAuth,
        gate,
        shown,
        get asked() { return asked; },
        at(ms: number) { t = ms; },
        /** The community answers the oldest ask still waiting. */
        async communityAnswers(d: ForceUpdateDecision = BLOCK) {
            const resolve = answers.shift();
            expect(resolve, 'nothing was asked').toBeDefined();
            resolve!(d);
            await flush();
        },
        /** The open prompt is answered: the member passes it (or cancels). */
        async promptAnswered(passes = true) {
            const resolve = prompts.shift();
            expect(resolve, 'no prompt is open').toBeDefined();
            resolve!(passes ? { success: true } : { success: false, error: 'user_cancel' });
            await flush();
        },
    };
}

describe("the reviewer's rows: a door's prompt that never changes AppState (Android 11+)", () => {
    it("cold start; the words' prompt from 1.0 to 2.0 s; the answer at 3.0 s: not over the words, and up at the next safe moment", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(1_000);
        const words = p.LocalAuth.authenticateUser(WORDS);
        await flush();
        expect(p.LA.authenticateAsync).toHaveBeenCalledTimes(1);
        p.at(2_000);
        await p.promptAnswered(true);
        expect(await words).toBe(true);
        // The community's answer lands at 3 s, with the words on screen.
        p.at(3_000);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
        // The next safe moment, a return after five minutes away, asks anew and puts it up.
        p.at(60_000);
        await p.gate.appStateChanged('background');
        const back = 60_000 + SAFE_RETURN_MS;
        p.at(back);
        void p.gate.appStateChanged('active');
        await flush();
        expect(p.asked).toBe(2);
        p.at(back + 600);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([{ at: back + 600, block: { version: '1.2.61' } }]);
    });

    it("cold start; Send Beans' prompt opens at 2.0 s; the answer at 2.5 s; the prompt passes at 4.0 s: never shown, the payment goes ahead with nothing over it", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(2_000);
        const send = p.LocalAuth.authenticateUser(SEND);
        await flush();
        expect(p.LA.authenticateAsync).toHaveBeenCalledTimes(1);
        p.at(2_500);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
        p.at(4_000);
        await p.promptAnswered(true);
        expect(await send).toBe(true);
        await flush();
        expect(p.shown).toEqual([]);
    });

    it("a cancelled door prompt counts the same: the member was still in the middle of something", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(1_000);
        const words = p.LocalAuth.authenticateUser(WORDS);
        await flush();
        p.at(1_500);
        await p.promptAnswered(false);
        expect(await words).toBe(false);
        p.at(3_000);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
    });

    it("node-admin's own prompt (phoneLockPrompt, Manage community and the rest) is a door's too", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(1_000);
        const res = p.LocalAuth.phoneLockPrompt({ promptMessage: 'Manage community', disableDeviceFallback: false });
        await flush();
        p.at(2_000);
        await p.promptAnswered(true);
        await res;
        p.at(3_000);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
    });

    it('control (iOS): the same words\' prompt with inactive / active is still dropped', async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(1_000);
        const words = p.LocalAuth.authenticateUser(WORDS);
        await flush();
        await p.gate.appStateChanged('inactive');
        p.at(2_000);
        await p.promptAnswered(true);
        expect(await words).toBe(true);
        await p.gate.appStateChanged('active');
        p.at(3_000);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
    });

    it('with no prompt since the safe moment, a slow answer inside the limit still goes up (unchanged)', async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(3_000);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([{ at: 3_000, block: { version: '1.2.61' } }]);
    });

    it("a door's prompt before the safe moment does not count against it", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        p.at(500);
        await p.communityAnswers({ kind: 'clear' });
        p.at(1_000);
        const words = p.LocalAuth.authenticateUser(WORDS);
        await flush();
        p.at(2_000);
        await p.promptAnswered(true);
        await words;
        // Back after five minutes away: a safe moment of its own.
        await p.gate.appStateChanged('background');
        const back = 2_000 + SAFE_RETURN_MS;
        p.at(back);
        void p.gate.appStateChanged('active');
        await flush();
        p.at(back + 600);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([{ at: back + 600, block: { version: '1.2.61' } }]);
    });
});

describe("App Lock's own prompt keeps its marker: held, not a leave (unchanged)", () => {
    it("App Lock's launch prompt with no AppState change: the answer is held and goes up right after the unlock", async () => {
        const p = await android11Phone();
        void p.gate.start('active');
        const unlocked = p.LocalAuth.authenticateForAppLock('Unlock BeanPool');
        await flush();
        expect(p.LocalAuth.isAppLockPromptOpen()).toBe(true);
        p.at(900);
        await p.communityAnswers(BLOCK);
        expect(p.shown).toEqual([]);
        p.at(1_600);
        await p.promptAnswered(true);
        expect(await unlocked).toBe(true);
        await flush();
        expect(p.shown).toEqual([{ at: 1_600, block: { version: '1.2.61' } }]);
    });

    it("a block held through App Lock's prompt is dropped if a door's prompt opens before it can go up", async () => {
        const { createForceUpdateGate } = await import('../force-update');
        let appLockOpen = true;
        let closeAppLock!: () => void;
        const doors = { opened: 0, open: false };
        let release!: (d: ForceUpdateDecision) => void;
        const shown: unknown[] = [];
        const gate = createForceUpdateGate({
            now: () => 0,
            check: () => new Promise((resolve) => { release = resolve; }),
            show: (b) => shown.push(b),
            appLockPromptOpen: () => appLockOpen,
            whenAppLockPromptsClose: () => (appLockOpen ? new Promise<void>((resolve) => { closeAppLock = resolve; }) : Promise.resolve()),
            doorPrompts: () => ({ ...doors }),
        });
        void gate.start('active');
        release(BLOCK);
        await flush();
        expect(shown).toEqual([]);
        // A door's prompt (on a phone where two can be open) opens before App Lock's closes.
        doors.opened = 1;
        doors.open = true;
        appLockOpen = false;
        closeAppLock();
        await flush();
        expect(shown).toEqual([]);
        doors.open = false;
        await gate.appStateChanged('active');
        await flush();
        expect(shown).toEqual([]);
    });
});

describe('LocalAuth.doorPrompts: every prompt but App Lock\'s', () => {
    it("counts a door's prompt from just before it opens, open until its answer, pass, fail or throw", async () => {
        const p = await android11Phone();
        const { LocalAuth, LA } = p;
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 0, open: false });
        const first = LocalAuth.authenticateUser(WORDS);
        await flush();
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 1, open: true });
        await p.promptAnswered(false);
        expect(await first).toBe(false);
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 1, open: false });
        vi.mocked(LA.authenticateAsync).mockRejectedValueOnce(new Error('prompt failed'));
        expect(await LocalAuth.authenticateUser(WORDS)).toBe(false);
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 2, open: false });
    });

    it("App Lock's unlock is not counted; a phone with no lock opens no prompt and counts nothing", async () => {
        const p = await android11Phone();
        const { LocalAuth, LA } = p;
        const unlock = LocalAuth.authenticateForAppLock('Unlock BeanPool');
        await flush();
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 0, open: false });
        await p.promptAnswered(true);
        await unlock;
        vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.NONE);
        expect(await LocalAuth.authenticateUser(WORDS)).toBe(true);
        expect(LocalAuth.doorPrompts()).toEqual({ opened: 0, open: false });
    });

    it('a doorPrompts that throws or answers nonsense never puts the block up', async () => {
        const { createForceUpdateGate } = await import('../force-update');
        for (const doorPrompts of [
            () => { throw new Error('no'); },
            () => ({ opened: 'x' as unknown as number, open: false }),
        ]) {
            let release!: (d: ForceUpdateDecision) => void;
            const shown: unknown[] = [];
            const gate = createForceUpdateGate({
                now: () => 0,
                check: () => new Promise((resolve) => { release = resolve; }),
                show: (b) => shown.push(b),
                doorPrompts,
            });
            void gate.start('active');
            release(BLOCK);
            await flush();
            expect(shown).toEqual([]);
        }
    });
});

describe('the block, as it is wired: its gate hears every door prompt (components/ForceUpdateBlock.tsx)', () => {
    it('passes LocalAuth.doorPrompts to the gate', () => {
        const block = code(fs.readFileSync(path.join(NATIVE, 'components/ForceUpdateBlock.tsx'), 'utf8'));
        expect(block).toMatch(/createForceUpdateGate\(\{[\s\S]*?doorPrompts,[\s\S]*?\}\);/);
        expect(block).toMatch(/import \{[^}]*\bdoorPrompts\b[^}]*\} from '\.\.\/utils\/LocalAuth';/);
    });

    it("App Lock's prompt is the only one not counted as a door's: no other file asks phoneLockPrompt for 'app-lock'", () => {
        const localAuth = code(fs.readFileSync(path.join(NATIVE, 'utils/LocalAuth.ts'), 'utf8'));
        expect(localAuth).toContain("}, door ? 'door' : 'app-lock');");
        expect(localAuth).toMatch(/kind: 'door' \| 'app-lock' = 'door'/);
        const nodeAdmin = code(fs.readFileSync(path.join(NATIVE, 'utils/node-admin.ts'), 'utf8'));
        expect(nodeAdmin).toContain('phoneLockPrompt(');
        expect(nodeAdmin).not.toContain('app-lock');
    });
});
