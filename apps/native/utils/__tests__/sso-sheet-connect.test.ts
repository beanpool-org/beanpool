/**
 * The account-protection sheet's connect (components/SsoEnrolSheet.tsx): sign in, then deposit.
 *
 * Its Cancel is honest only if it is offered while a cancel is still honoured. With GitHub it used to stay
 * on screen, under the code, after GitHub had said yes and through the deposit. A tap closed the sheet, the
 * deposit went ahead, and a second later the sheet reported the account covered.
 *
 * Nothing here contacts a node or GitHub: the `fetch` stub below plays the node and refuses anything
 * addressed elsewhere. The screen cannot be rendered here (see vitest.config.ts), so the last tests check
 * that the sheet calls `connectAndDeposit` and offers no Cancel once it is saving.
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
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

import { SsoSignInError } from '../sso-signin';
import { connectAndDeposit } from '../sso-sheet-connect';

const NODE = 'https://test.example';
const NONCE = '/api/recovery/sso-nonce';
const START = '/api/recovery/sso/github/start';
const POLL = '/api/recovery/sso/github/poll';
const DEPOSIT = '/api/recovery/shares/sso';

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

/**
 * Play the member's node through a GitHub sign-in and a deposit. The poll answers pending, then ok.
 * `onDeposit` runs as the node receives the deposit.
 */
function installNode(onDeposit: () => void = () => {}): Seen[] {
    const seen: Seen[] = [];
    const polls: Answer[] = [
        { status: 200, body: { status: 'pending', intervalSeconds: 5 } },
        { status: 200, body: { status: 'ok', sub: '987654' } },
    ];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const p = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path: p, body });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        if (p === NONCE) {
            return answer({ status: 200, body: { nonce: 'n-1', expiresInSeconds: 600, providers: ['github'], githubFlow: 'node' } });
        }
        if (p === START) {
            return answer({
                status: 200,
                body: {
                    sessionId: 'node-session-1', userCode: 'WXYZ-9876',
                    verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 5,
                },
            });
        }
        if (p === POLL) return answer(polls.length > 1 ? polls.shift()! : polls[0]);
        if (p === DEPOSIT) {
            onDeposit();
            return answer({ status: 200, body: { generation: 1, enrolledSso: ['github'], threshold: 1 } });
        }
        return answer({ status: 404, body: { error: 'Not Found' } });
    }) as any;
    return seen;
}

/** As `cancelOnOk` in sso-github-node.test.ts: the tap lands as the node's `ok` arrives. */
function cancelOnOk(abort: AbortController): void {
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const res = await nodeFetch(input, init);
        if (!String(input).endsWith(POLL)) return res;
        const body = await res.json();
        return {
            ...res,
            json: async () => {
                if (body?.status === 'ok') abort.abort();
                return body;
            },
        };
    }) as any;
}

function paths(seen: Seen[]): string[] {
    return seen.map((s) => s.path);
}

let originalFetch: typeof fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

/** Run the sheet's connect as the sheet does, and let `ms` of waiting pass. */
async function connect(opts: { signal: AbortSignal; onSignedIn?: () => void | Promise<void> }) {
    const prompts: unknown[] = [];
    const outcome = connectAndDeposit({
        provider: 'github',
        url: NODE,
        identity: MEMBER,
        onGithubPrompt: (p) => prompts.push(p),
        onSignedIn: opts.onSignedIn ?? (() => {}),
        signal: opts.signal,
    }).then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(20_000);
    return { prompts, ...await outcome };
}

describe("the protection sheet's GitHub connect", () => {
    it("tells the sheet GitHub is done before anything is deposited, then deposits with the node's session", async () => {
        const seen = installNode();
        let depositedWhenSignedIn: boolean | undefined;

        const { prompts, value, error } = await connect({
            signal: new AbortController().signal,
            onSignedIn: () => { depositedWhenSignedIn = paths(seen).includes(DEPOSIT); },
        });

        expect(error).toBeUndefined();
        expect(prompts).toEqual([{ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device' }]);
        expect(depositedWhenSignedIn).toBe(false);
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['github']);
        const deposit = seen.find((s) => s.path === DEPOSIT)?.body;
        expect(deposit?.proof).toEqual({ sessionId: 'node-session-1' });
        expect(deposit).not.toHaveProperty('idToken');
        expect(seen.filter((s) => !s.url.startsWith(`${NODE}/`))).toEqual([]);
    });

    it("honours a cancel that lands after GitHub's yes but before the deposit: nothing deposited, and it reads as a cancel", async () => {
        const seen = installNode();
        const abort = new AbortController();
        cancelOnOk(abort);

        const { error } = await connect({ signal: abort.signal });

        expect(abort.signal.aborted).toBe(true);
        expect(paths(seen).filter((p) => p === POLL)).toHaveLength(2);
        expect(error).toBeInstanceOf(SsoSignInError);
        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(paths(seen)).not.toContain(DEPOSIT);
    });

    it('honours a cancel that lands while the sheet is taking the code down and coming back from GitHub', async () => {
        const seen = installNode();
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

        const { value, error } = await connect({ signal: abort.signal });

        expect(paths(seen)).toContain(DEPOSIT);
        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['github']);
    });
});

describe('components/SsoEnrolSheet.tsx', () => {
    const src = () => fs.readFileSync(path.resolve(__dirname, '../../components/SsoEnrolSheet.tsx'), 'utf-8');

    it('connects with connectAndDeposit, and takes the code down to save once the provider is done', () => {
        expect(src()).toMatch(/connectAndDeposit\(\{/);
        expect(src()).toMatch(/onSignedIn: async \(\) => \{\s*setDevicePrompt\(null\);\s*setStep\('saving'\);/);
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
