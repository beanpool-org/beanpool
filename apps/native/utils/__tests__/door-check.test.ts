/**
 * The person check at the 12-words door, the phone's half (utils/door-check.ts, utils/door-work.ts, utils/global-join.ts):
 * reading the node's answers, staying on the check's page, and getting past the check at the tap that needs it, in every
 * way it can end: a token, the node refusing the token, a check that wouldn't load, and the member closing it. Nothing
 * contacts a node or Cloudflare.
 */
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn(() => new Uint8Array(32)), digest: vi.fn() }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));

const { checkPageMayLoad, doorCheckUrl, readCheckMessage, readDoorCheck } = await import('../door-check');
const { busyLevelSentence, DOOR_WORK_MESSAGES, passDoorCheck, startDoorWork, workPastCheck } = await import('../door-work');
const { DOOR_MESSAGES, nextStepFor, readDoorAnswer, readWordsDoorAnswer } = await import('../global-join');

const PAGE = 'https://check.beanpool.org/';
const CHECK = { siteKey: '0x4AAA', page: PAGE };
const KEY = 'ab'.repeat(32);
const REQUIRED = { error: 'server words', code: 'check_required', turnstile: CHECK };
const identity = { publicKey: KEY, privateKey: 'x', callsign: 'Bea' } as any;

const issued = { kind: 'work' as const, work: { challenge: 'v1.2.1.r.m', level: 2, parts: 8, bits: 9, size: 65_536, expiresInSeconds: 600 }, receivedAt: 0 };

/** A run whose work route asks for the check until it hears `good`. */
function runAtBusyDoor(good = 'tok') {
    const asked: Array<string | undefined> = [];
    const fetchWork = vi.fn(async (_u: string, _i: any, _d: any, o?: { turnstile?: string }) => {
        asked.push(o?.turnstile);
        if (o?.turnstile === good) return issued;
        const answer = o?.turnstile ? readWordsDoorAnswer(403, { error: 'no', code: 'check_failed' }) : readWordsDoorAnswer(429, REQUIRED);
        return { kind: 'refused' as const, answer };
    });
    const solve = vi.fn(async () => ({ counters: [1, 2, 3, 4, 5, 6, 7, 8], tries: 8, ms: 1 }));
    const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: fetchWork as any, solve, now: () => 1_000, setTimer: () => 1, clearTimer: () => {} });
    return { run, asked, solve };
}

describe('what the node says', () => {
    it('check_required is the check, with a sentence of the phone\'s own, and stays on the door', () => {
        const answer = readDoorAnswer(429, REQUIRED);
        expect(answer).toEqual({ kind: 'check', check: CHECK, message: DOOR_MESSAGES.checkNeeded });
        expect(nextStepFor(answer)).toBe('retry');
    });

    it('a page this phone can\'t open is the sentence, never a dead end', () => {
        const answer = readDoorAnswer(429, { ...REQUIRED, turnstile: { siteKey: 'k', page: 'http://check' } });
        expect(answer).toEqual({ kind: 'try_again', message: DOOR_MESSAGES.checkNeeded });
        expect(readDoorCheck({ turnstile: null })).toBeNull();
    });

    it('check_failed says so and stays on the door, where a 403 would otherwise read as a shut door', () => {
        const answer = readDoorAnswer(403, { error: 'no', code: 'check_failed' });
        expect(answer).toEqual({ kind: 'try_again', message: DOOR_MESSAGES.checkFailed });
        expect(nextStepFor(answer)).toBe('retry');
    });

    it('every sentence points to the sign-in door', () => {
        for (const line of [DOOR_MESSAGES.checkNeeded, DOOR_MESSAGES.checkFailed, DOOR_MESSAGES.checkWontLoad, DOOR_WORK_MESSAGES.checkFirst]) expect(line).toMatch(/sign in/i);
    });
});

describe('the page', () => {
    it('opens on the fragment, with the first 32 hex of the key', () => {
        expect(doorCheckUrl(CHECK, KEY, 'dark')).toBe(`${PAGE}#sitekey=0x4AAA&cdata=${'ab'.repeat(16)}&theme=dark`);
    });

    it('the embedded browser stays on the check\'s page: frames may load, nothing else takes the top', () => {
        expect(checkPageMayLoad(`${PAGE}#x`, true, PAGE)).toBe(true);
        expect(checkPageMayLoad('https://challenges.cloudflare.com/x', false, PAGE)).toBe(true);
        expect(checkPageMayLoad('https://www.cloudflare.com/privacy', true, PAGE)).toBe(false);
        expect(checkPageMayLoad('https://check.beanpool.org.evil.example/', undefined, PAGE)).toBe(false);
        expect(checkPageMayLoad('intent://x', undefined, PAGE)).toBe(false);
    });

    it('hears only the check\'s page', () => {
        expect(readCheckMessage('{"token":"t"}', PAGE, PAGE)).toEqual({ token: 't' });
        expect(readCheckMessage('{"error":"failed"}', PAGE, PAGE)).toEqual({ error: 'failed' });
        expect(readCheckMessage('{"ready":true}', PAGE, PAGE)).toEqual({ ready: true });
        expect(readCheckMessage('{"token":"t"}', 'https://evil.example/', PAGE)).toBeNull();
        expect(readCheckMessage('not json', PAGE, PAGE)).toBeNull();
    });
});

describe('at the tap that needs it', () => {
    it('no work is done before the check; its token asks once, and the join gets the work', async () => {
        const { run, asked, solve } = runAtBusyDoor();
        const ask = vi.fn(async () => ({ kind: 'token' as const, token: 'tok' }));
        const out = await workPastCheck(run, new AbortController().signal, ask);
        expect(out).toMatchObject({ kind: 'solved', work: { challenge: issued.work.challenge } });
        expect(ask).toHaveBeenCalledWith(CHECK, KEY);
        expect(asked.filter(Boolean)).toEqual(['tok']);
        expect(solve).toHaveBeenCalledTimes(1);
    });

    it('nothing opens at a door that isn\'t busy', async () => {
        const fetchWork = vi.fn(async () => issued);
        const run = startDoorWork({
            url: 'https://global.test', identity, door: 'words', fetchWork: fetchWork as any,
            solve: vi.fn(async () => ({ counters: [1], tries: 1, ms: 1 })), now: () => 1_000, setTimer: () => 1, clearTimer: () => {},
        });
        const ask = vi.fn();
        expect((await workPastCheck(run, new AbortController().signal, ask)).kind).toBe('solved');
        expect(ask).not.toHaveBeenCalled();
    });

    it('a check that wouldn\'t load: said, with the sign-in door, and no join', async () => {
        const { run } = runAtBusyDoor();
        const out = await workPastCheck(run, new AbortController().signal, async () => ({ kind: 'failed' }));
        expect(out).toEqual({ kind: 'refused', answer: { kind: 'try_again', message: DOOR_MESSAGES.checkWontLoad } });
    });

    it('the node refuses the token: said', async () => {
        const { run } = runAtBusyDoor('another');
        const out = await workPastCheck(run, new AbortController().signal, async () => ({ kind: 'token', token: 'tok' }));
        expect(out).toEqual({ kind: 'refused', answer: { kind: 'try_again', message: DOOR_MESSAGES.checkFailed } });
    });

    it('closed by the member, or the member left: they stay where they were, and nothing is said', async () => {
        const closed = runAtBusyDoor();
        expect(await workPastCheck(closed.run, new AbortController().signal, async () => ({ kind: 'closed' }))).toEqual({ kind: 'cancelled' });
        const left = runAtBusyDoor();
        const stop = new AbortController();
        expect(await passDoorCheck(left.run, CHECK, stop.signal, async () => { stop.abort(); return { kind: 'token', token: 'tok' }; })).toEqual({ kind: 'cancelled' });
        expect(left.asked.filter(Boolean)).toEqual([]);
    });

    it('said before the tap, under the 12-words button', async () => {
        const { run } = runAtBusyDoor();
        await run.solution();
        expect(busyLevelSentence(run.state(), 0)).toBe(DOOR_WORK_MESSAGES.checkFirst);
    });
});
