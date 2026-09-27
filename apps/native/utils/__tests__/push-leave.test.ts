/**
 * An account that leaves this phone with no connection still stops its push alerts there, once the phone is back online
 * (utils/push-leave.ts, utils/account-leaves-phone.ts, utils/push-registrations.ts).
 *
 * #1184 had Sign Out send the old key's signed DELETE /api/push-tokens once, best effort. Offline it never arrived and
 * nothing retried it: the old account's alerts, message previews included, kept reaching the phone, possibly someone
 * else's by then. And a registration already on its way when Sign Out started could land after the DELETE and bring the
 * row back. Here:
 *
 *   - Sign Out offline writes down one statement per community the token went to, signed by the old key before it goes,
 *     and a later online sync presents each, unsigned, until its community confirms; it survives an app restart, and a
 *     community that can't be reached or doesn't know the statement yet keeps it for next time;
 *   - a registration on its way at Sign Out finishes before the leave goes out, one not yet sent never is, and nothing
 *     registers for the leaving key after that;
 *   - the same account signing back in on this phone is never undone by its old statement, even with the clock set back
 *     and after a restart.
 *
 * Nothing contacts a node: fetch is a fake community per address, which keeps push rows as the server does
 * (apps/server state-engine.ts registerPushToken / applyPushLeave, pinned over HTTP by test-push-leave-statement.ts) and
 * checks each signature from @beanpool/core's definitions and noble, never the app's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
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
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf } from '@beanpool/core';
import { signOutOfThisPhone } from '../account-leaves-phone';
import { announceAccountOnPhone } from '../account-on-phone';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { pendingLeaveStatements, presentLeaveStatements, type LeaveStatement } from '../push-leave';
import { registerPushTokenWithCommunity, stopRegistering } from '../push-registrations';
import { boundSignatureValid } from './server-signature-check';
import { PUSH_LEAVE_STATEMENTS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_STAMP_STORE_KEY, PUSH_TOKEN_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';
const DAY = 24 * 60 * 60 * 1000;

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length);

/** The leave statement's signed bytes, written out here: 0xFF, then `beanpool-push-leave/2\nHOST\nKEY\nTOKEN\nSTAMP`. */
function statementValid(host: string, key: string, token: string, leftAt: unknown, signature: unknown): boolean {
    if (typeof signature !== 'string' || typeof leftAt !== 'number') return false;
    const text = Buffer.from(`beanpool-push-leave/2\n${host}\n${key}\n${token}\n${leftAt}`, 'utf8');
    try {
        return ed25519.verify(bytes(Buffer.from(signature, 'base64')), new Uint8Array([0xff, ...text]), bytes(Buffer.from(key, 'hex')));
    } catch {
        return false;
    }
}

interface Sent {
    community: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: any;
    rawBody: string;
    /** When the community acted on it (a held request acts when it is let through), in the order of `log`. */
    actedAt?: number;
}

/**
 * The phone's communities: each keeps push rows by (key, token) with the phone's stamp, and the leaves it applied, as
 * the server does. `answer` decides what a request meets on the way: 'up', 'down' (a network error), a status the
 * community answers without acting (e.g. 421, 500), or 'hold' (it waits until released, then acts).
 */
class Communities {
    rows = new Map<string, Map<string, number | null>>();
    leaves = new Map<string, Map<string, number>>();
    sent: Sent[] = [];
    log: string[] = [];
    answer: (s: Sent) => 'up' | 'down' | 'hold' | number = () => 'up';
    held: Array<() => void> = [];

    constructor() {
        vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const rawBody = String(init?.body ?? '');
            const s: Sent = {
                community: url.origin, path: url.pathname, method: init?.method ?? 'GET',
                headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(rawBody || '{}'), rawBody,
            };
            this.sent.push(s);
            const a = this.answer(s);
            if (a === 'down') throw new TypeError('Network request failed');
            if (typeof a === 'number') return new Response(JSON.stringify({ error: 'not now' }), { status: a });
            if (a === 'hold') await new Promise<void>((resolve) => this.held.push(resolve));
            return this.act(s, `${url.origin}${url.pathname}`);
        });
    }

    releaseHeld(): void {
        for (const release of this.held.splice(0)) release();
    }

    rowsAt(community: string): Map<string, number | null> {
        if (!this.rows.has(community)) this.rows.set(community, new Map());
        return this.rows.get(community)!;
    }

    has(community: string, key: string, token = PHONE_TOKEN): boolean {
        return this.rowsAt(community).has(`${key}|${token}`);
    }

    private applyLeave(community: string, key: string, token: string, leftAt: number): void {
        const rows = this.rowsAt(community);
        const id = `${key}|${token}`;
        const stamp = rows.get(id);
        if (rows.has(id) && (stamp === null || (stamp as number) <= leftAt)) rows.delete(id);
        if (!this.leaves.has(community)) this.leaves.set(community, new Map());
        const leaves = this.leaves.get(community)!;
        leaves.set(id, Math.max(leaves.get(id) ?? 0, leftAt));
    }

    private act(s: Sent, where: string): Response {
        s.actedAt = this.log.push(`${s.method} ${where}`);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        const signed = (key: string) => boundSignatureValid({ url: where, method: s.method, headers: s.headers, body: s.rawBody }, key);
        if (s.path === '/api/push-tokens' && s.method === 'POST') {
            const { publicKey, token, registeredAt } = s.body;
            if (!signed(publicKey)) return json(403, { error: 'Invalid cryptographic signature' });
            const id = `${publicKey}|${token}`;
            if ((this.leaves.get(s.community)?.get(id) ?? 0) >= registeredAt) return json(409, { code: 'push_token_left' });
            const rows = this.rowsAt(s.community);
            const had = rows.get(id);
            if (!(typeof had === 'number' && had > registeredAt)) rows.set(id, registeredAt ?? null);
            return json(200, { success: true });
        }
        if (s.path === '/api/push-tokens' && s.method === 'DELETE') {
            const { publicKey, token, leftAt } = s.body;
            if (!signed(publicKey)) return json(403, { error: 'Invalid cryptographic signature' });
            if (typeof leftAt === 'number') this.applyLeave(s.community, publicKey, token, leftAt);
            else this.rowsAt(s.community).delete(`${publicKey}|${token}`);
            return json(200, { success: true });
        }
        const leave = /^\/api\/push-tokens\/leave\/([0-9a-f]{64})$/.exec(s.path);
        if (leave && s.method === 'POST') {
            const { token, leftAt, signature, signedFor } = s.body;
            if (signedFor !== audienceOf(s.community)) return json(421, { code: 'wrong_community' });
            if (!statementValid(signedFor, leave[1], token, leftAt, signature)) return json(403, { code: 'push_leave_refused' });
            this.applyLeave(s.community, leave[1], token, leftAt);
            return json(200, { left: true });
        }
        return json(404, { error: 'Not found' });
    }
}

let kim: BeanPoolIdentity;
let ben: BeanPoolIdentity;
let nodes: Communities;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const quietError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
    ben = await draftIdentity('Ben');
    nodes = new Communities();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim on the phone, with its token registered at Mullum and at Byron (the app opened while set to each), Bellingen never. */
async function kimRegisteredAtMullumAndByron(): Promise<number[]> {
    await importIdentity(kim);
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    for (const community of [MULLUM, BYRON]) {
        mem.async.set(ANCHOR, community);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
    }
    expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
    return nodes.sent.filter((s) => s.method === 'POST').map((s) => s.body.registeredAt as number);
}

/** A fresh copy of the leave module, as after an app restart (nothing in memory; storage as it was). */
async function afterRestart(): Promise<typeof import('../push-leave')> {
    vi.resetModules();
    return import('../push-leave');
}

const stored = () => JSON.parse(mem.async.get(PUSH_LEAVE_STATEMENTS_STORE_KEY) ?? '[]') as LeaveStatement[];

describe('Sign Out with no connection', () => {
    it('writes down, before the key goes, a statement for each community the token went to, signed by Kim\'s key for that community only', async () => {
        const registeredAt = await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';

        await signOutOfThisPhone(kim);

        expect(await loadIdentity()).toBeNull();
        const statements = stored();
        expect(statements.map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        for (const s of statements) {
            const host = audienceOf(s.community)!;
            expect(s).toMatchObject({ publicKey: kim.publicKey, token: PHONE_TOKEN, signedFor: host });
            expect(statementValid(host, kim.publicKey, PHONE_TOKEN, s.leftAt, s.signature)).toBe(true);
            // Good at its own community only.
            expect(statementValid(audienceOf(BELLINGEN)!, kim.publicKey, PHONE_TOKEN, s.leftAt, s.signature)).toBe(false);
            // After every registration the phone made.
            expect(s.leftAt).toBeGreaterThan(Math.max(...registeredAt));
        }
        // The rows are still there: nothing reached either community.
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
        // Written before any leave went out: the DELETEs (all failed) came after the statements were on the phone.
        const setItem = vi.mocked(AsyncStorage.setItem);
        const setAt = setItem.mock.invocationCallOrder[setItem.mock.calls.findIndex(([key]) => key === PUSH_LEAVE_STATEMENTS_STORE_KEY)];
        const firstDelete = nodes.sent.findIndex((s) => s.method === 'DELETE');
        expect(setAt).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[firstDelete]);
        // The record of where the token went goes with the account; the statements stay.
        expect(mem.async.has(PUSH_REGISTERED_AT_STORE_KEY)).toBe(false);
    });

    it('a later online sync presents each, unsigned, until its community confirms, across an app restart; then Kim\'s rows are gone', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        // Someone else signs in on the phone meanwhile.
        await importIdentity(ben);

        // The app restarts. Mullum is reachable, Byron not yet.
        const leave = await afterRestart();
        nodes.answer = (s) => (s.community === BYRON ? 'down' : 'up');
        const before = nodes.sent.length;
        await leave.presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        for (const req of nodes.sent.slice(before)) {
            expect(req.method).toBe('POST');
            expect(req.path).toBe(`/api/push-tokens/leave/${kim.publicKey}`);
            // Unsigned, and nothing of the account now on the phone.
            expect(req.headers['X-Public-Key']).toBeUndefined();
            expect(req.headers['X-Signature']).toBeUndefined();
            expect(JSON.stringify(req)).not.toContain(ben.publicKey);
            expect(Object.keys(req.body).sort()).toEqual(['leftAt', 'signature', 'signedFor', 'token']);
        }

        // Byron answers, but doesn't take it yet (a server error, then a name it doesn't know as its own): kept.
        nodes.answer = () => 500;
        await leave.presentLeaveStatements();
        nodes.answer = () => 421;
        await leave.presentLeaveStatements();
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);

        // Weeks later, still there after another restart; Byron is back.
        const again = await afterRestart();
        nodes.answer = () => 'up';
        await again.presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(mem.async.has(PUSH_LEAVE_STATEMENTS_STORE_KEY)).toBe(false);

        // Nothing left to present: no request.
        const quiet = nodes.sent.length;
        await again.presentLeaveStatements();
        expect(nodes.sent.length).toBe(quiet);
    });

    it('a community that says it will never act on a statement has it dropped; one that isn\'t reached keeps it', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        const [first] = stored();
        // A statement its community refuses for good (here: one whose signature was spoiled on the phone).
        mem.async.set(PUSH_LEAVE_STATEMENTS_STORE_KEY, JSON.stringify(stored().map((s) =>
            s.community === first.community ? { ...s, signature: Buffer.alloc(64).toString('base64') } : s)));
        nodes.answer = (s) => (s.community === first.community ? 'up' : 'down');

        await presentLeaveStatements();

        expect(stored().map((s) => s.community)).toEqual([first.community === MULLUM ? BYRON : MULLUM]);
    });

    it('online, the signed DELETE carries the leave\'s stamp and each community that takes it has its statement crossed off', async () => {
        await kimRegisteredAtMullumAndByron();

        await signOutOfThisPhone(kim);

        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(mem.async.has(PUSH_LEAVE_STATEMENTS_STORE_KEY)).toBe(false);
        const deletes = nodes.sent.filter((s) => s.method === 'DELETE');
        expect(deletes.map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        for (const d of deletes) expect(d.body.leftAt).toBe(Number(mem.async.get(PUSH_STAMP_STORE_KEY)));
        // No statement needed presenting.
        expect(nodes.sent.some((s) => s.path.startsWith('/api/push-tokens/leave/'))).toBe(false);
    });
});

describe('a registration and Sign Out at the same time', () => {
    it('a registration on its way when Sign Out starts finishes before the leave goes out, so the leave lands after it', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        // Mullum is slow: the registration is on its way, and lands only when let through.
        nodes.answer = (s) => (s.method === 'POST' && s.path === '/api/push-tokens' ? 'hold' : 'up');

        const registering = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        await vi.waitFor(() => expect(nodes.held).toHaveLength(1));
        const signingOut = signOutOfThisPhone(kim);
        // Sign Out waits for it: nothing of the leave has gone out.
        await new Promise((r) => setTimeout(r, 50));
        expect(nodes.sent.filter((s) => s.method === 'DELETE')).toHaveLength(0);

        nodes.releaseHeld();
        await registering;
        await signingOut;

        const registration = nodes.sent.find((s) => s.method === 'POST')!;
        const del = nodes.sent.find((s) => s.method === 'DELETE')!;
        expect(del.actedAt).toBeGreaterThan(registration.actedAt!);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(await loadIdentity()).toBeNull();
    });

    it('a registration that had not gone out when Sign Out started never goes out', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);

        const registering = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        const leaving = stopRegistering(kim.publicKey);

        expect(await registering).toBe(false);
        await leaving;
        await signOutOfThisPhone(kim);
        expect(nodes.sent.filter((s) => s.method === 'POST' && s.path === '/api/push-tokens')).toHaveLength(0);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
    });

    it('nor does one whose leave began after it was stamped and while it was being signed, just before it would have gone', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        // Sign Out starts the moment the registration's stamp is written down: after its first look, before its last.
        let leaving: Promise<void> | undefined;
        vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, value: string) => {
            mem.async.set(key, value);
            if (key === PUSH_STAMP_STORE_KEY && !leaving) leaving = stopRegistering(kim.publicKey);
        });

        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);

        expect(leaving).toBeDefined();
        await leaving;
        expect(nodes.sent).toHaveLength(0);
    });

    it('nothing registers for Kim after Sign Out starts, not even a name change during it; Kim written to the phone again does', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);

        await stopRegistering(kim.publicKey);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);
        // A name change announces the same key: still leaving.
        announceAccountOnPhone(kim.publicKey);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);
        // Someone else registers as before.
        expect(await registerPushTokenWithCommunity(ben, PHONE_TOKEN, 'android')).toBe(true);
        // The key comes off the phone, and Kim signs back in: registers again.
        announceAccountOnPhone(null);
        await importIdentity(kim);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        expect(nodes.sent.filter((s) => s.method === 'POST').map((s) => s.body.publicKey)).toEqual([ben.publicKey, kim.publicKey]);
    });
});

describe('Kim signs back in on the same phone', () => {
    it('her new registration outranks her old statement, with the clock set back a day and after a restart, and the statement leaves it', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        const leftAt = stored()[0].leftAt;

        // The phone's clock goes back a day, the app restarts, and Kim signs back in while set to Mullum.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() - DAY);
        vi.resetModules();
        const registrations = await import('../push-registrations');
        const identity = await import('../identity');
        await identity.importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = () => 'up';
        expect(await registrations.registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        const back = nodes.sent.filter((s) => s.method === 'POST' && s.path === '/api/push-tokens').at(-1)!;
        expect(back.body.registeredAt).toBeGreaterThan(leftAt);

        // Then the old statements are presented.
        const leave = await import('../push-leave');
        await leave.presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true); // her registration since stays
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false); // the one from before, where she hasn't registered since, goes
        expect(await leave.pendingLeaveStatements()).toEqual([]);
    });

    it('signing out again later takes the new registration too', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = () => 'up';
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);

        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        // One statement per community and key: Mullum's newer one replaced the older.
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        nodes.answer = () => 'up';
        await presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await pendingLeaveStatements()).toEqual([]);
    });
});
