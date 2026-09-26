/**
 * Getting an account back with a sign-in, in a browser (G11-d): the calls to the node's recovery routes are signed by
 * the throwaway key and nothing else, the lookup is read as the node means it, and the copy that comes back is saved
 * only when it opens to the account the lookup named. The node is a stubbed fetch; the copies are sealed here with
 * core's own seal, as a join seals them. No provider or node is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sealSeedToSso, toEd25519Seed, KEEPER_ALG_SSO, type SealedShare } from '@beanpool/core';
import {
    fetchSignInCopy,
    lookupRestorable,
    makeEphemeralKey,
    openRestoreSession,
    openRestoredAccount,
    pollGithubRestore,
    releaseRefusalMessage,
    releaseSignInCopy,
    requestRestoreNonce,
    restoreProviders,
    startGithubRestore,
    type EphemeralKey,
} from './web-restore';
import { generateIdentity, identityFromMnemonic, type BeanPoolIdentity } from './identity';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call { path: string; method: string; body: any; headers: Record<string, string>; raw: string }

function stubNode(handlers: Record<string, (body: any) => Response>) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const raw = init.body ? String(init.body) : '';
        calls.push({ path, method: init.method ?? 'GET', body: raw ? JSON.parse(raw) : undefined, headers: (init.headers ?? {}) as Record<string, string>, raw });
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        return key ? handlers[key](raw ? JSON.parse(raw) : undefined) : json(404, { error: 'Not Found' });
    }));
    return calls;
}

/** The node's own check: the request is signed, over its method, path, time, nonce and body, by the key it names. */
function signedBy(call: Call, publicKey: string): boolean {
    const h = call.headers;
    if (h['X-Public-Key'] !== publicKey) return false;
    const canonical = `${call.method}\n${call.path.split('?')[0]}\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${call.raw}`;
    const sig = Uint8Array.from(atob(h['X-Signature']), (c) => c.charCodeAt(0));
    return ed25519.verify(sig, new TextEncoder().encode(canonical), hexToBytes(publicKey));
}

let account: BeanPoolIdentity;
let other: BeanPoolIdentity;
beforeEach(async () => {
    account = await generateIdentity('Alice');
    other = await generateIdentity('Mallory');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function sealed(id: BeanPoolIdentity, provider: string, sub: string, words: string[] | null = id.mnemonic ?? null): Promise<SealedShare> {
    return sealSeedToSso(toEd25519Seed(hexToBytes(id.privateKey)), provider, sub, { words });
}

describe('the throwaway key signs every call in the restore', () => {
    it('makes a key that is not an account, held as the web app holds keys', () => {
        const eph = makeEphemeralKey();
        expect(eph.publicKey).toMatch(/^[0-9a-f]{64}$/);
        // PKCS8, whose seed makes the public key.
        expect(eph.privateKey).toHaveLength(96);
        expect(bytesToHex(ed25519.getPublicKey(toEd25519Seed(hexToBytes(eph.privateKey))))).toBe(eph.publicKey);
        expect(makeEphemeralKey().publicKey).not.toBe(eph.publicKey);
    });

    it('open, nonce, GitHub start and poll, release and fetch: each signed by the throwaway key, never the account', async () => {
        const eph: EphemeralKey = makeEphemeralKey();
        const calls = stubNode({
            '/api/recovery/collect/sso-nonce': () => json(200, { nonce: 'n-1', expiresInSeconds: 600, githubFlow: 'node', clientIds: { google: 'web', apple: 'org.beanpool.web', facebook: null } }),
            '/api/recovery/collect/github/start': () => json(200, { sessionId: 'gh-1', userCode: 'ABCD-EFGH', expiresInSeconds: 900, intervalSeconds: 5 }),
            '/api/recovery/collect/github/poll': () => json(200, { status: 'ok', sub: 'gh-sub' }),
            '/api/recovery/collect/sso': () => json(200, { collected: 1 }),
            '/api/recovery/collect/fragments': () => json(200, { fragments: [] }),
            '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1 }),
        });
        expect(await openRestoreSession(eph, 'Alice')).toEqual({ collectionId: 'col-1' });
        const n = await requestRestoreNonce(eph, 'col-1');
        expect(n).toMatchObject({ nonce: { nonce: 'n-1', githubFlow: 'node' } });
        expect(await startGithubRestore(eph, 'col-1')).toMatchObject({ sessionId: 'gh-1', userCode: 'ABCD-EFGH' });
        expect((await pollGithubRestore(eph, 'col-1', 'gh-1')).body).toEqual({ status: 'ok', sub: 'gh-sub' });
        await releaseSignInCopy(eph, 'col-1', { provider: 'google', idToken: 'a.b.c', nonce: 'n-1', sub: 's' });
        await releaseSignInCopy(eph, 'col-1', { provider: 'github', sessionId: 'gh-1', sub: 'gh-sub' });
        await fetchSignInCopy(eph, 'col-1');

        expect(calls.map((c) => c.path)).toEqual([
            '/api/recovery/collect',
            '/api/recovery/collect/sso-nonce',
            '/api/recovery/collect/github/start',
            '/api/recovery/collect/github/poll',
            '/api/recovery/collect/sso',
            '/api/recovery/collect/sso',
            '/api/recovery/collect/fragments',
        ]);
        for (const c of calls) {
            expect(c.method).toBe('POST');
            expect(signedBy(c, eph.publicKey)).toBe(true);
            expect(c.headers['X-Public-Key']).not.toBe(account.publicKey);
        }
        expect(calls[0].body).toEqual({ callsign: 'Alice' });
        expect(calls[3].body).toEqual({ collectionId: 'col-1', sessionId: 'gh-1' });
        // The token and its nonce for a redirect sign-in; the node's own session for GitHub, never a GitHub token.
        expect(calls[4].body).toEqual({ collectionId: 'col-1', provider: 'google', idToken: 'a.b.c', nonce: 'n-1' });
        expect(calls[5].body).toEqual({ collectionId: 'col-1', provider: 'github', proof: { sessionId: 'gh-1' } });
    });

    it('a refused open or nonce hands the answer back rather than a session', async () => {
        const eph = makeEphemeralKey();
        stubNode({
            '/api/recovery/collect/sso-nonce': () => json(404, { error: 'No recovery session for this device.' }),
            '/api/recovery/collect': () => json(400, { error: 'That account has no recovery fragments to collect.' }),
        });
        expect(await openRestoreSession(eph, 'Nobody')).toMatchObject({ answer: { status: 400 } });
        expect(await requestRestoreNonce(eph, 'col-x')).toMatchObject({ answer: { status: 404 } });
    });
});

describe('the lookup', () => {
    it('lists only accounts a sign-in can bring back, with a key that reads as one; unsigned', async () => {
        const calls = stubNode({
            '/api/recovery/lookup/': () => json(200, [
                { publicKey: account.publicKey, callsign: 'Alice', canRecoverBySso: true },
                { publicKey: other.publicKey, callsign: 'Alice2', canRecoverBySso: false },
                { publicKey: 'not-a-key', callsign: 'Alice3', canRecoverBySso: true },
                { publicKey: account.publicKey.toUpperCase(), callsign: 'Alice4', canRecoverBySso: true },
            ]),
        });
        expect(await lookupRestorable(' Ali ')).toEqual([
            { publicKey: account.publicKey, callsign: 'Alice' },
            { publicKey: account.publicKey, callsign: 'Alice4' },
        ]);
        expect(calls[0].path).toBe('/api/recovery/lookup/Ali');
        expect(calls[0].headers['X-Public-Key']).toBeUndefined();
    });

    it('null when the node cannot be asked or answers with something else', async () => {
        stubNode({ '/api/recovery/lookup/': () => json(429, { error: 'slow down' }) });
        expect(await lookupRestorable('Alice')).toBeNull();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        expect(await lookupRestorable('Alice')).toBeNull();
    });
});

describe('which sign-ins are offered', () => {
    it('each one the node gave a browser id for, and GitHub when the node runs it', () => {
        expect(restoreProviders({ nonce: 'n', githubFlow: 'node', clientIds: { google: 'w', apple: 'org.beanpool.web', facebook: 'f' } }))
            .toEqual(['google', 'apple', 'facebook', 'github']);
        expect(restoreProviders({ nonce: 'n', clientIds: { google: 'w', apple: null } })).toEqual(['google']);
    });
});

describe('the copy is saved only when it opens to the account the lookup named', () => {
    it('opens with core, re-derives the 12 words, and gives the account the lookup named, as the web app holds it', async () => {
        const copy = await sealed(account, 'google', 'g-sub-1');
        const r = await openRestoredAccount(copy, 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(r.kind).toBe('ok');
        if (r.kind !== 'ok') return;
        expect(r.identity.publicKey).toBe(account.publicKey);
        // PKCS8, exactly what this app makes from the same words.
        expect(r.identity.privateKey).toBe(account.privateKey);
        expect(r.identity.mnemonic).toEqual(account.mnemonic);
        expect(r.identity.callsign).toBe('Alice');
        expect((await identityFromMnemonic(r.identity.mnemonic!, 'x')).publicKey).toBe(account.publicKey);
    });

    it("another account's copy, where the lookup named Alice: refused, and nothing of it returned", async () => {
        const copy = await sealed(other, 'google', 'g-sub-1');
        const r = await openRestoredAccount(copy, 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(r).toEqual({ kind: 'wrong_account' });
    });

    it('a copy without its words brings the key back alone', async () => {
        const copy = await sealed(account, 'apple', 'a-sub', null);
        const r = await openRestoredAccount(copy, 'apple', 'a-sub', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(r.kind === 'ok' && r.identity.publicKey).toBe(account.publicKey);
        expect(r.kind === 'ok' && r.identity.mnemonic).toBeUndefined();
    });

    it('another sign-in does not open it', async () => {
        const copy = await sealed(account, 'google', 'g-sub-1');
        expect(await openRestoredAccount(copy, 'google', 'g-sub-2', { publicKey: account.publicKey, callsign: 'Alice' })).toEqual({ kind: 'unreadable' });
    });

    it('the old two-part kind is said, not opened', async () => {
        const copy = { ...(await sealed(account, 'google', 'g-sub-1')), kdfParams: JSON.stringify({ alg: KEEPER_ALG_SSO, salt: 'x' }) };
        expect(await openRestoredAccount(copy, 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' })).toEqual({ kind: 'old_format' });
    });

    it('fetchSignInCopy hands over the sign-in copy in the shape core opens', async () => {
        const copy = await sealed(account, 'google', 'g-sub-1');
        stubNode({
            '/api/recovery/collect/fragments': () => json(200, {
                fragments: [{ holderType: 'sso', shareIndex: 1, payload: copy.encryptedShare, payloadIv: copy.shareIv, payloadTag: copy.shareTag, kdfParams: copy.kdfParams }],
            }),
        });
        expect(await fetchSignInCopy(makeEphemeralKey(), 'col-1')).toEqual({ copy });
    });
});

describe('what the member reads', () => {
    it("a sign-in that isn't the account's keeper, in plain words", () => {
        expect(releaseRefusalMessage({ status: 400, body: { error: 'That sign-in account is not the keeper for this recovery.' }, retryAfterSeconds: null }, 'google', 'Alice'))
            .toBe("That Google account isn't a way back into Alice. Try the sign-in you joined with, or your 12 words.");
    });
});
