import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    audienceOf,
    signedRequestBytes,
    signedRequestText,
    toEd25519Pkcs8,
    unboundRequestText,
    utf8Bytes,
} from '@beanpool/core';

/**
 * Request binding (PR 3 of 3, the web app): every request, and the `/ws` connect token, is signed in @beanpool/core's
 * format 2 for the host the fetch actually reaches, so a community can't take what a member signed for it to another
 * community where the same key is a member (the server refuses it there, 421). The host is the detached `bp_node_url`'s
 * when one is set, else this page's own (the node that served it), never anything a node said.
 */

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
// The browser keeps its key as PKCS8 (identity.ts).
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' };

const identityMock = vi.hoisted(() => ({ loadIdentity: vi.fn() }));
vi.mock('./identity', () => identityMock);

import { buildSignedWsParams, request, signedFetchWithKey } from './api';
import { connectToAnchor, resetSyncForTest } from './sync';
import { resetCoordinatorForTest } from './sync-coordinator';

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() };
}

function b64(s: string): Uint8Array {
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** This page's host: the node that served it, in jsdom `localhost`. */
const HERE = window.location.hostname.toLowerCase();

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    identityMock.loadIdentity.mockReset();
    identityMock.loadIdentity.mockResolvedValue(IDENTITY);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The one fetch made: its URL and its signature headers. */
function sent(): { url: string; headers: Record<string, string>; body: string } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    return { url, headers: init.headers as Record<string, string>, body: (init.body as string | undefined) ?? '' };
}

/** Whether `headers` carry `pub`'s signature over format 2's bytes for `host`, `method` and `path`. */
function signedFor(headers: Record<string, string>, pub: string, host: string, method: string, path: string, body: string): boolean {
    const text = signedRequestText({ host, method, path, timestamp: headers['X-Timestamp'], nonce: headers['X-Nonce'], body });
    return ed25519.verify(b64(headers['X-Signature']), signedRequestBytes(text), hexToBytes(pub));
}

describe('a request to the node that served the page is signed for its host', () => {
    it('a write carries X-Signed-For: this host, and a signature over format 2 for it and nothing else', async () => {
        const payload = { to: 'b'.repeat(64), amount: 20, memo: 'Eggs' };
        await request('POST', '/api/ledger/transfer', payload);

        const { url, headers, body } = sent();
        expect(url).toBe('/api/ledger/transfer');
        expect(body).toBe(JSON.stringify(payload));
        expect(HERE).toBe(audienceOf(window.location.origin));
        expect(headers['X-Signed-For']).toBe(HERE);
        expect(headers['X-Public-Key']).toBe(PUB);
        expect(signedFor(headers, PUB, HERE, 'POST', '/api/ledger/transfer', body)).toBe(true);

        // Not the old bytes, which name no community and so were good at every one for five minutes.
        const old = unboundRequestText({ method: 'POST', path: '/api/ledger/transfer', timestamp: headers['X-Timestamp'], nonce: headers['X-Nonce'], body });
        expect(ed25519.verify(b64(headers['X-Signature']), utf8Bytes(old), hexToBytes(PUB))).toBe(false);
        // And not good for another community.
        expect(signedFor(headers, PUB, 'b.example', 'POST', '/api/ledger/transfer', body)).toBe(false);
    });

    it('a gated read signs its path without the query, over an empty body', async () => {
        await request('GET', '/api/messages/conversations?limit=20');

        const { headers } = sent();
        expect(headers['X-Signed-For']).toBe(HERE);
        expect(signedFor(headers, PUB, HERE, 'GET', '/api/messages/conversations', '')).toBe(true);
    });
});

describe('a detached bp_node_url is signed for that URL\'s host, not the page\'s', () => {
    beforeEach(() => {
        localStorage.setItem('bp_node_url', 'https://Node.B.example:8443/');
    });

    it('request() signs for the node it fetches', async () => {
        await request('POST', '/api/member/purge', { confirm: true });

        const { url, headers, body } = sent();
        expect(url).toBe('https://Node.B.example:8443/api/member/purge');
        expect(headers['X-Signed-For']).toBe('node.b.example');
        expect(headers['X-Signed-For']).not.toBe(HERE);
        expect(signedFor(headers, PUB, 'node.b.example', 'POST', '/api/member/purge', body)).toBe(true);
        expect(signedFor(headers, PUB, HERE, 'POST', '/api/member/purge', body)).toBe(false);
    });

    it('signedFetchWithKey (a join\'s or a restore\'s own key, here in a phone\'s raw-seed form) signs for it too', async () => {
        const seed = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
        const pub = bytesToHex(ed25519.getPublicKey(seed));
        await signedFetchWithKey('POST', '/api/join/sso-nonce', { provider: 'github' }, bytesToHex(seed), pub);

        const { url, headers, body } = sent();
        expect(url).toBe('https://Node.B.example:8443/api/join/sso-nonce');
        expect(headers['X-Public-Key']).toBe(pub);
        expect(headers['X-Signed-For']).toBe('node.b.example');
        expect(signedFor(headers, pub, 'node.b.example', 'POST', '/api/join/sso-nonce', body)).toBe(true);
    });
});

describe('signedFetchWithKey on the page\'s own node', () => {
    it('signs for this host', async () => {
        await signedFetchWithKey('POST', '/api/invite/redeem', { code: 'INV-ABCD-EFGH' }, IDENTITY.privateKey, PUB);

        const { url, headers, body } = sent();
        expect(url).toBe('/api/invite/redeem');
        expect(headers['X-Signed-For']).toBe(HERE);
        expect(signedFor(headers, PUB, HERE, 'POST', '/api/invite/redeem', body)).toBe(true);
    });
});

/** The `/ws` params, read back, and whether their signature is `pub`'s over format 2 for `host`. */
function wsSignedFor(query: string, pub: string, host: string): boolean {
    const q = new URLSearchParams(query);
    const text = signedRequestText({ host, method: 'WS', path: '/ws', timestamp: q.get('ts')!, nonce: q.get('nonce')!, body: '' });
    return ed25519.verify(b64(q.get('sig')!), signedRequestBytes(text), hexToBytes(pub));
}

describe('/ws is signed for the host the socket opens to', () => {
    it('buildSignedWsParams gives for=<host>&v=2 and a signature over format 2 for it', async () => {
        const params = await buildSignedWsParams('wss://B.example:8443/ws');
        const q = new URLSearchParams(params);
        expect(q.get('pubkey')).toBe(PUB);
        expect(q.get('for')).toBe('b.example');
        expect(q.get('v')).toBe('2');
        expect(wsSignedFor(params, PUB, 'b.example')).toBe(true);
        expect(wsSignedFor(params, PUB, HERE)).toBe(false);
    });

    it('buildSignedWsParams gives nothing without an identity', async () => {
        identityMock.loadIdentity.mockResolvedValue(null);
        expect(await buildSignedWsParams('wss://b.example/ws')).toBe('');
    });

    describe('connectToAnchor', () => {
        let opened: string[];

        beforeEach(() => {
            resetCoordinatorForTest();
            resetSyncForTest();
            opened = [];
            class StubWebSocket {
                static CONNECTING = 0;
                static OPEN = 1;
                static CLOSED = 3;
                readyState = 0;
                onopen: unknown = null;
                onmessage: unknown = null;
                onclose: unknown = null;
                onerror: unknown = null;
                send = vi.fn();
                close = vi.fn();
                constructor(url: string) { opened.push(url); }
            }
            vi.stubGlobal('WebSocket', StubWebSocket);
        });

        afterEach(() => {
            resetSyncForTest();
        });

        async function socketUrl(): Promise<URL> {
            await vi.waitFor(() => expect(opened).toHaveLength(1));
            return new URL(opened[0]);
        }

        it('on the page\'s own node, the member socket is signed for this host', async () => {
            connectToAnchor();

            const url = await socketUrl();
            expect(url.hostname).toBe(HERE);
            expect(url.pathname).toBe('/ws');
            expect(url.searchParams.get('for')).toBe(HERE);
            expect(url.searchParams.get('v')).toBe('2');
            expect(wsSignedFor(url.search.slice(1), PUB, HERE)).toBe(true);
        });

        it('with a detached bp_node_url, it is signed for that node\'s host', async () => {
            localStorage.setItem('bp_node_url', 'https://node.b.example:8443');
            connectToAnchor();

            const url = await socketUrl();
            expect(url.host).toBe('node.b.example:8443');
            expect(url.searchParams.get('for')).toBe('node.b.example');
            expect(wsSignedFor(url.search.slice(1), PUB, 'node.b.example')).toBe(true);
        });
    });
});
