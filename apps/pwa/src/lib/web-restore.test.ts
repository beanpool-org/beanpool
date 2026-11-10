/**
 * Getting an account back with a sign-in, in a browser (G11-d), with nothing typed (recovery S1): the calls to the node's
 * find and recovery routes are signed by the throwaway key and nothing else, the find is read as the node means it, and
 * the copy that comes back is saved only when it opens to the account the find named. The node is a stubbed fetch; the
 * copies are sealed here with core's own seal, as a join seals them. No provider or node is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    sealReleaseToDevice,
    sealSeedToSso,
    signedRequestBytes,
    signedRequestText,
    toEd25519Seed,
    KEEPER_ALG_RELEASE,
    KEEPER_ALG_SSO,
    type SealedShare,
} from '@beanpool/core';
import {
    collectAccount,
    collectRefusalMessage,
    fetchSignInCopy,
    findAccounts,
    findRefusalMessage,
    makeEphemeralKey,
    noAccountMessage,
    openRestoredAccount,
    requestFindNonce,
    restoreProviders,
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

/**
 * The node's own check: the request is signed, over this community's host (the page's: same origin), its method, path,
 * time, nonce and body (@beanpool/core's format 2), by the key it names.
 */
function signedBy(call: Call, publicKey: string): boolean {
    const h = call.headers;
    if (h['X-Public-Key'] !== publicKey) return false;
    const host = window.location.hostname;
    if (h['X-Signed-For'] !== host) return false;
    const text = signedRequestText({ host, method: call.method, path: call.path.split('?')[0], timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], body: call.raw });
    const sig = Uint8Array.from(atob(h['X-Signature']), (c) => c.charCodeAt(0));
    return ed25519.verify(sig, signedRequestBytes(text), hexToBytes(publicKey));
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

    it('find nonce, find, collect and fetch: each signed by the throwaway key, never the account; no name is sent', async () => {
        const eph: EphemeralKey = makeEphemeralKey();
        const calls = stubNode({
            '/api/recovery/find-nonce': () => json(200, { nonce: 'n-1', expiresInSeconds: 600, clientIds: { google: 'web', apple: 'org.beanpool.web', facebook: null } }),
            '/api/recovery/find': () => json(200, { accounts: [{ publicKey: account.publicKey, callsign: 'Alice' }] }),
            '/api/recovery/collect/fragments': () => json(200, { fragments: [] }),
            '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1 }),
        });
        const n = await requestFindNonce(eph);
        expect(n).toEqual({ nonce: { nonce: 'n-1', clientIds: { google: 'web', apple: 'org.beanpool.web', facebook: null } } });
        expect(await findAccounts(eph, { provider: 'google', idToken: 'a.b.c', nonce: 'n-1', sub: 's' }))
            .toEqual({ accounts: [{ publicKey: account.publicKey, callsign: 'Alice' }] });
        expect(await collectAccount(eph, { publicKey: account.publicKey, callsign: 'Alice' })).toEqual({ collectionId: 'col-1' });
        await fetchSignInCopy(eph, 'col-1');

        expect(calls.map((c) => c.path)).toEqual([
            '/api/recovery/find-nonce',
            '/api/recovery/find',
            '/api/recovery/collect',
            '/api/recovery/collect/fragments',
        ]);
        for (const c of calls) {
            expect(c.method).toBe('POST');
            expect(signedBy(c, eph.publicKey)).toBe(true);
            expect(c.headers['X-Public-Key']).not.toBe(account.publicKey);
        }
        expect(calls[0].body).toEqual({});
        // The token and its nonce, and nothing else of the sign-in: never its sub.
        expect(calls[1].body).toEqual({ provider: 'google', idToken: 'a.b.c', nonce: 'n-1' });
        // The account picked, by its key alone: no name, no session id.
        expect(calls[2].body).toEqual({ candidatePublicKey: account.publicKey });
        expect(calls.some((c) => c.path.includes('/lookup/') || c.path.endsWith('/collect/sso') || c.path.endsWith('/collect/sso-nonce'))).toBe(false);
    });

    it('a refused nonce, find or collect hands the answer back, a 404 included', async () => {
        const eph = makeEphemeralKey();
        stubNode({
            '/api/recovery/find-nonce': () => json(404, { error: 'Not Found' }),
            '/api/recovery/find': () => json(503, { error: 'Busy finding another account. Wait a minute, then sign in again.', code: 'find_busy' }),
            '/api/recovery/collect': () => json(400, { error: "Sign in with your account's sign-in first." }),
        });
        expect(await requestFindNonce(eph)).toMatchObject({ answer: { status: 404 } });
        expect(await findAccounts(eph, { provider: 'google', idToken: 'a.b.c', nonce: 'n-1', sub: 's' })).toMatchObject({ answer: { status: 503 } });
        expect(await collectAccount(eph, { publicKey: account.publicKey, callsign: 'Alice' })).toMatchObject({ answer: { status: 400 } });
    });
});

describe('the find', () => {
    it('names every account with a key that reads as one and a name, once each, in the node\'s order', async () => {
        stubNode({
            '/api/recovery/find': () => json(200, {
                accounts: [
                    { publicKey: other.publicKey, callsign: 'Kit' },
                    { publicKey: 'not-a-key', callsign: 'Nobody' },
                    { publicKey: account.publicKey.toUpperCase(), callsign: 'Pat' },
                    { publicKey: account.publicKey, callsign: 'Pat again' },
                    { publicKey: other.publicKey.slice(0, 63) + '0', callsign: '  ' },
                    null,
                ],
            }),
        });
        expect(await findAccounts(makeEphemeralKey(), { provider: 'google', idToken: 't', nonce: 'n', sub: 's' })).toEqual({
            accounts: [
                { publicKey: other.publicKey, callsign: 'Kit' },
                { publicKey: account.publicKey, callsign: 'Pat' },
            ],
        });
    });

    it('an empty list is an answer: no account here uses this sign-in', async () => {
        stubNode({ '/api/recovery/find': () => json(200, { accounts: [] }) });
        expect(await findAccounts(makeEphemeralKey(), { provider: 'apple', idToken: 't', nonce: 'n', sub: 's' })).toEqual({ accounts: [] });
    });

    it('an answer with no list is handed back as refused', async () => {
        stubNode({ '/api/recovery/find': () => json(200, { ok: true }) });
        expect(await findAccounts(makeEphemeralKey(), { provider: 'google', idToken: 't', nonce: 'n', sub: 's' })).toMatchObject({ answer: { status: 200 } });
    });
});

describe('which sign-ins are offered', () => {
    it('each one the node gave a browser id for, always in the same order', () => {
        expect(restoreProviders({ nonce: 'n', clientIds: { google: 'w', apple: 'org.beanpool.web', facebook: 'f' } }))
            .toEqual(['google', 'apple', 'facebook']);
        expect(restoreProviders({ nonce: 'n', clientIds: { facebook: 'f', google: 'w' } })).toEqual(['google', 'facebook']);
        expect(restoreProviders({ nonce: 'n', clientIds: { google: 'w', apple: null } })).toEqual(['google']);
        expect(restoreProviders({ nonce: 'n', clientIds: {} })).toEqual([]);
    });

    it('a name in the answer that is not a sign-in this app offers is never offered', () => {
        const clientIds = { google: 'w', myspace: 'm', toString: 'x' } as Record<string, string>;
        expect(restoreProviders({ nonce: 'n', clientIds })).toEqual(['google']);
    });
});

describe('the copy is saved only when it opens to the account the find named', () => {
    it('opens with core, re-derives the 12 words, and gives the account the find named, as the web app holds it', async () => {
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

    it("another account's copy, where the find named Alice: refused, and nothing of it returned", async () => {
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

    it("a copy with the member's list of communities gives it back with the account; one without, none (VR5)", async () => {
        const list = [{ name: 'Mullumbimby', url: 'https://mullum.beanpool.org' }, { name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' }];
        const withList = await sealSeedToSso(toEd25519Seed(hexToBytes(account.privateKey)), 'google', 'g-sub-1', {
            words: account.mnemonic ?? null, communities: list,
        });
        const r = await openRestoredAccount(withList, 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(r.kind === 'ok' && r.communities).toEqual(list);
        expect(r.kind === 'ok' && r.identity.mnemonic).toEqual(account.mnemonic);
        const without = await openRestoredAccount(await sealed(account, 'google', 'g-sub-1'), 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(without.kind === 'ok' && without.communities).toEqual([]);
        expect(without.kind === 'ok' && without.identity.publicKey).toBe(account.publicKey);
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

    // FABLE-sec-sso finding 2: the node seals the copy to the throwaway key when asked (core sealReleaseToDevice, as
    // routes/recovery-collect.ts does), so the bytes on the wire are nothing without it.
    function sealingNode(copy: SealedShare, to: string, collectionId = 'col-1') {
        return stubNode({
            '/api/recovery/collect/fragments': (body) => {
                if (body?.seal !== KEEPER_ALG_RELEASE) return json(200, { fragments: [] });
                const s = sealReleaseToDevice(copy, to, { collectionId, holderType: 'sso' });
                return json(200, {
                    fragments: [{ holderType: 'sso', shareIndex: 1, payload: s.encryptedShare, payloadIv: s.shareIv, payloadTag: s.shareTag,
                        ephemeralPubkey: s.ephemeralPubkey, kdfParams: s.kdfParams }],
                });
            },
        });
    }

    it('fetchSignInCopy asks for the copy sealed to the throwaway key, signed by it, and opens it with that key', async () => {
        const eph = makeEphemeralKey();
        const copy = await sealed(account, 'google', 'g-sub-1');
        const calls = sealingNode(copy, eph.publicKey);
        const fetched = await fetchSignInCopy(eph, 'col-1');
        expect(fetched).toEqual({ copy });
        expect(calls[0].body).toEqual({ collectionId: 'col-1', seal: KEEPER_ALG_RELEASE });
        expect(signedBy(calls[0], eph.publicKey)).toBe(true);
        const opened = await openRestoredAccount((fetched as { copy: SealedShare }).copy, 'google', 'g-sub-1', { publicKey: account.publicKey, callsign: 'Alice' });
        expect(opened).toMatchObject({ kind: 'ok', identity: { publicKey: account.publicKey } });
    });

    it('a copy sealed to another key, or for another session, is not opened, and nothing of it is returned', async () => {
        const copy = await sealed(account, 'google', 'g-sub-1');
        sealingNode(copy, makeEphemeralKey().publicKey);
        expect(await fetchSignInCopy(makeEphemeralKey(), 'col-1')).toEqual({ unopened: true });
        const eph = makeEphemeralKey();
        sealingNode(copy, eph.publicKey, 'col-other');
        expect(await fetchSignInCopy(eph, 'col-1')).toEqual({ unopened: true });
    });
});

describe('what the member reads', () => {
    it('no account here, in the words of design §5', () => {
        expect(noAccountMessage('Mullumbimby', 'google')).toBe('No account at Mullumbimby uses this Google account. Try another community, or your 12 words.');
    });

    it("the node's own sentence where it gave one (a busy scan, a spent hold); plain words where it gave none", () => {
        expect(findRefusalMessage({ status: 503, body: { error: 'Busy finding another account. Wait a minute, then sign in again.', code: 'find_busy' } }, 'google'))
            .toBe('Busy finding another account. Wait a minute, then sign in again.');
        expect(findRefusalMessage({ status: 401, body: { error: 'Invalid token', code: 'sso_invalid' } }, 'apple')).toBe("Apple sign-in couldn't be checked or took too long. Try again.");
        // A 401 with no code is the signature middleware refusing this device's clock, before any sign-in was read.
        expect(findRefusalMessage({ status: 401, body: { error: 'Stale request' } }, 'apple')).toMatch(/date and time look wrong/);
        expect(findRefusalMessage({ status: 503, body: {} }, 'google')).toBe('Google sign-in could not be checked right now. Please try again in a minute.');
        // A nonce refused before any sign-in names no provider.
        expect(findRefusalMessage({ status: 500, body: {} }, null)).toBe('The community could not bring the account back (500). Please try again.');
        expect(collectRefusalMessage({ status: 400, body: { error: "Sign in with your account's sign-in first." } })).toBe("Sign in with your account's sign-in first.");
        expect(collectRefusalMessage({ status: 429, body: {} })).toBe('Too many tries from this network. Please try again later.');
    });
});
