/**
 * The restore screens (G11-d), with nothing typed (recovery S1): an account back in a browser with the sign-in it joined
 * with. This page's community, the sign-in, the community's find (a pick when one sign-in protects several), the collect
 * by the find's hold, and the account handed on only if it opens to the key the find named. The node is a stubbed fetch,
 * every provider is a URL the page is asked to go to, and the copies are sealed here with core's own seal, as a join
 * seals them. Nothing leaves the test.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { KEEPER_ALG_RELEASE, sealReleaseToDevice, sealSeedToSso, toEd25519Seed } from '@beanpool/core';
import { WebRestore } from './WebRestore';
import {
    generateIdentity,
    importIdentity,
    loadIdentity,
    loadPendingRestore,
    savePendingRestore,
    PENDING_RESTORE_TTL_MS,
    type BeanPoolIdentity,
    type JoinProvider,
    type PendingRestore,
} from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn, type AuthReturn } from '../lib/web-join';
import { makeEphemeralKey, type EphemeralKey } from '../lib/web-restore';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';

const ORIGIN = 'https://global.beanpool.org';
const COMMUNITY = 'Mullumbimby';

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}
function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (body: any) => Response | Promise<Response>;
interface Call { path: string; body: any; headers: Record<string, string> }

/** The node, as a fetch stub. More specific paths first: a key matches its own path and any path under it. */
function stubNode(handlers: Record<string, Handler>) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (!key) return json(404, { error: 'Not Found' });
        return handlers[key](body);
    }));
    return { calls, recovery: () => calls.filter((c) => c.path.startsWith('/api/recovery/')) };
}

let account: BeanPoolIdentity;
let other: BeanPoolIdentity;
let idb: MemoryIndexedDB;

async function copyOf(id: BeanPoolIdentity, provider: string, sub: string) {
    const c = await sealSeedToSso(toEd25519Seed(hexToBytes(id.privateKey)), provider, sub, { words: id.mnemonic ?? null });
    return { holderType: 'sso', shareIndex: 1, payload: c.encryptedShare, payloadIv: c.shareIv, payloadTag: c.shareTag, kdfParams: c.kdfParams };
}

/**
 * The node's find and recovery routes: the find names Alice (unless a test says whom), the collect opens col-1 by the
 * hold, and the copy is Alice's own unless a test says otherwise. find-nonce before find, fragments before collect.
 */
function recoveryNode(copy: () => Promise<unknown>, overrides: Record<string, Handler> = {}) {
    let nonces = 0;
    return stubNode({
        '/api/recovery/find-nonce': () => json(200, {
            nonce: `rn-${++nonces}`, expiresInSeconds: 600,
            clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
        }),
        '/api/recovery/find': () => json(200, { accounts: [{ publicKey: account.publicKey, callsign: 'Alice' }] }),
        '/api/recovery/collect/fragments': async () => json(200, { collected: 1, threshold: 1, enough: true, fragments: [await copy()] }),
        '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1, progress: { collected: 1, enough: true } }),
        ...overrides,
    });
}

function renderRestore(props: Partial<React.ComponentProps<typeof WebRestore>> = {}) {
    const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>(async () => true);
    const onHeld = vi.fn();
    const onExisting = vi.fn();
    const navigate = vi.fn();
    render(<WebRestore onRestored={onRestored} onHeld={onHeld} onExisting={onExisting} onBack={vi.fn()} onOtherWay={vi.fn()}
        community={COMMUNITY} navigate={navigate} origin={ORIGIN} authReturn={null} {...props} />);
    return { onRestored, onHeld, onExisting, navigate };
}

/** A restore that left the page for `provider` with nonce `nonce`, as the screens store it: no account is known yet. */
async function leftFor(provider: JoinProvider, eph: EphemeralKey, nonce = 'rn-9'): Promise<PendingRestore> {
    const now = Date.now();
    const r: PendingRestore = { kind: 'restore', ephemeral: eph, provider, nonce, startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS };
    await savePendingRestore(r);
    return r;
}

function returnFrom(provider: 'google' | 'apple' | 'facebook', nonce: string, sub: string, claimNonce = nonce): AuthReturn {
    return readAuthReturn(`/app/auth/${provider}`, `#state=${nonce}&id_token=${fakeJwt({ sub, nonce: claimNonce })}`)!;
}

beforeEach(async () => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetCapturedAuthReturn();
    account = await generateIdentity('Alice');
    other = await generateIdentity('Mallory');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('from this community to the provider, with nothing typed', () => {
    it('this community and its sign-ins first; the find nonce asked by a throwaway key; Google left for with state === nonce; nothing saved', async () => {
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { navigate } = renderRestore();
        await screen.findByTestId('restore-screen-providers');
        for (const p of ['google', 'apple', 'facebook']) await screen.findByTestId(`restore-provider-${p}`);
        expect(screen.getByText('Choose your community, then sign in with the account you linked. It finds your account, so there is nothing else to type.')).toBeTruthy();
        expect(screen.getByTestId('restore-community')).toHaveTextContent(COMMUNITY);
        // No name to type, anywhere: no field, no "Your name here".
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByText('Your name here', { exact: false })).toBeNull();

        const [nonce] = node.recovery();
        expect(nonce).toMatchObject({ path: '/api/recovery/find-nonce', body: {} });
        const eph = nonce.headers['X-Public-Key'];
        expect(eph).toMatch(/^[0-9a-f]{64}$/);
        expect(eph).not.toBe(account.publicKey);

        fireEvent.click(screen.getByTestId('restore-provider-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('state')).toBe('rn-1');
        expect(url.searchParams.get('nonce')).toBe('rn-1');
        expect(url.searchParams.get('client_id')).toBe('web-client');
        expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/app/auth/google`);

        const waiting = (await loadPendingRestore())!;
        expect(waiting).toMatchObject({ kind: 'restore', provider: 'google', nonce: 'rn-1' });
        expect(waiting.ephemeral.publicKey).toBe(eph);
        expect('account' in waiting || 'collectionId' in waiting).toBe(false);
        // Nothing but the nonce was asked before the sign-in: no account is named, no session opened.
        expect(node.recovery().map((c) => c.path)).toEqual(['/api/recovery/find-nonce']);
        expect(await loadIdentity()).toBeNull();
    });

    it('the sign-in just tried at the door is offered first', async () => {
        recoveryNode(() => copyOf(account, 'apple', 'a-sub'));
        renderRestore({ provider: 'apple' });
        await screen.findByTestId('restore-provider-apple');
        const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid')).filter((t) => t?.startsWith('restore-provider-'));
        expect(buttons[0]).toBe('restore-provider-apple');
    });

    it("a community whose server is older than the find: said, with the other ways, and no sign-in is offered", async () => {
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), { '/api/recovery/find-nonce': () => json(404, { error: 'Not Found' }) });
        renderRestore();
        expect(await screen.findByTestId('restore-too-old-server')).toHaveTextContent(
            "Mullumbimby's server is older than this app and can't find your account from a sign-in yet. Ask its admin to update, or use your 12 words.");
        screen.getByRole('button', { name: 'Use my 12 words' });
        screen.getByRole('button', { name: 'Link with my phone' });
        expect(screen.queryByTestId('restore-provider-google')).toBeNull();
    });

    it("the sign-ins couldn't be got ready, and Try again gets them: the can't-reach notice goes with the trouble (review 4109590845)", async () => {
        let down = true;
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/find-nonce': () => {
                if (down) throw new TypeError('Failed to fetch');
                return json(200, { nonce: 'rn-2', expiresInSeconds: 600, clientIds: { google: 'web-client' } });
            },
        });
        renderRestore();
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Can't reach the community right now.");
        down = false;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await screen.findByTestId('restore-provider-google');
        expect(screen.queryByTestId('join-notice')).toBeNull();
    });
});

describe("each provider's return: found, collected by the hold, opened, and handed on only if it is the key the find named", () => {
    for (const provider of ['google', 'apple', 'facebook'] as const) {
        it(`${provider}: back to /app/auth/${provider}, the one account found and brought back with its own key and 12 words, the pending restore gone`, async () => {
            const eph = makeEphemeralKey();
            await leftFor(provider, eph);
            const node = recoveryNode(() => copyOf(account, provider, `${provider}-sub-1`));
            // Apple may carry the nonce hashed, as its native flow does; the node takes either.
            const claim = provider === 'apple' ? bytesToHex(sha256(utf8ToBytes('rn-9'))) : 'rn-9';
            const { onRestored } = renderRestore({ authReturn: returnFrom(provider, 'rn-9', `${provider}-sub-1`, claim) });

            await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
            const restored = onRestored.mock.calls[0][0];
            expect(restored.publicKey).toBe(account.publicKey);
            expect(restored.privateKey).toBe(account.privateKey);
            expect(restored.mnemonic).toEqual(account.mnemonic);
            expect(restored.callsign).toBe('Alice');

            const calls = node.recovery();
            expect(calls.map((c) => c.path)).toEqual(['/api/recovery/find', '/api/recovery/collect', '/api/recovery/collect/fragments']);
            for (const c of calls) expect(c.headers['X-Public-Key']).toBe(eph.publicKey);
            // The token and its nonce, and nothing else of the sign-in: never its sub.
            expect(calls[0].body).toEqual({ provider, idToken: expect.any(String), nonce: 'rn-9' });
            expect(calls[0].body.idToken.split('.')).toHaveLength(3);
            // The account picked by its key alone.
            expect(calls[1].body).toEqual({ candidatePublicKey: account.publicKey });
            expect(await loadPendingRestore()).toBeNull();
            // Saving is WelcomePage's, through the guarded write: nothing here wrote the identity.
            expect(await loadIdentity()).toBeNull();
        });
    }

    it('under <StrictMode> (main.tsx): the effect run twice still takes the pending restore once, and finishes', async () => {
        const eph = makeEphemeralKey();
        await leftFor('google', eph);
        const node = recoveryNode(() => copyOf(account, 'google', 'google-sub-1'));
        const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>(async () => true);
        render(
            <StrictMode>
                <WebRestore onRestored={onRestored} onHeld={vi.fn()} onExisting={vi.fn()} onBack={vi.fn()} onOtherWay={vi.fn()}
                    community={COMMUNITY} navigate={vi.fn()} origin={ORIGIN} authReturn={returnFrom('google', 'rn-9', 'google-sub-1')} />
            </StrictMode>,
        );
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
        expect(onRestored.mock.calls[0][0].publicKey).toBe(account.publicKey);
        expect(node.recovery().filter((c) => c.path === '/api/recovery/find')).toHaveLength(1);
        expect(node.recovery().filter((c) => c.path === '/api/recovery/collect')).toHaveLength(1);
        expect(screen.queryByText("That sign-in wasn't started here.", { exact: false })).toBeNull();
    });

    it('one sign-in, two accounts: "Which account is yours?", nothing collected until the pick, then only the one picked', async () => {
        const eph = makeEphemeralKey();
        await leftFor('google', eph);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/find': () => json(200, { accounts: [{ publicKey: account.publicKey, callsign: 'Alice' }, { publicKey: other.publicKey, callsign: 'Mallory' }] }),
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        await screen.findByText('Which account is yours?');
        const picks = await screen.findAllByTestId('restore-candidate');
        expect(picks.map((b) => b.textContent)).toEqual(['AAlice', 'MMallory']);
        expect(node.recovery().map((c) => c.path)).toEqual(['/api/recovery/find']);
        fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
        expect(onRestored.mock.calls[0][0].publicKey).toBe(account.publicKey);
        const collects = node.recovery().filter((c) => c.path === '/api/recovery/collect');
        expect(collects).toHaveLength(1);
        expect(collects[0].body).toEqual({ candidatePublicKey: account.publicKey });
        expect(collects[0].headers['X-Public-Key']).toBe(eph.publicKey);
    });

    it('no account here uses this sign-in: said in the words of design §5, with the other ways; Start again is a new throwaway key', async () => {
        const eph = makeEphemeralKey();
        await leftFor('google', eph);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), { '/api/recovery/find': () => json(200, { accounts: [] }) });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-none')).toHaveTextContent(
            'No account at Mullumbimby uses this Google account. Try another community, or your 12 words.');
        screen.getByRole('button', { name: 'Use my 12 words' });
        screen.getByRole('button', { name: 'Link with my phone' });
        expect(node.recovery().some((c) => c.path.startsWith('/api/recovery/collect'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
        await screen.findByTestId('restore-provider-google');
        const nonce = node.recovery().filter((c) => c.path === '/api/recovery/find-nonce').pop()!;
        expect(nonce.headers['X-Public-Key']).not.toBe(eph.publicKey);
        expect(onRestored).not.toHaveBeenCalled();
    });

    it("the find was refused (busy finding another account): the node's sentence, back to the sign-ins with a fresh nonce", async () => {
        const eph = makeEphemeralKey();
        await leftFor('google', eph);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/find': () => json(503, { error: 'Busy finding another account. Wait a minute, then sign in again.', code: 'find_busy' }),
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('Busy finding another account. Wait a minute, then sign in again.');
        await screen.findByTestId('restore-provider-google');
        // Still said once the fresh nonce is in: why it came back here is not wiped by getting the sign-ins ready.
        expect(screen.getByTestId('join-notice')).toHaveTextContent('Busy finding another account.');
        const nonce = node.recovery().filter((c) => c.path === '/api/recovery/find-nonce').pop()!;
        expect(nonce.headers['X-Public-Key']).toBe(eph.publicKey);
        expect(onRestored).not.toHaveBeenCalled();
    });

    it("the collect was refused (the hold was spent or ran out): the node's sentence, back to the sign-ins", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect': () => json(400, { error: "Sign in with your account's sign-in first." }),
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Sign in with your account's sign-in first.");
        await screen.findByTestId('restore-provider-google');
        expect(onRestored).not.toHaveBeenCalled();
    });

    it("this browser can't write the account: said, nothing saved, and Try again hands the same account on", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>()
            .mockRejectedValueOnce(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
            .mockResolvedValueOnce(true);
        renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1'), onRestored });
        expect(await screen.findByTestId('restore-save-failed')).toHaveTextContent("this browser couldn't save it");
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(2));
        expect(onRestored.mock.calls[1][0].publicKey).toBe(account.publicKey);
    });

    it("a browser that can never save it is not a dead end: the other ways, and Start again back to the sign-ins (review 4109516322)", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>()
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        const onOtherWay = vi.fn();
        renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1'), onRestored, onOtherWay });
        await screen.findByTestId('restore-save-failed');
        fireEvent.click(screen.getByRole('button', { name: 'Use my 12 words' }));
        expect(onOtherWay).toHaveBeenCalledWith('words');
        fireEvent.click(screen.getByRole('button', { name: 'Link with my phone' }));
        expect(onOtherWay).toHaveBeenCalledWith('phone');
        fireEvent.click(screen.getByRole('button', { name: '← Start again' }));
        await screen.findByTestId('restore-screen-providers');
        expect(onRestored).toHaveBeenCalledTimes(1);
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingRestore()).toBeNull();
    });

    // FABLE-sec-sso finding 2: a community with the seal sends the copy sealed to the throwaway key when asked.
    it('the copy comes back sealed to the throwaway key, and opens to Alice', async () => {
        const eph = makeEphemeralKey();
        await leftFor('google', eph);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/fragments': async (body) => {
                const f = await copyOf(account, 'google', 'g-sub-1');
                if (body?.seal !== KEEPER_ALG_RELEASE) return json(200, { fragments: [f] });
                const s = sealReleaseToDevice({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams },
                    eph.publicKey, { collectionId: 'col-1', holderType: 'sso' });
                return json(200, { fragments: [{ holderType: 'sso', shareIndex: 1, payload: s.encryptedShare, payloadIv: s.shareIv,
                    payloadTag: s.shareTag, ephemeralPubkey: s.ephemeralPubkey, kdfParams: s.kdfParams }] });
            },
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
        expect(onRestored.mock.calls[0][0].publicKey).toBe(account.publicKey);
        expect(node.recovery().find((c) => c.path === '/api/recovery/collect/fragments')?.body).toEqual({ collectionId: 'col-1', seal: KEEPER_ALG_RELEASE });
    });

    it("a sealed copy that doesn't open with this restore's key: nothing handed on, nothing saved, and said", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/fragments': async () => {
                const f = await copyOf(account, 'google', 'g-sub-1');
                const s = sealReleaseToDevice({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams },
                    makeEphemeralKey().publicKey, { collectionId: 'col-1', holderType: 'sso' });
                return json(200, { fragments: [{ holderType: 'sso', shareIndex: 1, payload: s.encryptedShare, payloadIv: s.shareIv,
                    payloadTag: s.shareTag, ephemeralPubkey: s.ephemeralPubkey, kdfParams: s.kdfParams }] });
            },
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-no-copy')).toHaveTextContent("didn't open in this browser, so nothing was changed");
        expect(onRestored).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
    });

    // FABLE-sec-sso finding 4: a session its owner stopped hands nothing over, even a copy it already released.
    it('the session was stopped between the collect and the fetch: back to the sign-ins, said, nothing restored', async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/fragments': () => json(400, { error: 'That recovery session was cancelled.' }),
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('That restore was stopped on the community, or has ended. Start again.');
        await screen.findByTestId('restore-screen-providers');
        expect(onRestored).not.toHaveBeenCalled();
    });

    it("a copy that opens to another key than the one the find named: nothing handed on, nothing saved, and said", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(other, 'google', 'g-sub-1'));
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-wrong-account')).toHaveTextContent("isn't Alice, so nothing was saved");
        expect(onRestored).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
    });

    it('a browser that now holds another account: refused before anything is collected, that account kept, never handed on', async () => {
        await leftFor('google', makeEphemeralKey());
        await importIdentity(other);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored, onHeld } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        await waitFor(() => expect(onHeld).toHaveBeenCalledTimes(1));
        expect(onHeld.mock.calls[0][0].publicKey).toBe(other.publicKey);
        expect(onRestored).not.toHaveBeenCalled();
        expect(node.recovery().some((c) => c.path.startsWith('/api/recovery/collect'))).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
    });

    it('a browser that already holds the account found: says it is already here, collects nothing, and opens it', async () => {
        await leftFor('google', makeEphemeralKey());
        await importIdentity(account);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored, onExisting } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-already-here')).toHaveTextContent('Alice is already in this browser');
        expect(onRestored).not.toHaveBeenCalled();
        expect(node.recovery().some((c) => c.path.startsWith('/api/recovery/collect'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Open Alice' }));
        expect(onExisting.mock.calls[0][0].publicKey).toBe(account.publicKey);
    });

    it("a return this restore didn't start: nothing found or sent, its pending restore left as it was", async () => {
        await leftFor('google', makeEphemeralKey());
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'someone-elses', 'g-sub-1') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That sign-in wasn't started here.");
        expect(node.recovery().some((c) => c.path === '/api/recovery/find' || c.path.startsWith('/api/recovery/collect'))).toBe(false);
        expect(onRestored).not.toHaveBeenCalled();
        expect((await loadPendingRestore())?.nonce).toBe('rn-9');
    });

    it("the node can't be asked to finish: the account stays on this page, and Try again hands it on", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1'), onRestored });
        expect(await screen.findByTestId('restore-save-failed')).toHaveTextContent("the community can't be reached to finish");
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(2));
        expect(onRestored.mock.calls[1][0].publicKey).toBe(account.publicKey);
    });
});
