/**
 * The full-screen "Update required" (utils/force-update.ts) never lands on what the member started after its safe
 * moment, however short the leave that started it.
 *
 * #1415's re-review (NON-BLOCKING, force-update.ts:176): the gate checked only that the app was in front when the answer
 * landed. A door's prompt (the 12 words, a payment) takes the app out of the front and back, so one that opened and
 * closed before a slow answer landed let the block go up over the words just shown, or mid-payment. Measured there on
 * a virtual clock with the real LocalAuth under the real gate; each row is driven here the same way. Now the gate counts
 * every ordinary leave, and an answer goes up only if none came since its safe moment.
 *
 * Nothing here contacts a node: the clock, the community's answer and the phone's prompts are the test's.
 */
import { describe, it, expect, vi } from 'vitest';
import { SAFE_RETURN_MS } from '../force-update';
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the re-review's table: a door's prompt between the safe moment and the answer", () => {
    it('cold start; the words\' prompt from 1.0 to 2.0 s; the answer at 3.0 s: never shown over the words', async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        p.appState(1_000, 'inactive');
        p.appState(2_000, 'active');
        await p.run(SAFE_RETURN_MS - 1);
        expect(p.shown).toEqual([]);
        expect(p.asked).toBe(1);
    });

    it("return after 6 min; App Lock's prompt +0.08 to +1.3 s; Send Beans' prompt +3 to +4 s; the answer at +5 s: never shown mid-payment", async () => {
        const p = phone({ answerMs: 5_000 });
        p.answer = CLEAR;
        p.start(0);
        p.appState(1_000, 'background');
        const back = 1_000 + 6 * 60 * 1000;
        await p.run(back - 1);
        p.answer = BLOCK;
        p.appState(back, 'active');
        p.appLockPrompt(back + 80, back + 1_300);
        p.appState(back + 80, 'inactive');
        p.appState(back + 1_300, 'active');
        // The payment's confirmation: a door's prompt, an ordinary leave.
        p.appState(back + 3_000, 'inactive');
        p.appState(back + 4_000, 'active');
        await p.run(back + 60_000);
        expect(p.shown).toEqual([]);
        expect(p.asked).toBe(2);
    });

    it("control: the door's prompt still open when the answer lands: dropped", async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        p.appState(1_000, 'inactive');
        p.appState(4_000, 'active');
        await p.run(60_000);
        expect(p.shown).toEqual([]);
    });

    it('the dropped answer waits for the next safe moment, which asks anew and puts it up', async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        p.appState(1_000, 'inactive');
        p.appState(2_000, 'active');
        p.appState(10_000, 'background');
        const back = 10_000 + SAFE_RETURN_MS;
        p.appState(back, 'active');
        await p.run(back + 5_000);
        expect(p.firstShownAt()).toBe(back + 3_000);
        expect(p.asked).toBe(2);
    });

    it("with no leave since the safe moment, a slow answer inside the limit still goes up (unchanged)", async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        await p.run(10_000);
        expect(p.firstShownAt()).toBe(3_000);
    });

    it("App Lock's own prompt between the safe moment and the answer is still not a leave (unchanged)", async () => {
        const p = phone({ answerMs: 3_000 });
        p.start(0);
        p.appLockPrompt(400, 1_600);
        p.appState(400, 'inactive');
        p.appState(1_600, 'active');
        await p.run(10_000);
        expect(p.firstShownAt()).toBe(3_000);
    });

    it('a switch of community is a safe moment of its own: a leave before it does not count against its answer', async () => {
        const p = phone({ answerMs: 3_000 });
        p.answer = CLEAR;
        p.start(0);
        p.appState(1_000, 'inactive');
        p.appState(2_000, 'active');
        await p.run(5_000);
        p.answer = BLOCK;
        p.switched(6_000);
        await p.run(20_000);
        expect(p.firstShownAt()).toBe(9_000);
    });

    it('a door prompt after a switch, before its answer: dropped', async () => {
        const p = phone({ answerMs: 3_000 });
        p.answer = CLEAR;
        p.start(0);
        await p.run(5_000);
        p.answer = BLOCK;
        p.switched(6_000);
        p.appState(7_000, 'inactive');
        p.appState(8_000, 'active');
        await p.run(20_000);
        expect(p.shown).toEqual([]);
    });
});

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };

describe('the real LocalAuth under the real gate', () => {
    it("the words' prompt (authenticateUser) opens and closes before the answer: the block does not land on the words", async () => {
        vi.resetModules();
        (globalThis as ExpoGlobalForTests).expo = { modules: { BeanPoolBootClock: { elapsedMs: () => performance.now() } } };
        const LA = await import('expo-local-authentication');
        const LocalAuth = await import('../LocalAuth');
        const open: Array<(a: { success: boolean }) => void> = [];
        vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
        vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
        vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
        vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise((resolve) => open.push(resolve)) as never);
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
        void gate.start('active');
        // At 1 s the member asks for their words: the phone's prompt makes the app inactive until it passes at 2 s.
        t = 1_000;
        const asked = LocalAuth.authenticateUser('Confirm your security to view your recovery phrase.');
        await flush();
        await gate.appStateChanged('inactive');
        t = 2_000;
        open.shift()!({ success: true });
        expect(await asked).toBe(true);
        await gate.appStateChanged('active');
        // The community's answer lands at 3 s, with the words on screen.
        t = 3_000;
        release({ kind: 'block', version: '1.2.61' });
        await flush();
        await flush();
        expect(shown).toEqual([]);
    });
});
