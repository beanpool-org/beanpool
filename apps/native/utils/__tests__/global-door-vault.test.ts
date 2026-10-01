/**
 * A vault build at the global community's door (utils/global-join.ts; V5 design §3 and §6 "Phone",
 * scratch/global-node/DESIGN-v5-global-door-vault-fable.md). Two things the phone does, so no order of rollout blocks a
 * join:
 *
 * - Ask first. The door's nonce answer says which vault ticket keys it takes (`vault`). Only when it names a key this
 *   build pins does the phone ask the vault for a ticket, and it uses the ticket only if the door takes the key that
 *   signed it. Otherwise (a door from before V5, a door with no keys set, a stranger's door, another vault's keys) the
 *   door's own nonce, nothing asked of the vault, and the member joins without a copy: Safety Backup offers Connect.
 * - The backstop. A 401 to a join that carried a ticket, whatever its code, opens the provider's sheet once more, by
 *   itself, with the door's own nonce and a one-line notice (Marty's answer 6), and the join goes again without the
 *   ticket. A second 401 is "sign in again", as before: two sheets at most, never three.
 *
 * Nothing is contacted: fake-vault.ts plays the vault and the door (with V5's check), and refuses any other address.
 * The providers' sheets are stubbed and counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>(), order: [] as string[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

// Each provider's sheet, counted, and noted in `mem.order` beside the requests, so a test can see what came first.
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const subs = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
    // A build without a vault reaches each provider's sheet directly at the door, as before the vault.
    const sheet = (provider: 'google' | 'apple' | 'facebook') => vi.fn(async (nonce: string) => ({
        idToken: fakeJwt({ sub: subs[provider], nonce }), nonce,
    }));
    return {
        ...real,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => {
            mem.order.push(`sheet ${nonce}`);
            return { provider, idToken: fakeJwt({ sub: subs[provider], nonce }), nonce };
        }),
        signInWithGoogle: sheet('google'),
        signInWithApple: sheet('apple'),
        signInWithFacebook: sheet('facebook'),
    };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { vaultTicketNonce } from '@beanpool/core';
import { signInWithProvider, SsoSignInError } from '../sso-signin';
import { draftIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { getPendingOnboarding } from '../onboarding-state';
import { protectionFrom } from '../protection-state';
import {
    commitJoinKey, joinKeyForThisPhone, nextStepFor, releaseJoinKey, signInAtDoor, submitJoin, DOOR_MESSAGES,
    type DoorSignIn,
} from '../global-join';
import {
    FORGED_SEED, GLOBAL, OTHER_KEY, TICKET_KEY, VAULT,
    installNetwork, noVault, useVault, type Network, type SentRequest,
} from './fake-vault';

/** The notice under the joining spinner while the sheet opens once more (Marty's answer 6). */
const NOTICE = 'Checking your sign-in another way…';
/** A second vault key this build may pin during a rotation (design §1.1): the vault signs with it once it is the signer. */
const NEW_KEY = bytesToHex(ed25519.getPublicKey(FORGED_SEED));
/** The 401 codes the door gives a ticket it won't take (design §1.2). */
const TICKET_CODES = [
    'ticket_malformed', 'ticket_signature', 'ticket_expired', 'ticket_key', 'ticket_purpose', 'ticket_unsupported', 'ticket_used',
];

let net: Network;
let member: BeanPoolIdentity;
const originalFetch = globalThis.fetch;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    mem.order.length = 0;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    useVault();
    net = installNetwork();
    const network = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const u = new URL(String(input));
        mem.order.push(`${u.origin} ${u.pathname}`);
        return network(input, init);
    }) as typeof fetch;
    member = await draftIdentity('Sam');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
    vi.restoreAllMocks();
});

const to = (origin: string) => net.sent.filter(s => s.origin === origin);
const joins = () => to(GLOBAL).filter(s => s.path === '/api/join');
const sheets = () => vi.mocked(signInWithProvider).mock.calls.length;

async function signIn(identity: BeanPoolIdentity = member): Promise<DoorSignIn> {
    const result = await signInAtDoor('google', GLOBAL, identity);
    if (result.kind !== 'signed_in') throw new Error(`expected a sign-in, got ${JSON.stringify(result)}`);
    return result.signin;
}

/** Signed in and joined, as welcome.tsx runs the door, with the notices the screen was given. */
async function join(identity: BeanPoolIdentity = member) {
    const signin = await signIn(identity);
    const notices: string[] = [];
    const answer = await submitJoin(GLOBAL, { ...identity, callsign: 'Sam' }, 'Sam', signin, { onSignInAgain: (n: string) => notices.push(n) });
    return { signin, answer, notices };
}

/** The member joined with the door's own nonce: one sheet, no ticket, no copy in the join, and nothing at the vault. */
function joinedWithTheDoorsNonce(answer: unknown) {
    expect(answer).toMatchObject({ kind: 'joined', enrolment: null });
    expect(protectionFrom(null).state).toBe('words-only');
    expect(signInWithProvider).toHaveBeenCalledTimes(1);
    expect(signInWithProvider).toHaveBeenCalledWith('google', net.global.nonce);
    const [only] = joins();
    expect(joins()).toHaveLength(1);
    expect(Object.keys(only.body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider']);
    expect(only.body.nonce).toBe(net.global.nonce);
    expect(to(VAULT).filter(s => s.path === '/v1/copies')).toEqual([]);
}

describe('P1: the door says it takes a key this build pins: the ticket, then the sheet, then the join, then the copy', () => {
    it('no sheet before the ticket; the sheet gets the ticket\'s nonce; the join carries the ticket; the deposit goes to the vault', async () => {
        const { signin, answer, notices } = await join();
        const ticket = signin.vaultTicket!;
        expect(ticket).toEqual(expect.any(String));
        expect(mem.order).toEqual([
            `${GLOBAL} /api/join/sso-nonce`, `${VAULT} /v1/ticket`, `sheet ${vaultTicketNonce(ticket)}`, `${GLOBAL} /api/join`, `${VAULT} /v1/copies`,
        ]);
        const [only] = joins();
        expect(only.body).toMatchObject({ vaultTicket: ticket, nonce: vaultTicketNonce(ticket) });
        expect(answer).toMatchObject({ kind: 'joined', enrolment: { enrolledSso: ['google'], wordsSealed: true } });
        expect(notices).toEqual([]);
        expect(sheets()).toBe(1);
    });

    it('a door that lists two keys, one of them this build\'s, takes the ticket', async () => {
        net.global.ticketKeys = [NEW_KEY, TICKET_KEY];
        const { signin, answer } = await join();
        expect(signin.vaultTicket).toEqual(expect.any(String));
        expect(answer).toMatchObject({ kind: 'joined', enrolment: { enrolledSso: ['google'] } });
        expect(sheets()).toBe(1);
    });

    it('a ticket signed by a pinned key the door does not list (the door\'s list not yet rotated): the door\'s own nonce, no wasted sheet', async () => {
        // The build pins the new key and the old; the vault signs with the new one; the door lists only the old.
        process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS = `${NEW_KEY},${TICKET_KEY}`;
        net.vault.tickets = 'forged';
        net.global.ticketKeys = [TICKET_KEY];
        const { signin, answer, notices } = await join();
        expect(to(VAULT).map(s => s.path)).toEqual(['/v1/ticket']);
        expect(signin.vaultTicket).toBeUndefined();
        joinedWithTheDoorsNonce(answer);
        expect(notices).toEqual([]);
    });
});

describe('P2: the door says `vault: null`: the vault is never asked', () => {
    it('no /v1/ticket; the sheet gets the door\'s nonce; the join has no ticket and no copy; joined with nothing at the vault', async () => {
        net.global.ticketKeys = null;
        const { signin, answer } = await join();
        expect(to(VAULT)).toEqual([]);
        expect(signin.vaultTicket).toBeUndefined();
        joinedWithTheDoorsNonce(answer);
        expect(mem.order).toEqual([`${GLOBAL} /api/join/sso-nonce`, `sheet ${net.global.nonce}`, `${GLOBAL} /api/join`]);
    });
});

describe('P3: the door lists only keys this build does not pin (another vault\'s): as P2', () => {
    it('no /v1/ticket, the door\'s nonce, joined without a copy', async () => {
        net.global.ticketKeys = [OTHER_KEY];
        const { answer } = await join();
        expect(to(VAULT)).toEqual([]);
        joinedWithTheDoorsNonce(answer);
    });

    it('nor a list that holds no key at all', async () => {
        for (const vault of [{ ticketKeys: [] }, { ticketKeys: [TICKET_KEY.toUpperCase(), 'nope', 7] }, { ticketKeys: TICKET_KEY }, 'yes', true]) {
            net.sent.length = 0;
            vi.mocked(signInWithProvider).mockClear();
            const real = net.global.handle.bind(net.global);
            net.global.handle = (req: SentRequest) => {
                const r = real(req);
                return req.path === '/api/join/sso-nonce' ? { ...r, body: { ...(r.body as object), vault } } : r;
            };
            const signin = await signIn();
            expect(signin.vaultTicket, JSON.stringify(vault)).toBeUndefined();
            expect(signInWithProvider).toHaveBeenCalledWith('google', net.global.nonce);
            expect(to(VAULT), JSON.stringify(vault)).toEqual([]);
            net.global.handle = real;
        }
    });
});

describe('P4: the door refuses the ticket: one more sheet, by itself, with the door\'s nonce and a notice', () => {
    it('401 ticket_expired: exactly one more sheet, with the door\'s nonce, and a join without a ticket: joined', async () => {
        net.global.refuseTickets = 'ticket_expired';
        const { signin, answer, notices } = await join();
        expect(answer).toMatchObject({ kind: 'joined', enrolment: null });
        expect(notices).toEqual([NOTICE]);
        expect(DOOR_MESSAGES.signInAnotherWay).toBe(NOTICE);
        expect(sheets()).toBe(2);
        expect(vi.mocked(signInWithProvider).mock.calls).toEqual([
            ['google', vaultTicketNonce(signin.vaultTicket!)], ['google', net.global.nonce],
        ]);
        const [first, second] = joins();
        expect(joins()).toHaveLength(2);
        expect(first.body.vaultTicket).toBe(signin.vaultTicket);
        expect(Object.keys(second.body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider']);
        expect(second.body.nonce).toBe(net.global.nonce);
        // The door's nonce is asked for again before the second sheet, and nothing more of the vault: no copy, no deposit.
        expect(mem.order.slice(mem.order.indexOf(`${GLOBAL} /api/join`))).toEqual([
            `${GLOBAL} /api/join`, `${GLOBAL} /api/join/sso-nonce`, `sheet ${net.global.nonce}`, `${GLOBAL} /api/join`,
        ]);
        expect(to(VAULT).map(s => s.path)).toEqual(['/v1/ticket']);
    });

    for (const code of TICKET_CODES) {
        it(`401 ${code}: the same one more sheet, and joined`, async () => {
            net.global.refuseTickets = code;
            const { answer, notices } = await join();
            expect(answer).toMatchObject({ kind: 'joined' });
            expect(notices).toEqual([NOTICE]);
            expect(sheets()).toBe(2);
        });
    }

    it('a ticket the door\'s own check refuses (signed by a key it no longer lists): the backstop, joined', async () => {
        const signin = await signIn();
        net.global.ticketKeys = [NEW_KEY];
        const notices: string[] = [];
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', signin, { onSignInAgain: (n: string) => notices.push(n) });
        expect(answer).toMatchObject({ kind: 'joined' });
        expect(notices).toEqual([NOTICE]);
        expect(sheets()).toBe(2);
    });

    it('the second 401 is "sign in again", as before: two sheets, never three, and two joins', async () => {
        net.global.refuseTickets = 'ticket_expired';
        const real = net.global.handle.bind(net.global);
        net.global.handle = (req: SentRequest) => (req.path === '/api/join'
            ? { status: 401, body: { error: 'jwt expired', code: 'sign_in' } }
            : real(req));
        const { answer, notices } = await join();
        expect(answer).toMatchObject({ kind: 'sign_in_again', message: DOOR_MESSAGES.signInAgain });
        expect(nextStepFor(answer)).toBe('retry');
        expect(notices).toEqual([NOTICE]);
        expect(sheets()).toBe(2);
        expect(joins()).toHaveLength(2);
    });

    it('both refused joins stop counting, so a key the door made comes off the phone as before', async () => {
        net.global.refuseTickets = 'ticket_expired';
        const real = net.global.handle.bind(net.global);
        net.global.handle = (req: SentRequest) => (req.path === '/api/join' ? { status: 401, body: { code: 'sign_in' } } : real(req));
        const key = await joinKeyForThisPhone();
        const signin = await signIn(key.identity);
        const identity = await commitJoinKey(key, 'Sam');
        const answer = await submitJoin(GLOBAL, identity, 'Sam', signin, { onSignInAgain: () => {} });
        expect(answer.kind).toBe('sign_in_again');
        expect(joins()).toHaveLength(2);
        expect((await getPendingOnboarding())?.joinsOut).toBe(0);
        expect(await releaseJoinKey(key)).toBe(true);
        expect(await loadIdentity()).toBeNull();
    });

    it('the second sheet cancelled: no second join, and "sign in again"', async () => {
        net.global.refuseTickets = 'ticket_expired';
        const signin = await signIn();
        vi.mocked(signInWithProvider).mockRejectedValueOnce(new SsoSignInError('cancelled', 'Sign-in was cancelled.'));
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', signin, { onSignInAgain: () => {} });
        expect(answer).toMatchObject({ kind: 'sign_in_again' });
        expect(sheets()).toBe(2);
        expect(joins()).toHaveLength(1);
    });

    it('the door shut by the time of the second sign-in: "sign in again", never a refusal that takes the key off', async () => {
        net.global.refuseTickets = 'ticket_expired';
        const signin = await signIn();
        const real = net.global.handle.bind(net.global);
        net.global.handle = (req: SentRequest) => (req.path === '/api/join/sso-nonce'
            ? { status: 404, body: { code: 'invite_only', error: 'This community is invite-only.' } }
            : real(req));
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', signin, { onSignInAgain: () => {} });
        expect(answer).toMatchObject({ kind: 'sign_in_again' });
        expect(sheets()).toBe(1);
        expect(joins()).toHaveLength(1);
    });

    it('a 401 to a join with the door\'s own nonce is "sign in again" at once: no second sheet, no notice', async () => {
        net.global.ticketKeys = null;
        const real = net.global.handle.bind(net.global);
        net.global.handle = (req: SentRequest) => (req.path === '/api/join' ? { status: 401, body: { code: 'sign_in' } } : real(req));
        const { answer, notices } = await join();
        expect(answer).toMatchObject({ kind: 'sign_in_again' });
        expect(notices).toEqual([]);
        expect(sheets()).toBe(1);
    });

    it('a refusal of a ticket join that is not a 401 is the door\'s answer, with no second sheet', async () => {
        const real = net.global.handle.bind(net.global);
        net.global.handle = (req: SentRequest) => (req.path === '/api/join'
            ? { status: 409, body: { code: 'already_joined', error: 'This Google account already has a BeanPool identity here.' } }
            : real(req));
        const { answer, notices } = await join();
        expect(answer).toMatchObject({ kind: 'already_joined' });
        expect(notices).toEqual([]);
        expect(sheets()).toBe(1);
    });

    it('the screen shows the notice under the joining spinner, and passes it to the join', () => {
        const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        expect(welcome).toMatch(/submitJoin\(GLOBAL_NODE_URL, identity, name, signin, \{ onSignInAgain: setDoorNotice \}\)/);
        const joining = welcome.slice(welcome.indexOf("{globalPhase === 'joining' && ("));
        expect(joining.slice(0, 600)).toMatch(/\{doorNotice \?\? 'Joining the global community…'\}/);
    });
});

describe('P5: a door from before V5 (no `vault` in its nonce answer; 401 `sign_in` to a ticket)', () => {
    it('P2\'s path: the phone never sends it a ticket', async () => {
        net.global.beforeV5 = true;
        const { signin, answer, notices } = await join();
        expect(to(VAULT)).toEqual([]);
        expect(signin.vaultTicket).toBeUndefined();
        joinedWithTheDoorsNonce(answer);
        expect(notices).toEqual([]);
        for (const s of to(GLOBAL)) expect(Object.keys(s.body ?? {})).not.toContain('vaultTicket');
    });

    it('a ticket join that meets one anyway (a take-over between the sheet and the join): its 401 `sign_in` gets the backstop, joined', async () => {
        const signin = await signIn();
        expect(signin.vaultTicket).toEqual(expect.any(String));
        net.global.beforeV5 = true;
        const notices: string[] = [];
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', signin, { onSignInAgain: (n: string) => notices.push(n) });
        expect(answer).toMatchObject({ kind: 'joined', enrolment: null });
        expect(notices).toEqual([NOTICE]);
        expect(sheets()).toBe(2);
        expect(joins().map(s => 'vaultTicket' in s.body)).toEqual([true, false]);
    });
});

describe('P6, unchanged: the vault unreachable, locked or not there at its address: joined without a copy', () => {
    for (const down of ['unreachable', 'locked', 'absent'] as const) {
        it(`the vault ${down}: the door's nonce, one sheet, joined, no copy anywhere`, async () => {
            if (down === 'absent') net.vault.handle = () => ({ status: 404, body: { error: 'Not Found' } });
            else net.vault[down] = true;
            const { signin, answer, notices } = await join();
            expect(signin.vaultTicket).toBeUndefined();
            joinedWithTheDoorsNonce(answer);
            expect(notices).toEqual([]);
        });
    }
});

describe('a build with no vault meets any door as before the vault', () => {
    it('the door\'s nonce and the copy in the join, whatever keys the door lists; no vault asked', async () => {
        noVault();
        const result = await signInAtDoor('google', GLOBAL, member);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        expect(result.signin).toMatchObject({ nonce: net.global.nonce });
        expect(result.signin.vaultTicket).toBeUndefined();
        expect(await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin)).toMatchObject({ kind: 'joined' });
        expect(Object.keys(joins()[0].body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider', 'recovery']);
        expect(to(VAULT)).toEqual([]);
    });
});
