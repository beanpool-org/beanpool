/**
 * The full-screen "Update required"'s ways out depend on nothing the community that raised it answers
 * (utils/update-block-escape.ts; #1415's re-review, BLOCKING).
 *
 * The re-review: a community that answered the membership probe `isMember: false` turned "See my 12 words" and "Leave
 * this community" into no-ops, because both went through Settings, which the layout's 'stranger' guard replaced with
 * node-mismatch, which the block covers. Now both are done inside the block, on the phone. Here the community that
 * raised the block is played by an attacker who controls its server completely: it never answers, answers with an
 * error, a lie or a captive portal's page, or says the key is no member. In every case:
 * - the plan is read from the phone alone, and nothing asks any community who is a member;
 * - with another community on the phone, this one leaves it, the phone moves on, the key and 12 words stay, and the
 *   update screen hears the switch; the community is told only in passing (its push alerts), never waited on, and if
 *   it never confirms it goes back on the push record so a later Sign Out asks it again;
 * - as the last, the account leaves the phone as Sign Out takes it, within Sign Out's own bounded wait.
 *
 * Nothing here contacts a node: fetch is a stub that plays the community and records what would have been sent.
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
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
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
    initDB: vi.fn(async () => { mem.anchorAtInit.push(mem.async.get('beanpool_anchor_url')); }),
}));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import { removeCommunityCaches } from '../community-cache';
import { onCommunitySwitched } from '../community-switch';
import { initDB } from '../db';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { stopPushAlertsAt, UNREGISTER_TIMEOUT_MS } from '../account-leaves-phone';
import { leaveFromUpdateBlock, planLeaveFromUpdateBlock } from '../update-block-escape';
import { checkCommunityForUpdate } from '../force-update';
import { boundSignatureValid } from './server-signature-check';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }

/** How the hostile community answers everything. */
type Hostile = 'hangs' | 'down' | 'error' | 'lies' | 'portal' | 'not-a-member' | 'confirms';

/** Mullum is the attacker's; nothing else may be contacted. */
function mullumIs(how: Hostile): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        sent.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
        if (new URL(url).origin !== MULLUM) throw new Error(`No other community may be contacted: ${method} ${url}`);
        switch (how) {
            case 'hangs':
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });
            case 'down': throw new TypeError('Network request failed');
            case 'error': return new Response('{"error":"no"}', { status: 500 });
            case 'lies': return new Response(JSON.stringify({ success: false, isMember: false, appFloors: { android: { min: '9.9.9', blocking: true } } }), { status: 200 });
            case 'portal': return new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 });
            case 'not-a-member': return new Response(JSON.stringify({ isMember: false, callsign: null }), { status: 200 });
            case 'confirms': return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
    });
    return sent;
}

const savedUrls = () => JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string }) => n.url);
const record = () => JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

let kim: BeanPoolIdentity;
let switches = 0;
let stopListening: () => void = () => {};

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    mem.anchorAtInit.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
    switches = 0;
    stopListening = onCommunitySwitched(() => { switches++; });
});

afterEach(() => {
    stopListening();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim's phone: set to Mullum (the attacker's); Bellingen saved too unless `alone`; a push token sent to both. */
async function kimsPhone(alone = false) {
    await importIdentity(kim);
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([
        { url: MULLUM, alias: 'Mullum' }, ...(alone ? [] : [{ url: BELLINGEN, alias: 'Bellingen' }]),
    ]));
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify(alone ? [MULLUM] : [MULLUM, BELLINGEN]));
}

describe('the plan: read from the phone alone', () => {
    it('the community left, its name as saved, and the next one on the phone; nothing is asked of any community', async () => {
        await kimsPhone();
        const sent = mullumIs('not-a-member');
        expect(await planLeaveFromUpdateBlock()).toEqual({ here: MULLUM, hereName: 'Mullum', next: { url: BELLINGEN, name: 'Bellingen' } });
        expect(sent).toEqual([]);
    });

    it('the last community on the phone: no next', async () => {
        await kimsPhone(true);
        expect((await planLeaveFromUpdateBlock()).next).toBeNull();
    });

    it('a phone set to no community has no plan', async () => {
        await importIdentity(kim);
        await expect(planLeaveFromUpdateBlock()).rejects.toThrow('This phone is not set to a community.');
    });
});

describe('Leave this community, with another community on the phone, whatever the community left does', () => {
    for (const how of ['hangs', 'down', 'error', 'lies', 'portal', 'not-a-member', 'confirms'] as const) {
        it(`Mullum ${how}: Mullum leaves the phone, the phone is on Bellingen, the key and 12 words stay`, async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await kimsPhone();
            const sent = mullumIs(how);
            const plan = await planLeaveFromUpdateBlock();

            const left = await leaveFromUpdateBlock(kim, plan);

            // Done before the community has had to answer anything.
            expect(left).toEqual({ kind: 'moved', to: { url: BELLINGEN, name: 'Bellingen' } });
            expect(mem.async.get(ANCHOR)).toBe(BELLINGEN);
            expect(savedUrls()).toEqual([BELLINGEN]);
            expect(removeCommunityCaches).toHaveBeenCalledWith([MULLUM]);
            expect(mem.anchorAtInit).toEqual([BELLINGEN]);
            expect(switches).toBe(1);
            const onPhone = await loadIdentity();
            expect(onPhone?.publicKey).toBe(kim.publicKey);
            expect(onPhone?.mnemonic).toEqual(kim.mnemonic);

            // The one request: Mullum asked, signed by Kim, to drop this phone's token. Never a membership question.
            await settle();
            await vi.advanceTimersByTimeAsync(UNREGISTER_TIMEOUT_MS + 100);
            await settle();
            expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`DELETE ${MULLUM}/api/push-tokens`]);
            expect(boundSignatureValid(sent[0], kim.publicKey)).toBe(true);
            expect(JSON.parse(sent[0].body)).toEqual({ publicKey: kim.publicKey, token: PHONE_TOKEN });

            // Confirmed: off the record. Anything else: back on it, so a later Sign Out asks Mullum again.
            expect(record()).toEqual(how === 'confirms' ? [BELLINGEN] : [BELLINGEN, MULLUM]);
        });
    }

    it('the phone moved since the plan: nothing is done', async () => {
        await kimsPhone();
        const plan = await planLeaveFromUpdateBlock();
        mem.async.set(ANCHOR, BELLINGEN);
        await expect(leaveFromUpdateBlock(kim, plan)).rejects.toThrow('This phone changed community.');
        expect(savedUrls()).toEqual([MULLUM, BELLINGEN]);
        expect(initDB).not.toHaveBeenCalled();
        expect(switches).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('Leave this community as the last one on the phone', () => {
    for (const how of ['hangs', 'down', 'not-a-member', 'confirms'] as const) {
        it(`Mullum ${how}: the account leaves the phone as Sign Out takes it, within Sign Out's bounded wait`, async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await kimsPhone(true);
            mullumIs(how);
            const plan = await planLeaveFromUpdateBlock();

            let done: unknown = null;
            const leaving = leaveFromUpdateBlock(kim, plan).then((r) => { done = r; });
            await settle();
            await vi.advanceTimersByTimeAsync(UNREGISTER_TIMEOUT_MS + 100);
            await settle();
            await leaving;

            expect(done).toEqual({ kind: 'signed-out' });
            expect(await loadIdentity()).toBeNull();
            // Its communities go from the list (the rest of its app storage goes through identity.ts's `require`, which
            // no vi.mock reaches: account-leaves-phone.test.ts and wipe-identity-storage.test.ts cover it).
            expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
            expect(switches).toBeGreaterThanOrEqual(1);
        });
    }
});

describe('Leave this community with no account on the phone (a join never finished)', () => {
    it('the last community: it comes off the phone, which is on none, and the block has nothing to hold; nothing is sent', async () => {
        mem.async.set(ANCHOR, MULLUM);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }]));
        mem.async.set('beanpool_guest_nodes', JSON.stringify([MULLUM, BELLINGEN]));
        mullumIs('hangs');
        const plan = await planLeaveFromUpdateBlock();
        expect(await leaveFromUpdateBlock(null, plan)).toEqual({ kind: 'forgotten' });
        expect(mem.async.has(ANCHOR)).toBe(false);
        expect(savedUrls()).toEqual([]);
        expect(JSON.parse(mem.async.get('beanpool_guest_nodes')!)).toEqual([BELLINGEN]);
        expect(removeCommunityCaches).toHaveBeenCalledWith([MULLUM]);
        expect(switches).toBe(1);
        expect(fetch).not.toHaveBeenCalled();
        // With no community, the gate's answer is clear: a block still up comes down.
        expect(await checkCommunityForUpdate({
            anchorUrl: async () => mem.async.get(ANCHOR) ?? null, fetchJson: vi.fn(), localVersion: '1.2.57', platform: 'android',
        })).toEqual({ kind: 'clear' });
    });

    it('with another community: the phone moves there; no push token to stop, so nothing is sent', async () => {
        mem.async.set(ANCHOR, MULLUM);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BELLINGEN, alias: 'Bellingen' }]));
        mullumIs('hangs');
        const plan = await planLeaveFromUpdateBlock();
        expect(await leaveFromUpdateBlock(null, plan)).toEqual({ kind: 'moved', to: { url: BELLINGEN, name: 'Bellingen' } });
        expect(mem.async.get(ANCHOR)).toBe(BELLINGEN);
        await settle();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('stopPushAlertsAt: one community, best effort', () => {
    it('a phone with no push token sends nothing, and there is nothing left to stop', async () => {
        await kimsPhone();
        mem.secure.delete(PUSH_TOKEN_STORE_KEY);
        expect(await stopPushAlertsAt(kim, MULLUM)).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('true only on the route\'s own confirmation', async () => {
        await kimsPhone();
        mullumIs('portal');
        expect(await stopPushAlertsAt(kim, MULLUM)).toBe(false);
        mullumIs('confirms');
        expect(await stopPushAlertsAt(kim, MULLUM)).toBe(true);
    });
});

describe('the attacker\'s answers, end to end', () => {
    it('a block it raises with a fake store version is one its members can still leave, without it answering anything', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await kimsPhone();
        // The block: any floor, and the same answer's store version to match.
        const blocked = await checkCommunityForUpdate({
            anchorUrl: async () => mem.async.get(ANCHOR) ?? null,
            fetchJson: async () => ({ appFloors: { android: { min: '9.9.9', blocking: true } }, appVersions: { android: '9.9.9' } }),
            localVersion: '1.2.57',
            platform: 'android',
        });
        expect(blocked).toEqual({ kind: 'block', version: '9.9.9' });
        // Then it goes silent on everything, and says Kim is no member.
        const sent = mullumIs('hangs');
        const plan = await planLeaveFromUpdateBlock();
        expect(await leaveFromUpdateBlock(kim, plan)).toEqual({ kind: 'moved', to: { url: BELLINGEN, name: 'Bellingen' } });
        // Now set to Bellingen: no answer of Mullum's can be about the phone's community any more.
        expect(await checkCommunityForUpdate({
            anchorUrl: async () => mem.async.get(ANCHOR) ?? null,
            fetchJson: async (url) => { expect(url.startsWith(BELLINGEN)).toBe(true); return {}; },
            localVersion: '1.2.57',
            platform: 'android',
        })).toEqual({ kind: 'clear' });
        expect(sent.every((s) => !s.url.includes('/membership/'))).toBe(true);
    });
});
