/**
 * Sign-in recovery at the door, on the join screens (G11-c): the copy goes with the join, a copy that cannot be made
 * or read never keeps anybody out, and the pending join is handled exactly as without it (identity.ts). The seal is
 * core's own, wrapped here only so a test can make it fail or wait. The node is a stubbed fetch; no provider or node
 * is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const seal = vi.hoisted(() => ({
    fail: false,
    calls: 0,
    /** Resolves when the test lets the seal finish; null to finish at once. */
    gate: null as Promise<void> | null,
    /** The pending join as stored at the moment each seal began. */
    pendingAtSeal: [] as unknown[],
    peek: null as null | (() => unknown),
}));

vi.mock('@beanpool/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@beanpool/core')>();
    return {
        ...actual,
        sealSeedToSso: vi.fn(async (...args: Parameters<typeof actual.sealSeedToSso>) => {
            seal.calls++;
            seal.pendingAtSeal.push(seal.peek?.());
            if (seal.gate) await seal.gate;
            if (seal.fail) throw new actual.KeeperCryptoError("The sign-in fragment's key could not be derived: out of memory");
            return actual.sealSeedToSso(...args);
        }),
    };
});

import { WebJoin, type JoinedResult } from './WebJoin';
import {
    generateIdentity,
    loadIdentity,
    loadPendingJoin,
    savePendingJoin,
    PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity,
    type PendingJoin,
} from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';

const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'node-nonce-1';

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

type Handler = (body: any, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(handlers: Record<string, Handler>) {
    const calls: Array<{ path: string; body: any; pendingAtSend: PendingJoin | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, pendingAtSend: peekPending() });
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (!key) return json(404, { error: 'Not Found' });
        return handlers[key](body, init);
    }));
    return { joins: () => calls.filter((c) => c.path === '/api/join') };
}

let identity: BeanPoolIdentity;
let idb: MemoryIndexedDB;
const peekPending = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;

async function seedPending(): Promise<PendingJoin> {
    const now = Date.now();
    const p: PendingJoin = { identity, provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false };
    await savePendingJoin(p);
    return p;
}

function googleReturn() {
    return readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 'g-sub-1', nonce: NONCE })}`);
}

function renderJoin() {
    const onJoined = vi.fn<(r: JoinedResult) => void>();
    render(<WebJoin onJoined={onJoined} onRestore={vi.fn()} navigate={vi.fn()} origin={ORIGIN} authReturn={googleReturn()} />);
    return { onJoined };
}

const ENROLLED = { enrolled: true, generation: 1, provider: 'google', shareCount: 1, threshold: 1, enrolledSso: ['google'] };

beforeEach(async () => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetCapturedAuthReturn();
    identity = await generateIdentity('Alice');
    Object.assign(seal, { fail: false, calls: 0, gate: null, pendingAtSeal: [], peek: peekPending });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('the copy goes with the join', () => {
    it('sealed before anything is written: the pending join is untouched while it is made, and marked sent before the join goes', async () => {
        await seedPending();
        let release!: () => void;
        seal.gate = new Promise((r) => { release = r; });
        const node = stubNode({ '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google', recovery: ENROLLED }) });
        const { onJoined } = renderJoin();

        expect(await screen.findByTestId('join-joining')).toHaveTextContent('Securing your account…');
        expect(node.joins()).toHaveLength(0);
        release();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));

        // While the seal ran, the stored pending join was exactly as the sign-in left it: not marked sent.
        expect(seal.pendingAtSeal).toHaveLength(1);
        expect(seal.pendingAtSeal[0]).toMatchObject({ identity: { publicKey: identity.publicKey }, nonce: NONCE });
        expect(seal.pendingAtSeal[0]).not.toHaveProperty('sentAt');
        // The join went marked sent, with the copy.
        const [sent] = node.joins();
        expect(sent.pendingAtSend).toMatchObject({ identity: { publicKey: identity.publicKey }, nonce: null, sentAt: expect.any(Number) });
        expect(sent.body.recovery.shares).toHaveLength(1);
        expect(onJoined.mock.calls[0][0].recovery).toEqual({ enrolled: true, provider: 'google' });
        expect(await loadPendingJoin()).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
    });

    it('the node let the member in but could not store the copy: in, and not connected', async () => {
        await seedPending();
        stubNode({ '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google', recovery: { enrolled: false, error: 'The recovery keeper could not be stored.' } }) });
        const { onJoined } = renderJoin();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(onJoined.mock.calls[0][0].recovery).toEqual({ enrolled: false, provider: 'google' });
        // Nothing is shown about it; the reason goes to the log.
        expect(screen.queryByTestId('join-notice')).toBeNull();
        expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('The recovery keeper could not be stored.');
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        expect(await loadPendingJoin()).toBeNull();
    });

    it('Try again after a 503 sends the same copy, without sealing again', async () => {
        await seedPending();
        let n = 0;
        const node = stubNode({
            '/api/join': () => (++n === 1 ? json(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now.' }) : json(200, { success: true, member: { callsign: 'Alice' } })),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        const { onJoined } = renderJoin();
        (await screen.findByRole('button', { name: 'Try again' })).click();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(seal.calls).toBe(1);
        const [first, second] = node.joins();
        expect(second.body.recovery).toEqual(first.body.recovery);
    });
});

describe('a copy is never what keeps somebody out', () => {
    it('the seal fails: the join goes without `recovery`, and the pending join goes exactly as it does without one', async () => {
        await seedPending();
        seal.fail = true;
        const node = stubNode({ '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google' }) });
        const { onJoined } = renderJoin();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));

        const [sent] = node.joins();
        expect(sent.body).toEqual({ callsign: 'Alice', provider: 'google', idToken: expect.stringContaining('.'), nonce: NONCE });
        expect(sent.body).not.toHaveProperty('recovery');
        expect(sent.pendingAtSend).toMatchObject({ identity: { publicKey: identity.publicKey }, nonce: null, sentAt: expect.any(Number) });
        expect(sent.pendingAtSend).not.toHaveProperty('earlierSentAt');
        expect(onJoined.mock.calls[0][0]).toMatchObject({ recovery: null, restored: false });
        expect(await loadIdentity()).toMatchObject({ publicKey: identity.publicKey, mnemonic: identity.mnemonic });
        expect(await loadPendingJoin()).toBeNull();
    });

    it('the seal fails and the door refuses (429): the key is kept, marked sent, as without a copy', async () => {
        await seedPending();
        seal.fail = true;
        stubNode({
            '/api/join': () => json(429, { code: 'rate_limited', error: 'Too many new accounts have joined from this network. Please try again later.' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/join/sso-nonce': () => json(200, { nonce: 'n2', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'web-client' } }),
        });
        renderJoin();
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('Too many new accounts');
        // Released through identity.ts's one guarded place (a definite refusal, then "not a member"), kept for an hour.
        await waitFor(async () => expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: identity.publicKey } }));
        expect((await loadPendingJoin())?.expiresAt).toBeGreaterThan(Date.now() + PENDING_JOIN_TTL_MS);
        expect(await loadIdentity()).toBeNull();
    });

    it('the node cannot read the copy (400 recovery_invalid): the same sign-in goes again without it, once, and the member is in', async () => {
        await seedPending();
        let n = 0;
        const node = stubNode({
            '/api/join': (body) => (++n === 1 && body.recovery
                ? json(400, { code: 'recovery_invalid', error: 'The recovery keeper could not be read: Fragment 0 has a non-integer share index.' })
                : json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google' })),
        });
        const { onJoined } = renderJoin();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));

        const [first, second] = node.joins();
        expect(node.joins()).toHaveLength(2);
        expect(first.body.recovery.shares).toHaveLength(1);
        const { recovery: _r, ...firstWithout } = first.body;
        expect(second.body).toEqual(firstWithout);
        // The second went through the same sent mark, with the first remembered as one that went before it.
        expect(second.pendingAtSend).toMatchObject({ sentAt: expect.any(Number), earlierSentAt: first.pendingAtSend!.sentAt });
        expect(onJoined.mock.calls[0][0].recovery).toBeNull();
        expect(screen.queryByTestId('join-notice')).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        expect(await loadPendingJoin()).toBeNull();
    });

    it('recovery_invalid on a join that carried no copy is not retried', async () => {
        await seedPending();
        seal.fail = true;
        const node = stubNode({
            '/api/join': () => json(400, { code: 'recovery_invalid', error: 'x' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/join/sso-nonce': () => json(200, { nonce: 'n2', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'web-client' } }),
        });
        renderJoin();
        await screen.findByTestId('join-notice');
        expect(node.joins()).toHaveLength(1);
    });
});
