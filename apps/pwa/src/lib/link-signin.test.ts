/**
 * Adding a sign-in to an account made with 12 words (two-doors design §2.5, slice S5; the node's `POST /api/join/link`
 * from #1425): the nonce asked for signed by the member's key, the page leaving for the provider with it, the return
 * matched to this account's link only, and one signed request carrying the sign-in and the sealed copy, which opens with
 * the sign-in to the member's key and 12 words. Every refusal is a sentence. The node is a stubbed fetch; nothing leaves
 * the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSeedFromSso } from '@beanpool/core';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateIdentity, type BeanPoolIdentity } from './identity';
import { readAuthReturn } from './web-join';
import {
    clearPendingLink,
    finishLink,
    isLinkReturn,
    leaveForLink,
    linkResultMessage,
    loadPendingLink,
    requestLinkNonce,
    PENDING_LINK_TTL_MS,
} from './link-signin';

const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'link-nonce-1';

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

type Handler = (body: any) => Response;
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function stubNode(handlers: Record<string, Handler>) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        const h = handlers[path];
        return h ? h(body) : json(404, { error: 'Not Found' });
    }));
    return calls;
}
const nonceAnswer = () => json(200, {
    nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'],
    clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: null }, vault: null,
});

let member: BeanPoolIdentity;
beforeEach(async () => {
    localStorage.clear();
    member = await generateIdentity('Bea');
});
afterEach(() => {
    vi.unstubAllGlobals();
});

async function leftForGoogle(now: number = Date.now()): Promise<string> {
    const calls = stubNode({ '/api/join/link/sso-nonce': nonceAnswer });
    const got = await requestLinkNonce(member);
    if (!('nonce' in got)) throw new Error(got.message);
    const navigate = vi.fn();
    expect(leaveForLink(member, 'google', got.nonce, { origin: ORIGIN, navigate, now })).toEqual({ ok: true });
    expect(calls[0].headers['X-Public-Key']).toBe(member.publicKey);
    return navigate.mock.calls[0][0] as string;
}

describe('leaving for the provider', () => {
    it("the nonce is the node's for adding a sign-in to THIS member, and goes as nonce and state; the return comes to this origin", async () => {
        const url = new URL(await leftForGoogle(1_000));
        expect(url.origin).toBe('https://accounts.google.com');
        expect(url.searchParams.get('nonce')).toBe(NONCE);
        expect(url.searchParams.get('state')).toBe(NONCE);
        expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/app/auth/google`);
        expect(url.searchParams.get('client_id')).toBe('web-client');
        expect(loadPendingLink(1_000)).toEqual({ publicKey: member.publicKey, provider: 'google', nonce: NONCE, startedAt: 1_000, expiresAt: 1_000 + PENDING_LINK_TTL_MS });
        // And it lives only as long as the node's nonce.
        expect(loadPendingLink(1_000 + PENDING_LINK_TTL_MS + 1)).toBeNull();
    });

    it('a sign-in the node gives a browser no id for is not offered a trip', async () => {
        stubNode({ '/api/join/link/sso-nonce': nonceAnswer });
        const got = await requestLinkNonce(member);
        if (!('nonce' in got)) throw new Error('no nonce');
        const navigate = vi.fn();
        expect(leaveForLink(member, 'facebook', got.nonce, { origin: ORIGIN, navigate })).toEqual({ ok: false, message: "Facebook sign-in isn't available here." });
        expect(navigate).not.toHaveBeenCalled();
        expect(loadPendingLink()).toBeNull();
    });

    it("the node's refusals of the nonce are sentences: already has one, came in another way, can't check sign-ins, busy", async () => {
        const cases: Array<[Response, RegExp]> = [
            [json(409, { error: 'This account already has a sign-in.', code: 'already_linked' }), /already has a sign-in/],
            [json(409, { error: "This account wasn't made with 12 words here, so there is no sign-in to add to it.", code: 'not_words_member' }), /wasn't made with 12 words/],
            [json(503, { error: "This community can't check sign-ins right now, so it isn't taking new members this way.", code: 'door_key_missing' }), /can't check sign-ins/],
            [json(429, { error: 'Too many attempts. Try again in 40s' }, { 'Retry-After': '40' }), /^Too many tries just now\. Try again in 1 minute\.$/],
        ];
        for (const [res, said] of cases) {
            stubNode({ '/api/join/link/sso-nonce': () => res });
            const got = await requestLinkNonce(member);
            expect('message' in got && got.message).toMatch(said);
        }
    });
});

describe('the way back', () => {
    const SUB = 'g-sub-77';
    const googleReturn = (state = NONCE, sub = SUB, nonce = NONCE) =>
        readAuthReturn('/app/auth/google', `#state=${state}&id_token=${fakeJwt({ sub, nonce })}`)!;

    it('matched to this account only: another key, another state, or no link started is not a link return', async () => {
        await leftForGoogle();
        expect(isLinkReturn(googleReturn(), member)).toBe(true);
        expect(isLinkReturn(googleReturn('someone-elses'), member)).toBe(false);
        expect(isLinkReturn(googleReturn(), await generateIdentity('Other'))).toBe(false);
        clearPendingLink();
        expect(isLinkReturn(googleReturn(), member)).toBe(false);
    });

    it('one signed request with the sign-in and the copy, which opens with it to the key and the 12 words; then linked', async () => {
        await leftForGoogle();
        const calls = stubNode({ '/api/join/link': () => json(200, { success: true, provider: 'google', recovery: { enrolled: true } }) });
        const result = await finishLink(member, googleReturn());
        expect(result).toEqual({ kind: 'linked', provider: 'google', recoveryStored: true });
        expect(calls).toHaveLength(1);
        const sent = calls[0];
        expect(sent.headers['X-Public-Key']).toBe(member.publicKey);
        expect(sent.body).toMatchObject({ provider: 'google', nonce: NONCE });
        expect(sent.body.idToken).toBe(googleReturn().idToken);
        // The copy: one piece for this sign-in, opening to the member's raw seed and their words.
        expect(sent.body.recovery.shares).toHaveLength(1);
        const opened = await openSeedFromSso(sent.body.recovery.shares[0], 'google', SUB);
        expect(bytesToHex(opened.seed)).toBe(member.privateKey.slice(32));
        expect(opened.words).toEqual(member.mnemonic);
        // Used up: a second return with the same state is not a link's.
        expect(loadPendingLink()).toBeNull();
        expect(linkResultMessage(result)).toBe('Google is added. Signing in with it also brings this account back, and your new-account limits are now the usual ones.');
    });

    it("a copy the node can't read: the same sign-in goes again without it, once; the sign-in is still added", async () => {
        await leftForGoogle();
        let n = 0;
        const calls = stubNode({
            '/api/join/link': () => (++n === 1
                ? json(400, { error: 'The recovery keeper could not be read: …', code: 'recovery_invalid' })
                : json(200, { success: true, provider: 'google' })),
        });
        const result = await finishLink(member, googleReturn());
        expect(result).toEqual({ kind: 'linked', provider: 'google', recoveryStored: false });
        expect(calls).toHaveLength(2);
        expect(calls[1].body.recovery).toBeUndefined();
        expect(linkResultMessage(result)).toMatch(/your 12 words are still your only way back/);
    });

    it("the node's refusals of the link are sentences, and nothing is retried", async () => {
        const cases: Array<[Response, RegExp]> = [
            [json(409, { code: 'already_joined', error: 'x' }), /^This Google account already has another BeanPool account here, so it can't be added to this one\./],
            [json(403, { code: 'removed', error: 'x' }), /belonged to an account that was removed from this community/],
            [json(401, { code: 'sign_in', error: 'token expired' }), /^Google couldn't confirm that sign-in\. Try again\.$/],
            [json(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now. Please try again in a minute.' }), /could not be checked right now/],
            [json(429, { error: 'Too many attempts. Try again in 61s' }, { 'Retry-After': '61' }), /^Too many tries just now\. Try again in 2 minutes\.$/],
        ];
        for (const [res, said] of cases) {
            await leftForGoogle();
            const calls = stubNode({ '/api/join/link': () => res });
            const result = await finishLink(member, googleReturn());
            expect(result.kind).toBe('failed');
            expect(linkResultMessage(result)).toMatch(said);
            expect(calls).toHaveLength(1);
        }
    });

    it('cancelled at the provider, or a token for another nonce: nothing is sent', async () => {
        await leftForGoogle();
        let calls = stubNode({});
        expect(await finishLink(member, readAuthReturn('/app/auth/google', `#state=${NONCE}&error=access_denied`)!))
            .toEqual({ kind: 'cancelled', provider: 'google' });
        expect(calls).toHaveLength(0);
        await leftForGoogle();
        calls = stubNode({});
        const out = await finishLink(member, googleReturn(NONCE, SUB, 'another-nonce'));
        expect(out.kind).toBe('failed');
        expect(calls).toHaveLength(0);
    });
});
