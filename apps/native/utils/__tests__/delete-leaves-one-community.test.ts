/**
 * Delete account leaves only the community the phone is set to, and the key goes only at the member's last one
 * (Marty, 2026-09-29; utils/delete-here.ts).
 *
 * Before, Settings' Permanently Delete Account deleted the account at the community the phone was set to and then
 * wiped the phone as Sign Out does: a member of several communities lost the key for all of them. Now the phone asks
 * each other saved community whether the key is a member there, and one that can't be asked counts as a yes, so a poor
 * connection never costs the key:
 * - another keeps it: the node deletes here, this community leaves the phone, the phone is set to the other, the key
 *   and 12 words stay;
 * - none does: the delete here, then the whole wipe as before (account-leaves-phone.test.ts covers the wipe itself);
 * - the node doesn't delete: nothing on the phone changes, and the screen says the key wasn't touched.
 * The not-recognised screen (node-mismatch.tsx) takes the key off the phone only when no saved community keeps it.
 *
 * Nothing here contacts a node: fetch is a stub that records what would have been sent. The screens' wiring is in
 * delete-leaves-one-community-screens.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>(), anchorAtInit: [] as (string | undefined)[] }));
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
vi.mock('../db', () => ({
    clearDB: vi.fn(async () => {}),
    closeDB: vi.fn(async () => {}),
    // Which community's copy the phone opens next.
    initDB: vi.fn(async () => { mem.anchorAtInit.push(mem.async.get('beanpool_anchor_url')); }),
}));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { removeCommunityCaches } from '../community-cache';
import { clearDB, initDB } from '../db';
import {
    deleteAccountHere, deleteFailedLine, keepsKeyLine, lastCommunityLine, leaveThisCommunity, membershipAt,
    otherCommunitiesKeeping, planDelete, stillKeptLine, type DeletePlan,
} from '../delete-here';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { boundSignatureValid } from './server-signature-check';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const GUESTS = 'beanpool_guest_nodes';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';
const ESCROW_REFUSAL = 'You have an escrow deal under way. Finish or cancel it first.';

/** A community's answer to the membership probe. */
type Probe = 'member' | 'stranger' | 'down' | 'refused' | 'silent' | 'not-json' | 'odd';
/** Its answer to the purge. */
type Purge = 'ok' | 'refused' | 'down';

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }

function nodes(probe: Record<string, Probe>, purge: Purge = 'ok'): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        sent.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
        const u = new URL(url);
        const community = u.origin;
        if (method === 'GET' && u.pathname.startsWith('/api/community/membership/')) {
            const a = probe[community];
            if (!a) throw new Error(`No membership question expected at ${community}`);
            if (a === 'down') throw new TypeError('Network request failed');
            if (a === 'silent') {
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });
            }
            if (a === 'refused') return new Response('{"error":"nope"}', { status: 502 });
            if (a === 'not-json') return new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 });
            if (a === 'odd') return new Response('{}', { status: 200 });
            return new Response(JSON.stringify(a === 'member'
                ? { isMember: true, callsign: 'Kim' }
                : { isMember: false, callsign: null, isRecovering: false, recoveryStatus: null }), { status: 200 });
        }
        if (method === 'POST' && u.pathname === '/api/member/purge') {
            if (purge === 'down') throw new TypeError('Network request failed');
            if (purge === 'refused') return new Response(JSON.stringify({ error: ESCROW_REFUSAL }), { status: 400 });
            return new Response(JSON.stringify({ ok: true, message: 'Account purged' }), { status: 200 });
        }
        if (method === 'DELETE' && u.pathname === '/api/push-tokens') {
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        throw new Error(`No request expected: ${method} ${url}`);
    });
    return sent;
}

const purges = (sent: Sent[]) => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/api/member/purge'));
const probes = (sent: Sent[]) => sent.filter((s) => s.method === 'GET').map((s) => new URL(s.url).origin);
const savedUrls = () => JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string }) => n.url);

let kim: BeanPoolIdentity;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    mem.anchorAtInit.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // identity.ts reaches AsyncStorage and the database through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * Kim's phone: set to Mullum; Mullum and Bellingen saved (and `more`); a push token registered with both; Mullum once
 * visited as a guest.
 */
async function kimsPhone(more: { url: string; alias?: string }[] = []) {
    await importIdentity(kim);
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: BELLINGEN, alias: 'Bellingen' }, ...more]));
    mem.async.set(GUESTS, JSON.stringify([MULLUM, BYRON]));
    mem.async.set('beanpool_light_palette', 'sand');
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM, BELLINGEN]));
}

/** Everything on the phone is as it was before the delete. */
async function untouched() {
    const onPhone = await loadIdentity();
    expect(onPhone?.publicKey).toBe(kim.publicKey);
    expect(onPhone?.mnemonic).toEqual(kim.mnemonic);
    expect(mem.async.get(ANCHOR)).toBe(MULLUM);
    expect(savedUrls()).toEqual([MULLUM, BELLINGEN]);
    expect(JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]')).toEqual([MULLUM, BELLINGEN]);
    expect(removeCommunityCaches).not.toHaveBeenCalled();
    expect(clearDB).not.toHaveBeenCalled();
    expect(initDB).not.toHaveBeenCalled();
}

describe('Delete account with another saved community where Kim is a member', () => {
    it('the node deletes here only; Mullum leaves the phone; the key and 12 words stay; the phone is set to Bellingen', async () => {
        await kimsPhone();
        const sent = nodes({ [BELLINGEN]: 'member' });

        const plan = await planDelete(kim.publicKey);
        expect(plan).toEqual({
            kind: 'this-one', here: MULLUM, hereName: 'Mullum',
            keeps: [{ url: BELLINGEN, name: 'Bellingen', membership: 'member' }],
            next: { url: BELLINGEN, name: 'Bellingen', membership: 'member' },
        });
        // Mullum itself is never asked: its answer is the account the member is deleting.
        expect(probes(sent)).toEqual([BELLINGEN]);

        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'left' });

        // The server delete went to Mullum alone, signed by Kim's key for Mullum.
        expect(purges(sent).map((s) => s.url)).toEqual([`${MULLUM}/api/member/purge`]);
        const [purge] = purges(sent);
        expect(boundSignatureValid({ url: purge.url, method: 'POST', headers: purge.headers, body: purge.body }, kim.publicKey)).toBe(true);
        // Nothing asked Bellingen to drop the push token: its alerts go on.
        expect(sent.filter((s) => s.method === 'DELETE')).toEqual([]);

        // The key, the 12 words and the push token stay.
        const onPhone = await loadIdentity();
        expect(onPhone?.publicKey).toBe(kim.publicKey);
        expect(onPhone?.privateKey).toBe(kim.privateKey);
        expect(onPhone?.mnemonic).toEqual(kim.mnemonic);
        expect(mem.secure.get(PUSH_TOKEN_STORE_KEY)).toBe(PHONE_TOKEN);
        expect(mem.async.get('beanpool_light_palette')).toBe('sand');

        // Mullum is gone from the list, the push record and the guest markers; only its cached copy went.
        expect(savedUrls()).toEqual([BELLINGEN]);
        expect(JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]')).toEqual([BELLINGEN]);
        expect(JSON.parse(mem.async.get(GUESTS) ?? '[]')).toEqual([BYRON]);
        expect(vi.mocked(removeCommunityCaches).mock.calls).toEqual([[[MULLUM]]]);
        expect(clearDB).not.toHaveBeenCalled();

        // The phone is set to Bellingen, and Bellingen's copy is what opens.
        expect(mem.async.get(ANCHOR)).toBe(BELLINGEN);
        expect(mem.anchorAtInit).toEqual([BELLINGEN]);
    });

    it('the phone was set to Mullum before Mullum left the list, so nothing puts Mullum back in it', async () => {
        await kimsPhone();
        nodes({ [BELLINGEN]: 'member' });
        const plan = await planDelete(kim.publicKey);
        const order: string[] = [];
        vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, value: string) => {
            order.push(key);
            mem.async.set(key, value);
        });

        await deleteAccountHere(kim, plan);

        expect(order.indexOf(ANCHOR)).toBeGreaterThan(-1);
        expect(order.indexOf(ANCHOR)).toBeLessThan(order.indexOf(SAVED_NODES_STORE_KEY));
        // nodes.ts getSavedNodes writes the community the phone is set to back into the list: now that is Bellingen.
        const { getSavedNodes } = await import('../nodes');
        expect((await getSavedNodes()).map((n) => n.url)).toEqual([BELLINGEN]);
    });

    it('the confirmation names what stays and where the phone goes', async () => {
        await kimsPhone([{ url: BYRON, alias: 'Byron' }]);
        nodes({ [BELLINGEN]: 'member', [BYRON]: 'member' });

        const plan = await planDelete(kim.publicKey);
        if (plan.kind !== 'this-one') throw new Error(`expected this-one, got ${plan.kind}`);

        expect(keepsKeyLine(plan, true)).toBe(
            'Your key and 12 words stay on this phone, for Bellingen and Byron. Mullum goes from this phone\'s list, ' +
            'with its copy on this phone, and the app opens Bellingen.');
        expect(keepsKeyLine(plan, false)).toMatch(/^Your key stays on this phone, for Bellingen and Byron\./);
    });
});

describe('a community that could not be asked counts as one Kim is still in: a poor connection never costs the key', () => {
    for (const answer of ['down', 'refused', 'silent', 'not-json', 'odd'] as const) {
        it(`Bellingen ${answer}: the key stays and the phone moves there`, async () => {
            await kimsPhone();
            const sent = nodes({ [BELLINGEN]: answer });

            const plan = await planDelete(kim.publicKey, AsyncStorage, 50);
            expect(plan).toMatchObject({
                kind: 'this-one',
                keeps: [{ url: BELLINGEN, membership: 'unreachable' }],
                next: { url: BELLINGEN },
            });
            if (plan.kind !== 'this-one') return;
            expect(keepsKeyLine(plan, true)).toContain('Bellingen couldn\'t be reached, so it counts as a community you are still in.');

            expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'left' });
            expect(purges(sent)).toHaveLength(1);
            expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
            expect(mem.async.get(ANCHOR)).toBe(BELLINGEN);
        });
    }

    it('a community that said Kim is a member is where the phone goes, before one that couldn\'t be asked', async () => {
        await kimsPhone([{ url: BYRON, alias: 'Byron' }]);
        // Bellingen comes first in the list, but can't be asked; Byron says Kim is a member.
        nodes({ [BELLINGEN]: 'down', [BYRON]: 'member' });

        const plan = await planDelete(kim.publicKey);

        expect(plan).toMatchObject({
            kind: 'this-one',
            keeps: [{ url: BELLINGEN, membership: 'unreachable' }, { url: BYRON, membership: 'member' }],
            next: { url: BYRON },
        });
    });

    it('a recovering key is a member (the phone would need it to finish)', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ isMember: false, isRecovering: true }), { status: 200 }));
        expect(await membershipAt(BELLINGEN, kim.publicKey)).toBe('member');
    });
});

describe('Delete account at Kim\'s last community', () => {
    it('Bellingen says Kim is no member: the delete here, then the whole wipe as Sign Out does', async () => {
        await kimsPhone();
        const sent = nodes({ [BELLINGEN]: 'stranger' });

        const plan = await planDelete(kim.publicKey);
        expect(plan).toEqual({ kind: 'last', here: MULLUM, hereName: 'Mullum' });

        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'wiped' });

        expect(purges(sent).map((s) => s.url)).toEqual([`${MULLUM}/api/member/purge`]);
        // The key goes, and the saved communities with their cached copies, as account-leaves-phone.test.ts checks.
        expect(await loadIdentity()).toBeNull();
        // (The rest of the account's app storage, the community the phone is set to among it, goes through a `require`
        // no vi.mock reaches: wipe-identity-storage.test.ts checks that part.)
        expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
        expect(removeCommunityCaches).toHaveBeenCalledTimes(1);
        expect(mem.async.get('beanpool_light_palette')).toBe('sand');
        // The key was still on the phone when the purge went out.
        const purgeAt = vi.mocked(fetch).mock.invocationCallOrder[sent.indexOf(purges(sent)[0])];
        expect(purgeAt).toBeLessThan(vi.mocked(clearDB).mock.invocationCallOrder[0]);
    });

    it('Mullum is the only community saved: no other community is asked, and the delete wipes the phone', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }]));
        const sent = nodes({});

        const plan = await planDelete(kim.publicKey);

        expect(plan.kind).toBe('last');
        expect(probes(sent)).toEqual([]);
        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'wiped' });
        expect(await loadIdentity()).toBeNull();
    });

    it('the warning says the key and 12 words go, and to write the words down first', () => {
        const plan: DeletePlan = { kind: 'last', here: MULLUM, hereName: 'Mullum' };
        expect(lastCommunityLine(plan, true)).toBe(
            'Mullum is the last community on this phone where you are a member, so this phone\'s key and 12 words go ' +
            'too. Only go ahead if you have written your 12 words down: they are the way back into any other community ' +
            'you belong to.');
        expect(lastCommunityLine(plan, false)).toBe(
            'Mullum is the last community on this phone where you are a member, so this phone\'s key goes too.');
    });
});

describe('the node does not delete: nothing on the phone changes, and the screen says the key wasn\'t touched', () => {
    for (const purge of ['refused', 'down'] as const) {
        it(`the purge is ${purge}, with another community keeping the key`, async () => {
            await kimsPhone();
            const sent = nodes({ [BELLINGEN]: 'member' }, purge);
            const plan = await planDelete(kim.publicKey);

            const outcome = await deleteAccountHere(kim, plan);

            expect(outcome).toEqual({ kind: 'not-deleted', reason: purge === 'refused' ? ESCROW_REFUSAL : 'Network request failed' });
            expect(purges(sent)).toHaveLength(1);
            await untouched();
        });

        it(`the purge is ${purge}, at the last community: the key is not wiped`, async () => {
            await kimsPhone();
            const sent = nodes({ [BELLINGEN]: 'stranger' }, purge);
            const plan = await planDelete(kim.publicKey);
            expect(plan.kind).toBe('last');

            const outcome = await deleteAccountHere(kim, plan);

            expect(outcome.kind).toBe('not-deleted');
            expect(sent.filter((s) => s.method === 'DELETE')).toEqual([]);
            await untouched();
        });
    }

    it('the message says the key was not touched', () => {
        expect(deleteFailedLine(ESCROW_REFUSAL, true)).toBe(`${ESCROW_REFUSAL}\n\nThis phone's key and 12 words were not touched.`);
        expect(deleteFailedLine(ESCROW_REFUSAL, false)).toBe(`${ESCROW_REFUSAL}\n\nThis phone's key was not touched.`);
    });

    it('the phone was switched to another community after the plan: nothing is deleted anywhere', async () => {
        await kimsPhone();
        const sent = nodes({ [BELLINGEN]: 'member' });
        const plan = await planDelete(kim.publicKey);
        mem.async.set(ANCHOR, BELLINGEN);

        const outcome = await deleteAccountHere(kim, plan);

        expect(outcome.kind).toBe('not-deleted');
        expect(purges(sent)).toEqual([]);
        expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
    });
});

describe('which communities are asked', () => {
    it('only the saved ones other than this one, each once, only plain addresses; never a guest marker alone', async () => {
        await kimsPhone([
            { url: `${MULLUM}/` }, { url: `${BELLINGEN}/` }, { url: 'https://kim@evil.test' }, { url: 'not a url' },
        ]);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([
            ...JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY)!), null, { alias: 'no url' },
        ]));
        const sent = nodes({ [BELLINGEN]: 'stranger' });

        expect(await otherCommunitiesKeeping(MULLUM, kim.publicKey)).toEqual([]);
        // Byron is only a guest marker: never asked.
        expect(probes(sent)).toEqual([BELLINGEN]);
        expect(sent[0].url).toBe(`${BELLINGEN}/api/community/membership/${kim.publicKey}`);
    });

    it('a saved list that can\'t be read is no plan: nothing is deleted', async () => {
        await kimsPhone();
        const failing = { getItem: vi.fn(async (key: string) => { if (key === SAVED_NODES_STORE_KEY) throw new Error('disk'); return mem.async.get(key) ?? null; }) };

        await expect(planDelete(kim.publicKey, failing)).rejects.toThrow('disk');
        await expect(otherCommunitiesKeeping(MULLUM, kim.publicKey, failing)).rejects.toThrow('disk');
    });

    it('a phone set to no community has no plan', async () => {
        await importIdentity(kim);
        await expect(planDelete(kim.publicKey)).rejects.toThrow('This phone is not set to a community.');
    });
});

describe('leaving a community by itself', () => {
    it('a list, record or marker it is not on is left as it was', async () => {
        await kimsPhone();
        mem.async.delete(GUESTS);
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([BELLINGEN]));

        await leaveThisCommunity(MULLUM, BELLINGEN);

        expect(mem.async.has(GUESTS)).toBe(false);
        expect(JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY)!)).toEqual([BELLINGEN]);
        expect(savedUrls()).toEqual([BELLINGEN]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('a next community whose address isn\'t plain is refused before anything changes', async () => {
        await kimsPhone();

        await expect(leaveThisCommunity(MULLUM, 'https://bellingen.beanpool.org@evil.test')).rejects.toThrow();

        await untouched();
    });
});

describe('node-mismatch: why its delete is not offered', () => {
    it('says why', async () => {
        await kimsPhone([{ url: BYRON, alias: 'Byron' }]);
        nodes({ [BELLINGEN]: 'member', [BYRON]: 'down' });

        const keeping = await otherCommunitiesKeeping(MULLUM, kim.publicKey);

        expect(stillKeptLine(keeping)).toBe(
            'You are still a member of Bellingen. Byron couldn\'t be reached, so it counts as a community you are still ' +
            'in. Deleting this account from this phone would lose it there too, so this phone keeps it. Switch to one ' +
            'of them instead.');
    });
});
