/**
 * A phone waiting to be let in registers its push token with the communities it asked, so the yes buzzes it (web push W4,
 * scratch/fable-design/DESIGN-web-notifications-fable.md §3, Marty's Decision 4; utils/push-registrations.ts
 * `askedWhileWaiting`).
 *
 * Waiting mode (utils/waiting-to-join.ts, S3) is an account in no community: no community in use and no join wizard
 * part-way. Before W4 its token went nowhere, since a phone sends it only to the communities it keeps, so a yes reached it
 * only at its next Check again. Here:
 *
 *   - the waiting phone sends its token to each community the key asked and still waits on, signed by that key, with no
 *     membership question first (its answer would be no), and each goes on the record, so a leave reaches it too;
 *   - never to one it cancelled, one too old to be answered, or from another key's list; never on a phone with a
 *     community in use or a wizard part-way;
 *   - a community that refuses it (the server's 403 for a key with no open request there) leaves it due, and a refused
 *     or failed one lands at the next return once it is taken;
 *   - once the phone joins a community, the other communities it asked are no longer sent the token;
 *   - asking a community again after an earlier request there ended (cancelled, declined or lapsed: the community dropped
 *     the phone's row, while it stays on the phone's record) sends the token there again at Send, so that yes buzzes it
 *     too (#3160 review).
 *
 * Nothing contacts a node: fetch is a fake community per address (fake-communities.ts), here with the server's W4 rule
 * on. The phone's push token comes from a stub of Expo's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
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

import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { rememberKnock } from '../knock';
import { askedWhileWaiting, pushRegisteredCommunities, registerAccountForPush, registerAfterKnock, registerWhereMissing, retryDueRegistrations } from '../push-registrations';
import { Communities, PHONE_TOKEN } from './fake-communities';
import { KNOCKS_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY } from '../storage-keys';

const RIVERSIDE = 'https://riverside.example';
const HILLTOP = 'https://hilltop.example';
const BAYSIDE = 'https://bayside.example';
const ANCHOR = 'beanpool_anchor_url';
const WIZARD = 'beanpool_pending_onboarding';
const MINUTE = 60 * 1000;

async function phoneToken(): Promise<string> {
    mem.secure.set('beanpool_push_token', PHONE_TOKEN);
    return PHONE_TOKEN;
}

let kim: BeanPoolIdentity;
let nodes: Communities;

const pushPosts = () => nodes.sent.filter((s) => s.path === '/api/push-tokens' && s.method === 'POST');
const probes = () => nodes.sent.filter((s) => s.path.startsWith('/api/community/membership/'));
const due = () => JSON.parse(mem.async.get(PUSH_REGISTRATIONS_DUE_STORE_KEY) ?? '[]') as { community: string; refusals: number; retryAt: number }[];

/**
 * Kim's request at `community` ends as the server ends one: its open request goes, and with it the phone's row there
 * (routes/community.ts `dropAskerPhonesOf` on a cancel or a decline; the minute tidy-up on a lapse). On the phone, a
 * cancel marks the knock cancelled; a decline or a lapse never reaches it.
 */
function requestEnds(community: string, cancelledOnPhone: boolean): void {
    nodes.asked.get(community)?.delete(kim.publicKey);
    nodes.rowsAt(community).clear();
    if (!cancelledOnPhone) return;
    const stored = JSON.parse(mem.async.get(KNOCKS_STORE_KEY)!) as { pubkey: string; knocks: { url: string; cancelledAt?: string }[] };
    stored.knocks = stored.knocks.map((k) => (k.url === community ? { ...k, cancelledAt: new Date().toISOString() } : k));
    mem.async.set(KNOCKS_STORE_KEY, JSON.stringify(stored));
}

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
    await importIdentity(kim);
    nodes = new Communities();
    nodes.onlyMembersOrAsked = true;
    vi.useRealTimers();
});

describe('a phone waiting to be let in', () => {
    it('sends its token to each community it asked, signed by the asking key, with no membership question, and puts each on the record', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        await rememberKnock(kim.publicKey, { url: `${HILLTOP}/`, name: 'Hilltop' });
        nodes.ask(kim.publicKey, RIVERSIDE, HILLTOP);
        expect(await askedWhileWaiting(kim.publicKey)).toEqual(expect.arrayContaining([RIVERSIDE, HILLTOP]));

        expect(await registerAccountForPush(kim.publicKey, phoneToken, 'android')).toBe(PHONE_TOKEN);

        expect(pushPosts().map((s) => s.community).sort()).toEqual([HILLTOP, RIVERSIDE]);
        expect(pushPosts().every((s) => s.body.publicKey === kim.publicKey && s.headers['X-Public-Key'] === kim.publicKey)).toBe(true);
        expect(nodes.has(RIVERSIDE, kim.publicKey) && nodes.has(HILLTOP, kim.publicKey)).toBe(true);
        expect(probes()).toEqual([]);
        expect((await pushRegisteredCommunities()).sort()).toEqual([HILLTOP, RIVERSIDE]);
        expect(due()).toEqual([]);
    });

    it('never to a community it cancelled, one too old to be answered, or from another key\'s list', async () => {
        const old = new Date(Date.now() - 62 * 24 * 60 * MINUTE).toISOString(); // past core's 61 answerable days
        mem.async.set(KNOCKS_STORE_KEY, JSON.stringify({
            pubkey: kim.publicKey,
            knocks: [
                { url: RIVERSIDE, name: 'Riverside', key: null, sentAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
                { url: HILLTOP, name: 'Hilltop', key: null, sentAt: old },
                { url: BAYSIDE, name: 'Bayside', key: null, sentAt: new Date().toISOString() },
            ],
        }));
        expect(await askedWhileWaiting(kim.publicKey)).toEqual([BAYSIDE]);
        const ben = await draftIdentity('Ben');
        expect(await askedWhileWaiting(ben.publicKey)).toEqual([]);
    });

    it('never on a phone with a community in use, or with a join wizard part-way: those send only where the phone belongs', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        nodes.ask(kim.publicKey, RIVERSIDE);

        mem.async.set(WIZARD, JSON.stringify({ step: 'photo', node: BAYSIDE }));
        expect(await askedWhileWaiting(kim.publicKey)).toEqual([]);
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(pushPosts()).toEqual([]);
        mem.async.delete(WIZARD);

        mem.async.set(ANCHOR, BAYSIDE);
        nodes.join(kim.publicKey, BAYSIDE);
        expect(await askedWhileWaiting(kim.publicKey)).toEqual([]);
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(pushPosts().map((s) => s.community)).toEqual([BAYSIDE]);
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(false);
    });

    it('a community that refuses it (no open request there now) leaves it due; it lands at the next return once taken', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        // Riverside doesn't hold the request (yet): the server's 403 for a key with no open request there.
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(pushPosts().map((s) => s.community)).toEqual([RIVERSIDE]);
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(false);
        expect(due()).toEqual([expect.objectContaining({ community: RIVERSIDE, refusals: 1 })]);

        nodes.ask(kim.publicKey, RIVERSIDE);
        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify(due().map((d) => ({ ...d, retryAt: 0 }))));
        await retryDueRegistrations(phoneToken, 'android');
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
        expect(probes()).toEqual([]);
        expect(due()).toEqual([]);
    });

    it('a knock made after the token was asked for is caught by the next run (the screen\'s run after Send), with nothing asked', async () => {
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(pushPosts()).toEqual([]);
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        nodes.ask(kim.publicKey, RIVERSIDE);
        await registerWhereMissing(phoneToken, 'android');
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
        expect(probes()).toEqual([]);
    });

    it('once the phone joins one, the other communities it asked are no longer sent the token, and what was due there is dropped', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        await rememberKnock(kim.publicKey, { url: HILLTOP, name: 'Hilltop' });
        nodes.ask(kim.publicKey, RIVERSIDE);
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
        expect(due().map((d) => d.community)).toEqual([HILLTOP]);

        // Riverside said yes and the phone joined it: it is the community in use now.
        nodes.join(kim.publicKey, RIVERSIDE);
        mem.async.set(ANCHOR, RIVERSIDE);
        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify(due().map((d) => ({ ...d, retryAt: 0 }))));
        nodes.ask(kim.publicKey, HILLTOP);
        const before = pushPosts().length;
        await retryDueRegistrations(phoneToken, 'android');
        expect(pushPosts().slice(before).map((s) => s.community)).not.toContain(HILLTOP);
        expect(nodes.has(HILLTOP, kim.publicKey)).toBe(false);
        expect(due()).toEqual([]);
    });
});

describe('a phone waiting to be let in that asks a community again', () => {
    for (const ending of [
        { how: 'cancelled', cancelledOnPhone: true },
        { how: 'declined or lapsed', cancelledOnPhone: false },
    ]) {
        it(`after its earlier request there was ${ending.how}, sends the token there again at Send, so the yes buzzes it (fails before: no POST, no row)`, async () => {
            await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
            nodes.ask(kim.publicKey, RIVERSIDE);
            await registerAfterKnock(RIVERSIDE, phoneToken, 'android');
            expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
            expect(await pushRegisteredCommunities()).toEqual([RIVERSIDE]);

            requestEnds(RIVERSIDE, ending.cancelledOnPhone);
            expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(false);
            // Riverside is still on the phone's record: only a leave takes it off.
            expect(await pushRegisteredCommunities()).toEqual([RIVERSIDE]);

            // Asked again (after the block), with the app resumed, not started: the screen's run after Send.
            await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
            nodes.ask(kim.publicKey, RIVERSIDE);
            const before = pushPosts().length;
            await registerAfterKnock(RIVERSIDE, phoneToken, 'android');

            expect(pushPosts().slice(before).map((s) => s.community)).toEqual([RIVERSIDE]);
            expect(pushPosts().slice(before).every((s) => s.body.publicKey === kim.publicKey && s.headers['X-Public-Key'] === kim.publicKey)).toBe(true);
            expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
            expect(probes()).toEqual([]);
            expect(await pushRegisteredCommunities()).toEqual([RIVERSIDE]);
            expect(due()).toEqual([]);
        });
    }

    it('a wait left by an earlier refusal there is dropped: the new request is held there now, and the token lands at once', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        // Riverside doesn't hold the request: refused, and left alone a while.
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(due()).toEqual([expect.objectContaining({ community: RIVERSIDE, refusals: 1 })]);
        expect(due()[0].retryAt).toBeGreaterThan(Date.now());

        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        nodes.ask(kim.publicKey, RIVERSIDE);
        await registerAfterKnock(RIVERSIDE, phoneToken, 'android');
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(true);
        expect(due()).toEqual([]);
    });

    it('a second Send while the first one\'s registration still stands adds no row there', async () => {
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        nodes.ask(kim.publicKey, RIVERSIDE);
        await registerAfterKnock(RIVERSIDE, phoneToken, 'android');
        await registerAfterKnock(RIVERSIDE, phoneToken, 'android');
        expect(pushPosts().map((s) => s.community)).toEqual([RIVERSIDE, RIVERSIDE]);
        expect([...nodes.rowsAt(RIVERSIDE).keys()]).toEqual([`${kim.publicKey}|${PHONE_TOKEN}`]);
        expect(due()).toEqual([]);
    });

    it('never on a phone with a community in use: a member\'s ask sends its token only where it belongs', async () => {
        mem.async.set(ANCHOR, BAYSIDE);
        nodes.join(kim.publicKey, BAYSIDE);
        await rememberKnock(kim.publicKey, { url: RIVERSIDE, name: 'Riverside' });
        nodes.ask(kim.publicKey, RIVERSIDE);
        await registerAfterKnock(RIVERSIDE, phoneToken, 'android');
        expect(pushPosts().map((s) => s.community)).not.toContain(RIVERSIDE);
        expect(nodes.has(RIVERSIDE, kim.publicKey)).toBe(false);
        expect(due().map((d) => d.community)).not.toContain(RIVERSIDE);
    });
});
