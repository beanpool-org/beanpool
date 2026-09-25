import { describe, it, expect, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
// owner-words.ts reaches identity.ts (the one words check, and the save it offers); nothing here stores an identity.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8, OWNER_WORDS_CHECK_RENEW_MS } from '@beanpool/core';
import {
    OWNER_WORDS_COPY, OWNER_WORDS_INITIAL, cachedOwnerWordsStatus, checkMyWords, fetchOwnerWordsStatus,
    forgetOwnerWordsStatus, laterKey, ownerWordsReducer, readLaterRound, rememberLater, sendOwnerWordsAttestation,
    shouldPromptOwner, typedWordCount, type KeyValueStore,
} from '../owner-words';
import { OWNER_WORDS_TEXT_ON, OWNER_WORDS_TOUCH_TARGETS, ownerWordsStyleSpec } from '../owner-words-style';
import { lightColors, darkColors } from '../../constants/colors';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
/** A native identity: the raw 32-byte seed. */
const NATIVE = { publicKey: PUB, privateKey: bytesToHex(SEED), callsign: 'anna', createdAt: '', mnemonic: WORDS };
/** An identity imported from the PWA: 48-byte PKCS8. */
const FROM_PWA = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'anna', createdAt: '' };
const NODE = 'https://test.beanpool.org/';

function memoryStore() {
    const data = new Map<string, string>();
    const store: KeyValueStore & { data: Map<string, string> } = {
        data,
        getItem: vi.fn(async (k: string) => data.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
    };
    return store;
}

type Reply = { status: number; body?: unknown };
function mockFetch(reply: Reply | ((url: string, init?: RequestInit) => Reply)) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const r = typeof reply === 'function' ? reply(url, init) : reply;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    });
    vi.stubGlobal('fetch', fn);
    return calls;
}

afterEach(() => { vi.unstubAllGlobals(); forgetOwnerWordsStatus(); });

describe('checkMyWords (on the phone)', () => {
    it('the right words match a native (raw seed) account', async () => {
        expect(await checkMyWords(WORDS.join(' '), NATIVE)).toEqual({ matches: true });
    });
    it('the right words match an account imported from the PWA (PKCS8)', async () => {
        expect(await checkMyWords(WORDS.join(' '), FROM_PWA)).toEqual({ matches: true });
    });
    it('the wrong words do not match, with no hint which word', async () => {
        const wrong = [...WORDS];
        wrong[3] = 'zoo';
        expect(await checkMyWords(wrong.join(' '), NATIVE)).toEqual({ matches: false, reason: 'mismatch' });
        expect(OWNER_WORDS_COPY.mismatch).toBe("These aren't the words for this account.");
    });
    it('never reads the stored mnemonic: a phone that holds the words cannot pass by comparing them with themselves', async () => {
        const noWords = { ...NATIVE, mnemonic: undefined };
        expect(await checkMyWords(WORDS.join(' '), noWords)).toEqual({ matches: true });
        const otherWordsStored = { ...NATIVE, mnemonic: ['not', 'these'] };
        expect(await checkMyWords(WORDS.join(' '), otherWordsStored)).toEqual({ matches: true });
    });
    it('counts typed words for the hint', () => {
        expect(typedWordCount('  one two\nthree ')).toBe(3);
        expect(typedWordCount('')).toBe(0);
    });
});

describe('the words never leave the phone and are never stored', () => {
    it('a full check sends only the statement, and stores only the Later round', async () => {
        const store = memoryStore();
        const localStorageSet = vi.fn();
        vi.stubGlobal('localStorage', { setItem: localStorageSet, getItem: vi.fn() });
        const calls = mockFetch({ status: 200, body: { success: true, wordsCheckedAt: 123 } });

        const typed = WORDS.join(' ');
        expect(await checkMyWords(typed, NATIVE)).toEqual({ matches: true });
        expect(await sendOwnerWordsAttestation(NODE, NATIVE)).toBe(123);
        await rememberLater(store, NATIVE.publicKey, { owner: true, wordsCheckedAt: 123 });

        expect(calls).toHaveLength(1);
        const body = String(calls[0].init?.body);
        expect(JSON.parse(body)).toEqual({ attestation: 'owner-12-words-checked' });
        const everything = JSON.stringify(calls) + JSON.stringify([...store.data]);
        for (const w of WORDS) expect(everything).not.toContain(w);
        expect(everything).not.toContain(bytesToHex(SEED));
        expect([...store.data.keys()]).toEqual([laterKey(NATIVE.publicKey)]);
        expect([...store.data.values()]).toEqual(['renew:123']);
        expect(localStorageSet).not.toHaveBeenCalled();
    });

    it('the attestation is signed by the account key, for a native and a PWA-format key alike', async () => {
        for (const who of [NATIVE, FROM_PWA]) {
            const calls = mockFetch({ status: 200, body: { wordsCheckedAt: 1 } });
            await sendOwnerWordsAttestation(NODE, who);
            const h = calls[0].init!.headers as Record<string, string>;
            const msg = `POST\n/api/node/owner/words-check\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${calls[0].init!.body}`;
            const sig = Uint8Array.from(Buffer.from(h['X-Signature'], 'base64'));
            expect(h['X-Public-Key']).toBe(PUB);
            expect(ed25519.verify(sig, utf8ToBytes(msg), hexToBytes(PUB))).toBe(true);
            expect(calls[0].url).toBe('https://test.beanpool.org/api/node/owner/words-check');
        }
    });

    it('a node that cannot be reached answers null, and the check still said yes', async () => {
        mockFetch({ status: 503 });
        expect(await sendOwnerWordsAttestation(NODE, NATIVE)).toBeNull();
    });
});

describe('screen state: the typed words are cleared after the check', () => {
    it('cleared after a match, and after a miss', () => {
        let s = ownerWordsReducer(OWNER_WORDS_INITIAL, { type: 'typed', text: WORDS.join(' ') });
        expect(s.typed).toContain('abandon');
        s = ownerWordsReducer(s, { type: 'checking' });
        const matched = ownerWordsReducer(s, { type: 'answered', result: { matches: true }, countSeen: 12 });
        expect(matched.typed).toBe('');
        expect(matched.outcome).toBe('match');
        expect(matched.record).toBe('sending');
        const missed = ownerWordsReducer(s, { type: 'answered', result: { matches: false, reason: 'mismatch' }, countSeen: 12 });
        expect(missed.typed).toBe('');
        expect(missed.outcome).toBe('mismatch');
        expect(JSON.stringify(matched) + JSON.stringify(missed)).not.toContain('abandon');
    });
    it('not 12 words: nothing was checked, so what was typed stays, with the count', () => {
        const s = ownerWordsReducer({ ...OWNER_WORDS_INITIAL, typed: 'a b c' }, { type: 'answered', result: { matches: false, reason: 'count' }, countSeen: 3 });
        expect(s.typed).toBe('a b c');
        expect(s.outcome).toBe('count');
        expect(OWNER_WORDS_COPY.count(s.countSeen)).toBe("That's 3 words. Type all 12, in order.");
    });
    it('clear (app to background, screen closed) empties everything', () => {
        const s = ownerWordsReducer({ ...OWNER_WORDS_INITIAL, typed: WORDS.join(' ') }, { type: 'clear' });
        expect(s).toEqual(OWNER_WORDS_INITIAL);
    });
    it('recorded: saved with a date, or failed', () => {
        expect(ownerWordsReducer(OWNER_WORDS_INITIAL, { type: 'recorded', at: 5 })).toMatchObject({ record: 'saved', recordedAt: 5 });
        expect(ownerWordsReducer(OWNER_WORDS_INITIAL, { type: 'recorded', at: null })).toMatchObject({ record: 'failed' });
    });
});

describe('status from the node', () => {
    it('an owner gets their date; a member (403) is simply not an owner; no answer is null', async () => {
        mockFetch({ status: 200, body: { owner: true, wordsCheckedAt: 42 } });
        expect(await fetchOwnerWordsStatus(NODE, NATIVE)).toEqual({ owner: true, wordsCheckedAt: 42 });
        mockFetch({ status: 403, body: { owner: false } });
        expect(await fetchOwnerWordsStatus(NODE, NATIVE)).toEqual({ owner: false, wordsCheckedAt: null });
        mockFetch({ status: 500 });
        expect(await fetchOwnerWordsStatus(NODE, NATIVE)).toBeNull();
        mockFetch({ status: 404 });
        expect(await fetchOwnerWordsStatus(NODE, NATIVE)).toBeNull();
    });
    it('the home prompt asks at most once per ten minutes, and a check forgets the answer', async () => {
        const calls = mockFetch({ status: 200, body: { owner: true, wordsCheckedAt: null } });
        await cachedOwnerWordsStatus(NODE, NATIVE, 1_000);
        await cachedOwnerWordsStatus(NODE, NATIVE, 2_000);
        expect(calls).toHaveLength(1);
        forgetOwnerWordsStatus();
        await cachedOwnerWordsStatus(NODE, NATIVE, 3_000);
        expect(calls).toHaveLength(2);
    });
});

describe('prompt cadence: on becoming an owner, then 12 months after the last check', () => {
    const now = Date.UTC(2026, 8, 20);
    it('never shown to someone who is not an owner, or when the node did not answer', () => {
        expect(shouldPromptOwner({ owner: false, wordsCheckedAt: null }, null, now)).toBe(false);
        expect(shouldPromptOwner(null, null, now)).toBe(false);
    });
    it('a new owner is asked once; Later puts it away until a check has happened and a year has passed', async () => {
        const store = memoryStore();
        const never = { owner: true, wordsCheckedAt: null };
        expect(shouldPromptOwner(never, await readLaterRound(store, PUB), now)).toBe(true);
        await rememberLater(store, PUB, never);
        expect(shouldPromptOwner(never, await readLaterRound(store, PUB), now)).toBe(false);
        expect(shouldPromptOwner(never, await readLaterRound(store, PUB), now + 5 * OWNER_WORDS_CHECK_RENEW_MS)).toBe(false);
    });
    it('checked recently: not asked; a year on: asked; Later: put away until the next check', async () => {
        const store = memoryStore();
        const recent = { owner: true, wordsCheckedAt: now - 1000 };
        expect(shouldPromptOwner(recent, null, now)).toBe(false);
        const old = { owner: true, wordsCheckedAt: now - OWNER_WORDS_CHECK_RENEW_MS };
        expect(shouldPromptOwner(old, null, now)).toBe(true);
        await rememberLater(store, PUB, old);
        expect(shouldPromptOwner(old, await readLaterRound(store, PUB), now)).toBe(false);
    });
    it('a storage failure never blocks: the prompt just shows again', async () => {
        const broken: KeyValueStore = { getItem: async () => { throw new Error('x'); }, setItem: async () => { throw new Error('x'); } };
        await expect(rememberLater(broken, PUB, { owner: true, wordsCheckedAt: null })).resolves.toBeUndefined();
        expect(await readLaterRound(broken, PUB)).toBeNull();
    });
});

// ── Small screens and both themes: the rules the styles are held to (no device renderer in this runner) ──

function luminance(hex: string): number {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('styles in %s', (_name, colors) => {
    const spec = ownerWordsStyleSpec(colors as typeof lightColors) as Record<string, Record<string, unknown>>;

    it('every touch target is at least 48dp tall', () => {
        for (const k of OWNER_WORDS_TOUCH_TARGETS) expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
    });
    it('nothing has a fixed width or height, so text wraps and boxes grow at 320dp and 1.3× text', () => {
        for (const [k, v] of Object.entries(spec)) {
            expect(v.width, `${k}.width`).toBeUndefined();
            expect(v.height, `${k}.height`).toBeUndefined();
            expect(v.maxHeight, `${k}.maxHeight`).toBeUndefined();
        }
    });
    it('the two prompt buttons wrap onto their own lines rather than squeeze (flex-basis 120dp each)', () => {
        expect(spec.buttonRow.flexWrap).toBe('wrap');
        // 320dp less the card's margins (32) and padding (32) leaves 256dp: two 120dp buttons and the 10dp gap
        // fit at 1×; their labels grow at 1.3× and flexGrow lets each take the line when they no longer fit.
        expect(Number(spec.primaryBtn.flexBasis) * 2 + Number(spec.buttonRow.gap)).toBeLessThanOrEqual(320 - 64);
        expect(spec.primaryBtn.flexGrow).toBe(1);
        expect(spec.secondaryBtn.flexGrow).toBe(1);
    });
    it('text is readable on its background (WCAG AA, 4.5:1)', () => {
        for (const [text, bg] of Object.entries(OWNER_WORDS_TEXT_ON)) {
            const fg = String(spec[text].color);
            const back = String(spec[bg].backgroundColor);
            expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
            expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
        }
    });
});
