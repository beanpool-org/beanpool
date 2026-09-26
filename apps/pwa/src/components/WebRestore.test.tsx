/**
 * The restore screens (G11-d): an account back in a browser with the sign-in it joined with. The node is a stubbed
 * fetch, every provider is a URL the page is asked to go to, and the copies are sealed here with core's own seal, as a
 * join seals them. Nothing leaves the test.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sealSeedToSso, toEd25519Seed } from '@beanpool/core';
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
    return { calls, recovery: () => calls.filter((c) => c.path.startsWith('/api/recovery/collect')) };
}

let account: BeanPoolIdentity;
let other: BeanPoolIdentity;
let idb: MemoryIndexedDB;

async function copyOf(id: BeanPoolIdentity, provider: string, sub: string) {
    const c = await sealSeedToSso(toEd25519Seed(hexToBytes(id.privateKey)), provider, sub, { words: id.mnemonic ?? null });
    return { holderType: 'sso', shareIndex: 1, payload: c.encryptedShare, payloadIv: c.shareIv, payloadTag: c.shareTag, kdfParams: c.kdfParams };
}

/** The node's recovery routes, answering for Alice with `copy` (Alice's own, unless a test says otherwise). */
function recoveryNode(copy: () => Promise<unknown>, overrides: Record<string, Handler> = {}) {
    let nonces = 0;
    return stubNode({
        '/api/recovery/lookup/': () => json(200, [{ publicKey: account.publicKey, callsign: 'Alice', canRecoverBySso: true }]),
        '/api/recovery/collect/sso-nonce': () => json(200, {
            nonce: `rn-${++nonces}`, expiresInSeconds: 600, githubFlow: 'node',
            clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
        }),
        '/api/recovery/collect/github/start': () => json(200, { sessionId: 'gh-1', userCode: 'WDJB-MJHT', expiresInSeconds: 900, intervalSeconds: 0.01 }),
        '/api/recovery/collect/github/poll': () => json(200, { status: 'ok', sub: 'gh-sub-1' }),
        '/api/recovery/collect/sso': () => json(200, { collected: 1, threshold: 1, enough: true }),
        '/api/recovery/collect/fragments': async () => json(200, { collected: 1, threshold: 1, enough: true, fragments: [await copy()] }),
        '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1 }),
        ...overrides,
    });
}

function renderRestore(props: Partial<React.ComponentProps<typeof WebRestore>> = {}) {
    const onRestored = vi.fn<(identity: BeanPoolIdentity) => Promise<boolean>>(async () => true);
    const onHeld = vi.fn();
    const onExisting = vi.fn();
    const navigate = vi.fn();
    render(<WebRestore onRestored={onRestored} onHeld={onHeld} onExisting={onExisting} onBack={vi.fn()} onOtherWay={vi.fn()}
        navigate={navigate} origin={ORIGIN} authReturn={null} {...props} />);
    return { onRestored, onHeld, onExisting, navigate };
}

/** A restore that left the page for `provider` with nonce `nonce`, as the screens store it. */
async function leftFor(provider: JoinProvider, eph: EphemeralKey, nonce = 'rn-9'): Promise<PendingRestore> {
    const now = Date.now();
    const r: PendingRestore = {
        kind: 'restore', ephemeral: eph, account: { publicKey: account.publicKey, callsign: 'Alice' }, collectionId: 'col-1',
        provider, nonce, startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS,
    };
    await savePendingRestore(r);
    return r;
}

function returnFrom(provider: 'google' | 'apple' | 'facebook', nonce: string, sub: string, claimNonce = nonce): AuthReturn {
    return readAuthReturn(`/app/auth/${provider}`, `#state=${nonce}&id_token=${fakeJwt({ sub, nonce: claimNonce })}`)!;
}

async function pickAlice() {
    fireEvent.change(await screen.findByTestId('restore-callsign'), { target: { value: 'Ali' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
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

describe('from the name to the provider', () => {
    it("the account by name; the session and nonce asked by a throwaway key; Google left for with state === nonce; nothing saved", async () => {
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { navigate } = renderRestore();
        await pickAlice();
        await screen.findByTestId('restore-screen-providers');
        for (const p of ['google', 'apple', 'facebook', 'github']) await screen.findByTestId(`restore-provider-${p}`);

        const [open, nonce] = node.recovery();
        expect(open).toMatchObject({ path: '/api/recovery/collect', body: { callsign: 'Alice' } });
        const eph = open.headers['X-Public-Key'];
        expect(eph).toMatch(/^[0-9a-f]{64}$/);
        expect(eph).not.toBe(account.publicKey);
        expect(nonce).toMatchObject({ path: '/api/recovery/collect/sso-nonce', body: { collectionId: 'col-1' } });
        expect(nonce.headers['X-Public-Key']).toBe(eph);

        fireEvent.click(screen.getByTestId('restore-provider-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('state')).toBe('rn-1');
        expect(url.searchParams.get('nonce')).toBe('rn-1');
        expect(url.searchParams.get('client_id')).toBe('web-client');
        expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/app/auth/google`);

        const waiting = (await loadPendingRestore())!;
        expect(waiting).toMatchObject({ kind: 'restore', provider: 'google', nonce: 'rn-1', collectionId: 'col-1', account: { publicKey: account.publicKey, callsign: 'Alice' } });
        expect(waiting.ephemeral.publicKey).toBe(eph);
        expect(await loadIdentity()).toBeNull();
    });

    it('a browser that already holds another account: said, nothing opened on the node, nothing replaced', async () => {
        await importIdentity(other);
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onHeld } = renderRestore();
        await pickAlice();
        await waitFor(() => expect(onHeld).toHaveBeenCalledTimes(1));
        expect(onHeld.mock.calls[0][0].publicKey).toBe(other.publicKey);
        expect(node.recovery()).toHaveLength(0);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
    });

    it('the sign-in just tried at the door is offered first', async () => {
        recoveryNode(() => copyOf(account, 'apple', 'a-sub'));
        renderRestore({ provider: 'apple' });
        await pickAlice();
        await screen.findByTestId('restore-provider-apple');
        const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid')).filter((t) => t?.startsWith('restore-provider-'));
        expect(buttons[0]).toBe('restore-provider-apple');
    });

    it('no account by that name that a sign-in can bring back: said, with the other ways', async () => {
        stubNode({ '/api/recovery/lookup/': () => json(200, []) });
        renderRestore();
        fireEvent.change(await screen.findByTestId('restore-callsign'), { target: { value: 'Zed' } });
        await screen.findByTestId('restore-none');
        screen.getByRole('button', { name: 'Use my 12 words' });
        screen.getByRole('button', { name: 'Link with my phone' });
    });

    it('the global node finds the whole name only: a name part-typed is never said to have no account starting so (review 4109516319)', async () => {
        // As routes/community.ts answers on a node that shows visitors the listings and not the people: exact, case forgiven.
        const lookups: string[] = [];
        const node: ReturnType<typeof recoveryNode> = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/lookup/': () => {
                const typed = decodeURIComponent(node.calls[node.calls.length - 1].path.split('/').pop() ?? '').toLowerCase();
                lookups.push(typed);
                return json(200, typed === 'alice' ? [{ publicKey: account.publicKey, callsign: 'Alice', canRecoverBySso: true }] : []);
            },
        });
        renderRestore();
        const input = await screen.findByTestId('restore-callsign');
        fireEvent.change(input, { target: { value: 'Ali' } });
        const none = await screen.findByTestId('restore-none');
        expect(none).toHaveTextContent('No account called Ali here can come back with a sign-in.');
        expect(none).toHaveTextContent("Check you've typed your whole name.");
        expect(none).not.toHaveTextContent('starting with');
        fireEvent.change(input, { target: { value: 'alice' } });
        await screen.findByRole('button', { name: 'Alice' });
        expect(screen.queryByTestId('restore-none')).toBeNull();
        expect(lookups).toEqual(['ali', 'alice']);
    });
});

describe('each provider\'s return: the copy released to the throwaway key, opened, and the account handed on only if it is the name\'s', () => {
    for (const provider of ['google', 'apple', 'facebook'] as const) {
        it(`${provider}: back to /app/auth/${provider}, Alice's own key and 12 words, the pending restore gone`, async () => {
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
            expect(calls.map((c) => c.path)).toEqual(['/api/recovery/collect/sso', '/api/recovery/collect/fragments']);
            for (const c of calls) expect(c.headers['X-Public-Key']).toBe(eph.publicKey);
            expect(calls[0].body).toMatchObject({ collectionId: 'col-1', provider, nonce: 'rn-9' });
            expect(calls[0].body.idToken.split('.')).toHaveLength(3);
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
                    navigate={vi.fn()} origin={ORIGIN} authReturn={returnFrom('google', 'rn-9', 'google-sub-1')} />
            </StrictMode>,
        );
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
        expect(onRestored.mock.calls[0][0].publicKey).toBe(account.publicKey);
        expect(node.recovery().filter((c) => c.path === '/api/recovery/collect/sso')).toHaveLength(1);
        expect(screen.queryByText("That sign-in wasn't started here.", { exact: false })).toBeNull();
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

    it("a browser that can never save it is not a dead end: the other ways, and Start again back to the name (review 4109516322)", async () => {
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
        await screen.findByTestId('restore-screen-name');
        expect(onRestored).toHaveBeenCalledTimes(1);
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingRestore()).toBeNull();
    });

    it('the node let the session go before the sign-ins: back to the name, said, never an empty sign-in screen', async () => {
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/sso-nonce': () => json(404, { error: 'No recovery session for this device.' }),
        });
        renderRestore();
        await pickAlice();
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('That restore timed out on the community.');
        await screen.findByTestId('restore-screen-name');
    });

    it("the sign-ins couldn't be got ready, and Try again gets them: the can't-reach notice goes with the trouble (review 4109590845)", async () => {
        let down = true;
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/sso-nonce': () => {
                if (down) throw new TypeError('Failed to fetch');
                return json(200, { nonce: 'rn-2', expiresInSeconds: 600, githubFlow: 'node', clientIds: { google: 'web-client' } });
            },
        });
        renderRestore();
        await pickAlice();
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Can't reach the community right now.");
        down = false;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await screen.findByTestId('restore-provider-google');
        expect(screen.queryByTestId('join-notice')).toBeNull();
    });

    it('GitHub: the code, the wait, released with the node\'s session', async () => {
        const node = recoveryNode(() => copyOf(account, 'github', 'gh-sub-1'));
        const { onRestored } = renderRestore();
        await pickAlice();
        fireEvent.click(await screen.findByTestId('restore-provider-github'));
        expect(await screen.findByTestId('restore-github-code')).toHaveTextContent('WDJB-MJHT');
        await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
        expect(onRestored.mock.calls[0][0].publicKey).toBe(account.publicKey);
        const eph = node.recovery()[0].headers['X-Public-Key'];
        const release = node.recovery().find((c) => c.path === '/api/recovery/collect/sso')!;
        expect(release.body).toEqual({ collectionId: 'col-1', provider: 'github', proof: { sessionId: 'gh-1' } });
        for (const c of node.recovery()) expect(c.headers['X-Public-Key']).toBe(eph);
    });

    it("a copy that opens to another account than the name's: nothing handed on, nothing saved, and said", async () => {
        await leftFor('google', makeEphemeralKey());
        recoveryNode(() => copyOf(other, 'google', 'g-sub-1'));
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-wrong-account')).toHaveTextContent("isn't Alice, so nothing was saved");
        expect(onRestored).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
    });

    it('a browser that now holds another account: refused, that account kept, never handed on', async () => {
        await leftFor('google', makeEphemeralKey());
        await importIdentity(other);
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored, onHeld } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        await waitFor(() => expect(onHeld).toHaveBeenCalledTimes(1));
        expect(onHeld.mock.calls[0][0].publicKey).toBe(other.publicKey);
        expect(onRestored).not.toHaveBeenCalled();
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
    });

    it('a browser that already holds this same account: says it is already here, and opens it', async () => {
        await leftFor('google', makeEphemeralKey());
        await importIdentity(account);
        recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored, onExisting } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-1') });
        expect(await screen.findByTestId('restore-already-here')).toHaveTextContent('Alice is already in this browser');
        expect(onRestored).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Open Alice' }));
        expect(onExisting.mock.calls[0][0].publicKey).toBe(account.publicKey);
    });

    it("a return this restore didn't start: nothing sent, its pending restore left as it was", async () => {
        await leftFor('google', makeEphemeralKey());
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'));
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'someone-elses', 'g-sub-1') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That sign-in wasn't started here.");
        expect(node.recovery()).toHaveLength(0);
        expect(onRestored).not.toHaveBeenCalled();
        expect((await loadPendingRestore())?.nonce).toBe('rn-9');
    });

    it("a sign-in that isn't the account's: said plainly, back to the sign-ins with a fresh nonce", async () => {
        await leftFor('google', makeEphemeralKey());
        const node = recoveryNode(() => copyOf(account, 'google', 'g-sub-1'), {
            '/api/recovery/collect/sso': () => json(400, { error: 'That sign-in account is not the keeper for this recovery.' }),
        });
        const { onRestored } = renderRestore({ authReturn: returnFrom('google', 'rn-9', 'g-sub-2') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That Google account isn't a way back into Alice.");
        await screen.findByTestId('restore-provider-google');
        // Still said once the fresh nonce is in: why it came back here is not wiped by getting the sign-ins ready.
        expect(screen.getByTestId('join-notice')).toHaveTextContent("That Google account isn't a way back into Alice.");
        expect(node.recovery().some((c) => c.path === '/api/recovery/collect/sso-nonce')).toBe(true);
        expect(onRestored).not.toHaveBeenCalled();
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
