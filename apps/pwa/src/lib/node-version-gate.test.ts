/**
 * The web app talks only to servers from 1.4.0 when it reaches a community other than the one that served the page
 * (lib/node-version-gate.ts; cutover W). A community whose health names an older version gets one plain line, and
 * nothing but the health read is sent to it. Nothing here contacts a node: fetch is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

vi.mock('./identity', async () => ({ ...(await vi.importActual('./identity')), loadIdentity: vi.fn(async () => null) }));
import { loadIdentity, type BeanPoolIdentity } from './identity';
import {
    HEALTH_READ_TIMEOUT_MS, MIN_NODE_VERSION, NodeTooOldError, isNodeTooOldError, nodeTooOldText, nodeVersionBelowMinimum,
    refuseIfNodeTooOld, resetNodeVersionGateForTests,
} from './node-version-gate';
import { fetchMembershipAt, getCommunityHealth, getRemotePosts, request, signedCopyFetch, signedFetchAt, testNodeConnection } from './api';
import { membershipAt, purgeHere } from './delete-here';

const OLD = 'https://old.example.org';
const NEW = 'https://new.example.org';
const LINE_OLD = "This community's server runs BeanPool 1.2.37. This app needs 1.4.0 or newer. Its operator must update.";
const KEY = 'a'.repeat(64);

const seed = '07'.repeat(32);
const kim = { publicKey: bytesToHex(ed25519.getPublicKey(hexToBytes(seed))), privateKey: seed, callsign: 'Kim' } as BeanPoolIdentity;

/** A stub fetch: each community answers its health with `versions[origin]`, and everything else with `{}`. */
function communities(versions: Record<string, unknown>, reached: string[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        reached.push(url);
        const origin = new URL(url, window.location.origin).origin;
        if (url.endsWith('/api/community/health')) {
            const v = versions[origin];
            if (v === 'down') throw new TypeError('Failed to fetch');
            if (v === 'html') return new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 });
            if (v === 'refused') return new Response('{}', { status: 503 });
            return new Response(JSON.stringify(v === undefined ? {} : { version: v }), { status: 200 });
        }
        return new Response(JSON.stringify({ isMember: true, communityName: 'Somewhere', posts: [] }), { status: 200 });
    }));
    return reached;
}

const healthReads = (reached: string[]) => reached.filter((u) => u.endsWith('/api/community/health'));

beforeEach(() => {
    localStorage.clear();
    resetNodeVersionGateForTests();
    vi.mocked(loadIdentity).mockResolvedValue(null);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('the rule', () => {
    it('is 1.4.0, baked in', () => {
        expect(MIN_NODE_VERSION).toBe('1.4.0');
    });

    it.each([
        ['1.2.37', '1.2.37'], ['1.3.4', '1.3.4'], ['1.3.99', '1.3.99'], ['0.9.0', '0.9.0'], ['v1.2.0', '1.2.0'], ['1.4', null],
        ['1.4.0', null], ['1.4.1', null], ['1.10.0', null], ['2.0.0', null],
    ])('a health answer of version %s is below the minimum: %s', (version, below) => {
        expect(nodeVersionBelowMinimum({ version })).toBe(below);
    });

    it.each([
        ['nothing', null], ['a string', 'ok'], ['a list', ['1.2.0']], ['no version', {}], ['a version that is not one', { version: 'next' }],
        ['a number', { version: 1.2 }], ['the unresolved 0.0.0', { version: '0.0.0' }],
    ])('every doubt is not too old: %s', (_what, body) => {
        expect(nodeVersionBelowMinimum(body)).toBeNull();
    });

    it('says one plain line, with the server\'s version in it', () => {
        expect(nodeTooOldText('1.2.37')).toBe(LINE_OLD);
        const e = new NodeTooOldError('1.2.37');
        expect(e.message).toBe(LINE_OLD);
        expect(e.nodeVersion).toBe('1.2.37');
        expect(isNodeTooOldError(e)).toBe(true);
        expect(isNodeTooOldError(new Error('x'))).toBe(false);
    });
});

describe('refuseIfNodeTooOld', () => {
    it('refuses a community below 1.4.0, after reading only its health', async () => {
        const reached = communities({ [OLD]: '1.2.37' });
        await expect(refuseIfNodeTooOld(`${OLD}/some/path`)).rejects.toThrow(LINE_OLD);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('lets a community at 1.4.0 or newer through', async () => {
        communities({ [NEW]: '1.4.0' });
        await expect(refuseIfNodeTooOld(NEW)).resolves.toBeUndefined();
    });

    it('asks a community once, whatever the number of calls, and calls made together share the one read', async () => {
        const reached = communities({ [OLD]: '1.3.4', [NEW]: '1.4.0' });
        const results = await Promise.allSettled([refuseIfNodeTooOld(OLD), refuseIfNodeTooOld(OLD), refuseIfNodeTooOld(NEW)]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
        await expect(refuseIfNodeTooOld(OLD)).rejects.toBeInstanceOf(NodeTooOldError);
        await refuseIfNodeTooOld(NEW);
        expect(healthReads(reached)).toEqual([`${OLD}/api/community/health`, `${NEW}/api/community/health`]);
    });

    it('never asks the page\'s own address: it is this page\'s version', async () => {
        const reached = communities({ [window.location.origin]: '1.2.0' });
        await expect(refuseIfNodeTooOld(window.location.origin)).resolves.toBeUndefined();
        await expect(refuseIfNodeTooOld('')).resolves.toBeUndefined();
        await expect(refuseIfNodeTooOld('not an address')).resolves.toBeUndefined();
        expect(reached).toEqual([]);
    });

    it.each(['down', 'html', 'refused'])('a community that can\'t be read (%s) is a doubt: the call goes, and it is not asked again for a minute', async (how) => {
        vi.useFakeTimers();
        const reached = communities({ [OLD]: how });
        await expect(refuseIfNodeTooOld(OLD)).resolves.toBeUndefined();
        await expect(refuseIfNodeTooOld(OLD)).resolves.toBeUndefined();
        expect(healthReads(reached)).toHaveLength(1);
        vi.setSystemTime(Date.now() + 61_000);
        await expect(refuseIfNodeTooOld(OLD)).resolves.toBeUndefined();
        expect(healthReads(reached)).toHaveLength(2);
    });

    it('a community that says no version is a doubt', async () => {
        communities({ [OLD]: undefined });
        await expect(refuseIfNodeTooOld(OLD)).resolves.toBeUndefined();
    });

    it('gives up waiting for a silent community at its limit, and lets the call go', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })));
        const done = refuseIfNodeTooOld(OLD);
        await vi.advanceTimersByTimeAsync(HEALTH_READ_TIMEOUT_MS + 1);
        await expect(done).resolves.toBeUndefined();
    });
});

describe('every call to another community goes through it', () => {
    it('fetchMembershipAt: refused below 1.4.0, nothing but health sent', async () => {
        const reached = communities({ [OLD]: '1.2.37' });
        await expect(fetchMembershipAt(OLD, KEY)).rejects.toThrow(LINE_OLD);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('fetchMembershipAt: goes to 1.4.0', async () => {
        const reached = communities({ [NEW]: '1.4.0' });
        const res = await fetchMembershipAt(NEW, KEY);
        expect(res.ok).toBe(true);
        expect(reached).toEqual([`${NEW}/api/community/health`, `${NEW}/api/community/membership/${KEY}`]);
    });

    it('signedFetchAt: refused below 1.4.0, nothing but health sent', async () => {
        const reached = communities({ [OLD]: '1.3.0' });
        await expect(signedFetchAt('POST', OLD, '/api/join/knock', '{}', kim)).rejects.toBeInstanceOf(NodeTooOldError);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('signedCopyFetch: refused below 1.4.0, nothing but health sent', async () => {
        const reached = communities({ [OLD]: '1.3.0' });
        await expect(signedCopyFetch('GET', OLD, '/api/me/unread', undefined, kim)).rejects.toBeInstanceOf(NodeTooOldError);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('a peer\'s posts: refused below 1.4.0 (the Market\'s browse), nothing but health sent', async () => {
        const reached = communities({ [OLD]: '1.2.37' });
        await expect(getRemotePosts(OLD)).rejects.toThrow(LINE_OLD);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
        sessionStorage.clear();
    });

    it('a web app pointed at a community below 1.4.0 (Sovereign Node Connection) sends it nothing but the health read', async () => {
        localStorage.setItem('bp_node_url', OLD);
        const reached = communities({ [OLD]: '1.2.37' });
        await expect(request('GET', '/api/community/info')).rejects.toThrow(LINE_OLD);
        await expect(request('POST', '/api/posts', { a: 1 })).rejects.toThrow(LINE_OLD);
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('a web app pointed at a community of 1.4.0 or newer talks to it as before', async () => {
        localStorage.setItem('bp_node_url', NEW);
        const reached = communities({ [NEW]: '1.4.0' });
        await expect(request('GET', '/api/community/info')).resolves.toMatchObject({ communityName: 'Somewhere' });
        expect(reached).toEqual([`${NEW}/api/community/health`, `${NEW}/api/community/info`]);
        // The health read is the gate's own: the app's own health route reads it through the same door.
        await expect(getCommunityHealth()).resolves.toBeTruthy();
    });

    it('the page\'s own node is never asked for its version', async () => {
        const reached = communities({});
        await request('GET', '/api/community/info');
        expect(reached).toEqual(['/api/community/info']);
    });

    it('Sovereign Node Connection\'s test says the line, and does not read the community\'s info', async () => {
        const reached = communities({ [OLD]: '1.2.37', [NEW]: '1.4.2' });
        expect(await testNodeConnection(OLD)).toEqual({ ok: false, error: LINE_OLD });
        expect(reached).toEqual([`${OLD}/api/community/health`]);
        expect(await testNodeConnection(NEW)).toMatchObject({ ok: true, callsign: 'Somewhere' });
    });
});

describe('Delete account (lib/delete-here.ts)', () => {
    it('a community below 1.4.0 is not asked about the key: it counts as one that could not be reached', async () => {
        const reached = communities({ [OLD]: '1.2.37' });
        expect(await membershipAt(OLD, KEY)).toBe('unreachable');
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });

    it('the delete at a node below 1.4.0 is not sent: nothing changes, and the line says why', async () => {
        localStorage.setItem('bp_node_url', OLD);
        const reached = communities({ [OLD]: '1.2.37' });
        const out = await purgeHere({ kind: 'last', here: OLD });
        expect(out).toEqual({ ok: false, reason: LINE_OLD });
        expect(reached).toEqual([`${OLD}/api/community/health`]);
    });
});
