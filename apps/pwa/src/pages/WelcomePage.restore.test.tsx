/**
 * WelcomePage and a restore with a sign-in (G11-d): where it starts on the open door, which returning sign-ins are a
 * restore's, and how the account that comes back is saved (the way a 12-words restore is: the node asked first, a join
 * this browser sent settled first, and the guarded write that never replaces another account). The node is a stubbed
 * fetch; the restore screens themselves are covered in components/WebRestore.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sealSeedToSso, toEd25519Seed } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import {
    generateIdentity, importIdentity, loadIdentity, loadPendingJoin, loadPendingRestore, markPendingJoinSent, savePendingJoin,
    savePendingRestore, PENDING_JOIN_TTL_MS, PENDING_RESTORE_TTL_MS, type BeanPoolIdentity,
} from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { makeEphemeralKey, type EphemeralKey } from '../lib/web-restore';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Handler = (body: any, path: string) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };

function stubNode(handlers: Record<string, Handler> = {}) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        if (path === '/api/community/info') return json(200, GLOBAL_OPEN);
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (key) return handlers[key](body, path);
        return json(200, {});
    }));
    return calls;
}

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let account: BeanPoolIdentity;
let other: BeanPoolIdentity;
let eph: EphemeralKey;

/** Alice's restore left for Google with nonce `rn-1`, and Google sent the browser back to the return page. */
async function backFromGoogle(nonce = 'rn-1') {
    const now = Date.now();
    await savePendingRestore({
        kind: 'restore', ephemeral: eph, account: { publicKey: account.publicKey, callsign: 'Alice' }, collectionId: 'col-1',
        provider: 'google', nonce: 'rn-1', startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS,
    });
    const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g-sub-1', nonce }))}.c2ln`;
    window.history.replaceState(null, '', `/app/auth/google#state=${nonce}&id_token=${token}`);
}

/** The node's recovery routes and its membership probe: Alice is a member, and her Google copy is released. */
function restoreNode(extra: Record<string, Handler> = {}) {
    return stubNode({
        '/api/recovery/collect/sso': () => json(200, { collected: 1 }),
        '/api/recovery/collect/fragments': async () => {
            const c = await sealSeedToSso(toEd25519Seed(hexToBytes(account.privateKey)), 'google', 'g-sub-1', { words: account.mnemonic ?? null });
            return json(200, { fragments: [{ holderType: 'sso', shareIndex: 1, payload: c.encryptedShare, payloadIv: c.shareIv, payloadTag: c.shareTag, kdfParams: c.kdfParams }] });
        },
        '/api/community/membership/': (_b, path) => json(200, path.endsWith(account.publicKey)
            ? { isMember: true, callsign: 'Alice' }
            : { isMember: false, callsign: null }),
        ...extra,
    });
}

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    account = await generateIdentity('Alice');
    other = await generateIdentity('Mallory');
    eph = makeEphemeralKey();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCapturedAuthReturn();
});

describe('a sign-in coming back for a restore', () => {
    it('cleared browser → back from Google → the same key as the join made, saved, and in; nothing joined', async () => {
        await backFromGoogle();
        const calls = restoreNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        // The token left the address bar before anything else ran.
        expect(window.location.pathname).toBe('/app');
        expect(window.location.hash).toBe('');

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: account.publicKey, callsign: 'Alice' });
        const saved = (await loadIdentity())!;
        expect(saved.publicKey).toBe(account.publicKey);
        expect(saved.privateKey).toBe(account.privateKey);
        expect(saved.mnemonic).toEqual(account.mnemonic);
        expect(await loadPendingRestore()).toBeNull();
        // The collect calls were the throwaway key's; the membership question was the restored key's own.
        for (const c of calls.filter((x) => x.path.startsWith('/api/recovery/collect'))) expect(c.headers['X-Public-Key']).toBe(eph.publicKey);
        expect(calls.find((c) => c.path.startsWith('/api/community/membership/'))?.headers['X-Public-Key']).toBe(account.publicKey);
        expect(calls.some((c) => c.path.startsWith('/api/join'))).toBe(false);
    });

    it('a browser holding another account: "this browser already has an account", that account kept', async () => {
        await backFromGoogle();
        restoreNode();
        // Saved from another tab while this one was at Google.
        await importIdentity(other);
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Mallory was saved in this browser');
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
        expect(onComplete).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Open Mallory' }));
        expect(onComplete.mock.calls[0][0].publicKey).toBe(other.publicKey);
    });

    it('another tab saves another account between the check and the save: the guarded write refuses, and says so', async () => {
        await backFromGoogle();
        restoreNode({
            // The node answers the membership question just as another tab saves Mallory here.
            '/api/community/membership/': async () => {
                await importIdentity(other);
                return json(200, { isMember: true, callsign: 'Alice' });
            },
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Mallory');
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('a join this browser sent is settled first: nothing is saved while it may still land', async () => {
        const joiner = await generateIdentity('Bea');
        await markPendingJoinSent({ identity: joiner, provider: 'google', nonce: null, startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        await backFromGoogle();
        restoreNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        expect(await screen.findByTestId('join-held')).toHaveTextContent('may still go through');
        expect(await loadIdentity()).toBeNull();
        expect((await loadPendingJoin())?.identity.publicKey).toBe(joiner.publicKey);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it("a join's own return, with a restore waiting for another nonce, is still the join's", async () => {
        const joiner = await generateIdentity('Bea');
        await savePendingJoin({ identity: joiner, provider: 'google', nonce: 'jn-1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        await backFromGoogle('jn-1');
        const calls = restoreNode({ '/api/join': () => json(200, { success: true, member: { callsign: 'Bea' } }) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('onboarding-stepper');
        expect(calls.filter((c) => c.path === '/api/join')).toHaveLength(1);
        expect(calls.some((c) => c.path.startsWith('/api/recovery/collect'))).toBe(false);
        expect((await loadPendingRestore())?.nonce).toBe('rn-1');
    });
});

describe('where it starts on the open door', () => {
    it('"Already have BeanPool?" → "Use my sign-in": your name here', async () => {
        stubNode({ '/api/recovery/lookup/': () => json(200, []) });
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Already have BeanPool?' }));
        fireEvent.click(await screen.findByTestId('join-restore-signin'));
        await screen.findByTestId('restore-screen-name');
        // And back: the lobby again.
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        await screen.findByTestId('join-screen-lobby');
    });

    it('"Have you used BeanPool before?" offers it too, so nobody makes a second account', async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        const join = await screen.findByTestId('join-start');
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        fireEvent.click(await screen.findByTestId('join-guard-signin'));
        await screen.findByTestId('restore-screen-name');
    });

    it("a sign-in that already has an account here: \"Restore with Google\", and Google is offered first", async () => {
        const joiner = await generateIdentity('Bea');
        await savePendingJoin({ identity: joiner, provider: 'google', nonce: 'jn-1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g-sub-1', nonce: 'jn-1' }))}.c2ln`;
        window.history.replaceState(null, '', `/app/auth/google#state=jn-1&id_token=${token}`);
        stubNode({
            '/api/join': () => json(409, { code: 'already_joined', error: 'This Google account already has a BeanPool identity here.' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/recovery/lookup/': () => json(200, [{ publicKey: account.publicKey, callsign: 'Alice', canRecoverBySso: true }]),
            '/api/recovery/collect/sso-nonce': () => json(200, { nonce: 'rn-1', githubFlow: 'node', clientIds: { google: 'web', apple: 'org.beanpool.web' } }),
            '/api/recovery/collect': () => json(200, { collectionId: 'col-1' }),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Restore with Google' }));
        fireEvent.change(await screen.findByTestId('restore-callsign'), { target: { value: 'Alice' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
        await screen.findByTestId('restore-provider-apple');
        const order = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid')).filter((t) => t?.startsWith('restore-provider-'));
        expect(order[0]).toBe('restore-provider-google');
    });
});
