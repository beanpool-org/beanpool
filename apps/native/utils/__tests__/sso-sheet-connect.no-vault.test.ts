/**
 * The account-protection sheet's connect (components/SsoEnrolSheet.tsx): sign in, then deposit.
 *
 * Its Cancel is honest only if it is offered while a cancel is still honoured: up to the moment the provider is
 * done, and not once the deposit is going ahead. A tap that closed the sheet while the deposit went on, followed a
 * second later by the sheet reporting the account covered, is the failure these guard against.
 *
 * Nothing here contacts a node or a provider: the `fetch` stub below plays the node and refuses anything addressed
 * elsewhere, and Facebook's return is handed to the sign-in as its browser would. The screen cannot be rendered here
 * (see vitest.config.ts), so the last tests check that the sheet calls `connectAndDeposit` and offers no Cancel once
 * it is saving.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    openBrowserAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        // The member's node, which the deposit goes to.
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://test.example' : null)),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

import * as WebBrowser from 'expo-web-browser';
import { signInsToRefresh } from '@beanpool/core';
import { SsoSignInError } from '../sso-signin';
import { connectAndDeposit } from '../sso-sheet-connect';

const NODE = 'https://test.example';
const NONCE = '/api/recovery/sso-nonce';
const DEPOSIT = '/api/recovery/shares/sso';
const NODE_NONCE = 'n-1';

const MEMBER = {
    publicKey: 'aa'.repeat(32),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

type Answer = { status: number; body?: unknown };
interface Seen { url: string; path: string; body: any }

function answer({ status, body = {} }: Answer): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** A Facebook id_token carrying `nonce`. Unsigned: nothing here verifies signatures, the node does. */
function fbIdToken(nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', kid: 'fb-kid-1' })}.${b64({ iss: 'https://www.facebook.com', sub: '10229876543210987', nonce })}.c2ln`;
}

/**
 * Facebook's dialog, answering with an id_token bound to the nonce it was asked with. `onReturn` runs as the
 * return arrives: the moment the provider says yes.
 */
function facebookSaysYes(onReturn: () => void = () => {}): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (authUrl: string) => {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        onReturn();
        return {
            type: 'success',
            url: `https://beanpool.org/auth/facebook#${new URLSearchParams({ id_token: fbIdToken(nonce), state: nonce })}`,
        } as any;
    });
}

/** Play the member's node through a sign-in and a deposit. `onDeposit` runs as the node receives the deposit. */
function installNode(onDeposit: () => void = () => {}): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const p = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path: p, body });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        if (p === NONCE) {
            return answer({ status: 200, body: { nonce: NODE_NONCE, expiresInSeconds: 600, providers: ['facebook'] } });
        }
        if (p === DEPOSIT) {
            onDeposit();
            return answer({ status: 200, body: { generation: 1, enrolledSso: ['facebook'], threshold: 1 } });
        }
        return answer({ status: 404, body: { error: 'Not Found' } });
    }) as any;
    return seen;
}

function paths(seen: Seen[]): string[] {
    return seen.map((s) => s.path);
}

let originalFetch: typeof fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

/** Run the sheet's connect as the sheet does, and let the sign-in's waits pass. */
async function connect(opts: { signal: AbortSignal; onSignedIn?: () => void | Promise<void> }) {
    const outcome = connectAndDeposit({
        provider: 'facebook',
        url: NODE,
        identity: MEMBER,
        // The phone's lock is sign-in-link-behind-lock.test.ts's: these are about the sign-in and the deposit after it.
        phoneLock: null,
        onSignedIn: opts.onSignedIn ?? (() => {}),
        signal: opts.signal,
    }).then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(20_000);
    return outcome;
}

describe("the protection sheet's connect", () => {
    it("tells the sheet the provider is done before anything is deposited, then deposits with the provider's token", async () => {
        const seen = installNode();
        facebookSaysYes();
        let depositedWhenSignedIn: boolean | undefined;

        const { value, error } = await connect({
            signal: new AbortController().signal,
            onSignedIn: () => { depositedWhenSignedIn = paths(seen).includes(DEPOSIT); },
        });

        expect(error).toBeUndefined();
        expect(depositedWhenSignedIn).toBe(false);
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
        const deposit = seen.find((s) => s.path === DEPOSIT)?.body;
        expect(Object.keys(deposit).sort()).toEqual(['idToken', 'nonce', 'provider', 'shares']);
        expect(deposit).toMatchObject({ provider: 'facebook', idToken: fbIdToken(NODE_NONCE), nonce: NODE_NONCE });
        expect(seen.filter((s) => !s.url.startsWith(`${NODE}/`))).toEqual([]);
    });

    it("honours a cancel that lands as the provider says yes, before the deposit: nothing deposited, and it reads as a cancel", async () => {
        const seen = installNode();
        const abort = new AbortController();
        facebookSaysYes(() => abort.abort());

        const { error } = await connect({ signal: abort.signal });

        expect(abort.signal.aborted).toBe(true);
        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(paths(seen)).toEqual([NONCE]);
    });

    it('honours a cancel that lands while the sheet is taking its Cancel down', async () => {
        const seen = installNode();
        facebookSaysYes();
        const abort = new AbortController();

        const { error } = await connect({ signal: abort.signal, onSignedIn: async () => { abort.abort(); } });

        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(paths(seen)).not.toContain(DEPOSIT);
    });

    // Once sent, the deposit may be on the node. Reporting "cancelled" over one the node kept would be
    // the same lie the other way round, so its outcome is reported, and the sheet offers no Cancel then.
    it('reports a deposit that was sent, whatever happens to the sheet meanwhile', async () => {
        const abort = new AbortController();
        const seen = installNode(() => abort.abort());
        facebookSaysYes();

        const { value, error } = await connect({ signal: abort.signal });

        expect(paths(seen)).toContain(DEPOSIT);
        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
    });
});

/**
 * Account Protection's Refresh (recovery S4) is this same connect, for a sign-in whose copy the community's server can't
 * find from the sign-in alone: the node plays a server with S4, whose deposit answer says which sign-ins are findable.
 */
function installS4Node(deposit: Answer): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const p = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        if (p === NONCE) return answer({ status: 200, body: { nonce: NODE_NONCE, expiresInSeconds: 600, providers: ['facebook'] } });
        if (p === DEPOSIT) return answer(deposit);
        return answer({ status: 404, body: { error: 'Not Found' } });
    }) as any;
    return seen;
}

describe('Refresh: the ordinary connect, for a copy the server could not find yet', () => {
    it('sends the two requests every connect sends, asks for no words, and comes back findable, so Refresh goes', async () => {
        const seen = installS4Node({ status: 200, body: { generation: 2, enrolledSso: ['facebook'], findableSso: ['facebook'], threshold: 1 } });
        facebookSaysYes();

        const { value, error } = await connect({ signal: new AbortController().signal });

        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(paths(seen)).toEqual([NONCE, DEPOSIT]);
        expect(Object.keys(seen[1].body).sort()).toEqual(['idToken', 'nonce', 'provider', 'shares']);
        expect(seen[1].body.shares).toHaveLength(1);
        expect(value?.findableSso).toEqual(['facebook']);
        expect(signInsToRefresh(value)).toEqual([]);
    });

    it('a refused deposit says so in words and reports nothing findable: never a false success', async () => {
        installS4Node({ status: 400, body: { error: 'Facebook token is not valid JWT JSON' } });
        facebookSaysYes();

        const { value, error } = await connect({ signal: new AbortController().signal });

        expect(error).toBeUndefined();
        expect(value?.error).toMatch(/node refused the fragments \(400\)/);
        expect(value?.enrolled).toEqual([]);
        expect(value?.findableSso).toBeUndefined();
    });

    it('a server from before S4 answers without findableSso: the result claims nothing either way', async () => {
        installS4Node({ status: 200, body: { generation: 2, enrolledSso: ['facebook'], threshold: 1 } });
        facebookSaysYes();

        const { value } = await connect({ signal: new AbortController().signal });

        expect(value?.error).toBeUndefined();
        expect(value && 'findableSso' in value).toBe(false);
        expect(signInsToRefresh(value)).toEqual([]);
    });
});

describe('components/SsoEnrolSheet.tsx', () => {
    const src = () => fs.readFileSync(path.resolve(__dirname, '../../components/SsoEnrolSheet.tsx'), 'utf-8');

    it('connects with connectAndDeposit, and goes to saving, with the app in front, once the provider is done', () => {
        expect(src()).toMatch(/connectAndDeposit\(\{/);
        expect(src()).toMatch(/onSignedIn: async \(\) => \{\s*setStep\('saving'\);[^}]*await returnToApp\(\);\s*\}/);
    });

    it('reports a connect to the screen only when it worked: an error stays on the sheet, in words (no false success)', () => {
        const s = src();
        const start = s.indexOf('if (result.error) {');
        const end = s.indexOf('} else {', start);
        expect(start).toBeGreaterThan(-1);
        const failed = s.slice(start, end);
        expect(failed).toMatch(/setErrorMessage\(/);
        expect(failed).toMatch(/setStep\('error'\)/);
        expect(failed).not.toMatch(/onEnrolled/);
    });

    it('offers no Cancel while saving', () => {
        const s = src();
        const start = s.indexOf("{step === 'saving' && (");
        const end = s.indexOf("{step === 'success' && (");
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const saving = s.slice(start, end);
        expect(saving).not.toMatch(/Cancel/);
        expect(saving).not.toMatch(/closeAndStop|onClose/);
    });
});
