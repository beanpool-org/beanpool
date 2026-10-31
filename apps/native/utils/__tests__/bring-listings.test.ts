/**
 * Bring my listings (utils/bring-listings.ts, DESIGN-global-lounge-fable.md slice L7): when the offer is made, what a run
 * reads, what it sends, what it says, and what is kept for later. Both communities are fakes here;
 * bring-listings-e2e.test.ts runs the same code against two real nodes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: vi.fn() } }));
const profiles = vi.hoisted(() => new Map<string, string>());
vi.mock('../node-profile', () => ({
    GLOBAL_NODE_URL: 'https://global.beanpool.org',
    getCachedNodeProfile: vi.fn(async (url: string) => (profiles.has(url) ? { profile: profiles.get(url), features: {} } : null)),
}));
vi.mock('../node-post', () => ({ signedGet: vi.fn(), signedPost: vi.fn() }));

import {
    BRING_ASK_AGAIN_MS, BRING_MOST_TRIES, BRING_OFFER_KEEP_MS, BRING_WORDS, acceptBringOffer, bringLineWords, broughtId, closeBringOffer,
    noteBringOffer, pendingBringOffer, planBring, putOffBringOffer, runBring, settleBringOffer,
    type BringDeps, type BringOffer, type BringPlan, type OwnListing,
} from '../bring-listings';
import { fetchedPostPhoto } from '../post-photo';
import { BRING_LISTINGS_STORE_KEY } from '../storage-keys';
import type { BeanPoolIdentity } from '../identity';

const GLOBAL = 'https://global.beanpool.org';
const LOCAL = 'https://mullum.example.org';
const ME = 'ab'.repeat(32);
const identity = { publicKey: ME, privateKey: 'cd'.repeat(32), callsign: 'Robin' } as BeanPoolIdentity;
const OFFER: BringOffer = { publicKey: ME, from: GLOBAL, to: LOCAL, name: 'Mullumbimby', at: 1_000 };
const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';

const photoUrl = (id: string, n: number) => `/api/marketplace/posts/${id}/photos/${n}?v=1`;
function listing(id: string, over: Partial<OwnListing> = {}): OwnListing {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: `About ${id}`, credits: 0, priceType: 'fixed',
        authorPublicKey: ME, createdAt: '2026-10-01T00:00:00.000Z', active: true, status: 'active', lat: -28.5, lng: 153.5,
        photos: [photoUrl(id, 0)], audienceScope: 'public', ...over,
    };
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return {
        ok: status >= 200 && status < 300, status, json: async () => body,
        headers: { get: (name: string) => headers[name] ?? null },
    } as unknown as Response;
}

/** Two fake communities. `sends` answers each POST (default: taken). */
function fakes(global: OwnListing[], local: OwnListing[] = [], sends?: (body: any, n: number) => Response | Promise<Response>) {
    const posted: any[] = [];
    const reads: string[] = [];
    const deps: BringDeps = {
        get: vi.fn(async (url: string, path: string) => {
            reads.push(`${url}${path}`);
            return answer(200, url === GLOBAL ? global : local);
        }),
        post: vi.fn(async (_url: string, _path: string, body: any) => {
            const res = await (sends?.(body, posted.length) ?? answer(200, { success: true, post: { id: body.id } }));
            if (res.ok) posted.push(body);
            return res;
        }),
        fetchPhoto: vi.fn(async () => ({ photo: PHOTO })),
        healProfile: vi.fn(async () => false),
    };
    return { deps, posted, reads };
}

beforeEach(() => {
    mem.clear();
    profiles.clear();
});

describe('the offer', () => {
    const join = (over: Partial<Parameters<typeof noteBringOffer>[0]> = {}) =>
        noteBringOffer({ publicKey: ME, from: GLOBAL, to: LOCAL, name: 'Mullumbimby', alreadyMember: false, now: 1_000, ...over });

    it('is noted at the first join of a local community from the global one, and shown only on that community', async () => {
        expect(await join()).toBe(true);
        expect(await pendingBringOffer(ME, GLOBAL, 2_000)).toBeNull();
        expect(await pendingBringOffer(ME, `${LOCAL}/`, 2_000)).toMatchObject({ from: GLOBAL, to: LOCAL, name: 'Mullumbimby' });
    });

    it('goes by what the node says it is, so a global community on any address counts', async () => {
        profiles.set('https://lounge.example', 'global');
        expect(await join({ from: 'https://lounge.example' })).toBe(true);
    });

    it('is not made for a rejoin, from a local community, to a global one, with nowhere it came from, or a second time', async () => {
        expect(await join({ alreadyMember: true })).toBe(false);
        expect(await join({ from: 'https://castlemaine.example.org' })).toBe(false);
        expect(await join({ from: null })).toBe(false);
        expect(await join({ to: GLOBAL })).toBe(false);
        expect(await join({ from: LOCAL })).toBe(false);
        expect(mem.size).toBe(0);
        expect(await join()).toBe(true);
        expect(await join({ to: 'https://another.example.org' })).toBe(false);
        await closeBringOffer(ME);
        expect(await join({ to: 'https://another.example.org' })).toBe(false);
    });

    it('never goes to another key on the same phone, and that key can have its own', async () => {
        await join();
        expect(await pendingBringOffer('ef'.repeat(32), LOCAL, 2_000)).toBeNull();
        expect(await join({ publicKey: 'ef'.repeat(32) })).toBe(true);
    });

    it('"Not now" holds it a day and asks once more, then never', async () => {
        await join();
        const first = (await pendingBringOffer(ME, LOCAL, 2_000))!;
        await putOffBringOffer(first, 2_000);
        expect(await pendingBringOffer(ME, LOCAL, 2_000 + BRING_ASK_AGAIN_MS - 1)).toBeNull();
        const second = (await pendingBringOffer(ME, LOCAL, 2_000 + BRING_ASK_AGAIN_MS))!;
        expect(second).not.toBeNull();
        await putOffBringOffer(second, 3_000 + BRING_ASK_AGAIN_MS);
        expect(await pendingBringOffer(ME, LOCAL, 3_000 + 10 * BRING_ASK_AGAIN_MS)).toBeNull();
    });

    it('lapses after 30 days, unasked', async () => {
        await join();
        expect(await pendingBringOffer(ME, LOCAL, 1_000 + BRING_OFFER_KEEP_MS)).not.toBeNull();
        expect(await pendingBringOffer(ME, LOCAL, 1_001 + BRING_OFFER_KEEP_MS)).toBeNull();
        expect(await join({ to: 'https://another.example.org' })).toBe(false);
    });

    it('a yes outlives the phone: read back as accepted, so a later run asks nothing', async () => {
        await join();
        await acceptBringOffer((await pendingBringOffer(ME, LOCAL, 2_000))!);
        expect(JSON.parse(mem.get(BRING_LISTINGS_STORE_KEY)!).accepted).toBe(true);
        expect((await pendingBringOffer(ME, LOCAL, 2_000))?.accepted).toBe(true);
    });
});

describe('what a run reads', () => {
    it('reads the member\'s own listings in every state from both communities, signed, by page', async () => {
        const deps = fakes([]).deps;
        deps.get = vi.fn(async (url: string, path: string) => {
            if (url !== GLOBAL) return answer(200, []);
            return path.includes('pageAfter=key') ? answer(200, [listing('b')]) : answer(200, [listing('a')], { 'X-Posts-Next': 'key' });
        });
        const plan = await planBring(OFFER, identity, deps) as BringPlan;
        expect(plan.bring.map((p) => p.id).sort()).toEqual(['a', 'b']);
        expect(vi.mocked(deps.get).mock.calls[0][1]).toBe(`/api/marketplace/posts?author=${ME}&types=offer,need&sync=true&paged=1&limit=200`);
    });

    it('Offers go before Needs, each oldest first: a community with Beans takes a Need only from a member with an Offer', async () => {
        const { deps } = fakes([
            listing('n1', { type: 'need', createdAt: '2026-09-01T00:00:00.000Z' }),
            listing('o2', { createdAt: '2026-10-02T00:00:00.000Z' }),
            listing('o1', { createdAt: '2026-10-01T00:00:00.000Z' }),
        ]);
        expect((await planBring(OFFER, identity, deps) as BringPlan).bring.map((p) => p.id)).toEqual(['o1', 'o2', 'n1']);
    });

    it('a listing already archived (off, its photos deleted) stays behind with a line, and so does one hidden after reports', async () => {
        const { deps } = fakes([
            listing('up'),
            listing('old', { title: 'Old bike', status: 'cancelled', active: false, photos: [] }),
            listing('hid', { title: 'Reported', hiddenByReportsAt: '2026-10-20T00:00:00.000Z' }),
        ]);
        const plan = await planBring(OFFER, identity, deps) as BringPlan;
        expect(plan.bring.map((p) => p.id)).toEqual(['up']);
        expect(plan.gone).toEqual(['Old bike', 'Reported']);
        const result = await runBring(OFFER, plan, identity, undefined, deps);
        expect(result.lines.map((l) => bringLineWords(l, 'Mullumbimby'))).toEqual([
            '"Old bike" is no longer up on the global community, so it stayed behind.',
            '"Reported" is no longer up on the global community, so it stayed behind.',
        ]);
    });

    it('what the member took down, paused or finished stays behind and says nothing', async () => {
        const { deps } = fakes([
            listing('removed', { status: 'cancelled', active: false }),
            listing('paused', { status: 'paused' }),
            listing('done', { status: 'completed', active: false }),
        ]);
        expect(await planBring(OFFER, identity, deps)).toEqual({ bring: [], gone: [] });
    });

    it('only the member\'s own, for everyone, written here', async () => {
        const { deps } = fakes([
            listing('group', { audienceScope: 'group' }),
            listing('direct', { audienceScope: 'direct' }),
            listing('other', { authorPublicKey: 'ef'.repeat(32) }),
            listing('copy', { originNode: 'https://elsewhere.example' }),
            listing('poll', { type: 'poll' as OwnListing['type'] }),
        ]);
        expect(await planBring(OFFER, identity, deps)).toEqual({ bring: [], gone: [] });
    });

    it('a community that gives no answer keeps the offer; a global community that refuses this key has nothing to bring', async () => {
        const down = fakes([]).deps;
        down.get = vi.fn(async () => { throw new TypeError('Network request failed'); });
        expect(await planBring(OFFER, identity, down)).toBe('unreachable');
        const busy = fakes([]).deps;
        busy.get = vi.fn(async () => answer(503, {}));
        expect(await planBring(OFFER, identity, busy)).toBe('unreachable');
        const localDown = fakes([]).deps;
        localDown.get = vi.fn(async (url: string) => (url === GLOBAL ? answer(200, []) : answer(503, {})));
        expect(await planBring(OFFER, identity, localDown)).toBe('unreachable');
        const gone = fakes([]).deps;
        gone.get = vi.fn(async () => answer(403, { code: 'members_only' }));
        expect(await planBring(OFFER, identity, gone)).toBe('nothing');
    });

    it('a captive portal\'s page is no list of listings', async () => {
        const { deps } = fakes([]);
        deps.get = vi.fn(async () => answer(200, '<html>'));
        expect(await planBring(OFFER, identity, deps)).toBe('unreachable');
    });
});

describe('what a run sends', () => {
    it('an ordinary post by the same key: the listing\'s words, place and photos, with an id of its own', async () => {
        const post = listing('a', { title: 'Tomato seedlings', description: 'Six trays', repeatable: true, cashAlsoNeeded: true, photos: [photoUrl('a', 0), photoUrl('a', 1)] });
        const { deps, posted } = fakes([]);
        const result = await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(result).toEqual({ brought: 1, lines: [], kept: false, held: false });
        expect(posted).toEqual([{
            id: broughtId('a', LOCAL), type: 'offer', category: 'food', title: 'Tomato seedlings', description: 'Six trays', credits: 0, priceType: 'fixed',
            authorPublicKey: ME, lat: -28.5, lng: 153.5, photos: [PHOTO, PHOTO], repeatable: true, cashAlsoNeeded: true,
        }]);
        expect(vi.mocked(deps.post).mock.calls[0].slice(0, 2)).toEqual([LOCAL, '/api/marketplace/posts']);
        expect(vi.mocked(deps.fetchPhoto).mock.calls.map((c) => c[0])).toEqual([`${GLOBAL}${photoUrl('a', 0)}`, `${GLOBAL}${photoUrl('a', 1)}`]);
    });

    it('a lent Offer keeps its terms', async () => {
        const post = listing('a', { lendable: true, lendMaxDays: 7, lendTerms: 'Clean it', replacementValue: 'A new one', priceType: 'daily' });
        const { deps, posted } = fakes([]);
        await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(posted[0]).toMatchObject({ lendable: true, lendMaxDays: 7, lendTerms: 'Clean it', replacementValue: 'A new one', priceType: 'daily' });
    });

    it('at most five photos, whatever the row says', async () => {
        const post = listing('a', { photos: [0, 1, 2, 3, 4, 5, 6].map((n) => photoUrl('a', n)) });
        const { deps, posted } = fakes([]);
        await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(posted[0].photos).toHaveLength(5);
        expect(deps.fetchPhoto).toHaveBeenCalledTimes(5);
    });

    it('a body stays inside the 2 MB a node reads: a listing built up by edits comes with the photos that fit, and says so', async () => {
        const big = `data:image/jpeg;base64,/9j/${'A'.repeat(800_000)}`;
        const post = listing('a', { title: 'Big', photos: [0, 1, 2].map((n) => photoUrl('a', n)) });
        const { deps, posted } = fakes([]);
        deps.fetchPhoto = vi.fn(async () => ({ photo: big }));
        const result = await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(posted[0].photos).toHaveLength(2);
        expect(JSON.stringify(posted[0]).length).toBeLessThan(2 * 1024 * 1024);
        expect(result.lines).toEqual([{ kind: 'fewer-photos', title: 'Big' }]);
    });

    it('fetches only this community\'s own listing-photo addresses', async () => {
        const post = listing('a', { title: 'Odd', photos: ['https://elsewhere.example/x.jpg', '//elsewhere.example/x.jpg', 'data:image/png;base64,AAAA', '/api/avatar/ab', photoUrl('a', 0)] });
        const { deps, posted } = fakes([]);
        const result = await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(vi.mocked(deps.fetchPhoto).mock.calls.map((c) => c[0])).toEqual([`${GLOBAL}${photoUrl('a', 0)}`]);
        expect(posted[0].photos).toEqual([PHOTO]);
        expect(result.lines).toEqual([{ kind: 'fewer-photos', title: 'Odd' }]);
    });

    it('the same listing has the same id each run, and another on another community', () => {
        expect(broughtId('a', LOCAL)).toBe(broughtId('a', LOCAL));
        expect(broughtId('a', LOCAL)).not.toBe(broughtId('a', 'https://another.example.org'));
        expect(broughtId('a', LOCAL)).not.toBe(broughtId('b', LOCAL));
        expect(broughtId('a', LOCAL)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('says how far it has got', async () => {
        const { deps } = fakes([]);
        const steps: number[] = [];
        await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, (done) => steps.push(done), deps);
        expect(steps).toEqual([0, 1, 2]);
    });
});

describe('a photo that fails to fetch', () => {
    const refusesNoPhoto = (body: any) => (body.photos.length === 0 ? answer(400, { error: 'Add a photo first' }) : answer(200, { success: true }));

    it('is reported, and the listing comes with the photos it has', async () => {
        const post = listing('a', { title: 'Seedlings', photos: [photoUrl('a', 0), photoUrl('a', 1)] });
        const { deps, posted } = fakes([]);
        deps.fetchPhoto = vi.fn().mockResolvedValueOnce({ failed: 'gone' }).mockResolvedValueOnce({ photo: PHOTO });
        const result = await runBring(OFFER, { bring: [post], gone: [] }, identity, undefined, deps);
        expect(posted[0].photos).toEqual([PHOTO]);
        expect(result).toMatchObject({ brought: 1, kept: false });
        expect(bringLineWords(result.lines[0], 'Mullumbimby')).toBe('"Seedlings" came across without some of its photos: they could not be fetched.');
    });

    it('with none left, the node\'s rule decides: a node that wants a photo leaves it behind, and it is said', async () => {
        const { deps, posted } = fakes([], [], refusesNoPhoto);
        deps.fetchPhoto = vi.fn(async () => ({ failed: 'gone' as const }));
        const result = await runBring(OFFER, { bring: [listing('a', { title: 'Seedlings' })], gone: [] }, identity, undefined, deps);
        expect(deps.post).toHaveBeenCalledTimes(1);
        expect(posted).toEqual([]);
        expect(result).toMatchObject({ brought: 0, kept: false });
        expect(bringLineWords(result.lines[0], 'Mullumbimby')).toBe('"Seedlings" stayed behind: its photos could not be fetched, and Mullumbimby needs at least one.');
    });

    it('with none left, a node that allows it takes the listing, and the failure is still reported', async () => {
        const { deps, posted } = fakes([]);
        deps.fetchPhoto = vi.fn(async () => ({ failed: 'gone' as const }));
        const result = await runBring(OFFER, { bring: [listing('a', { title: 'Seedlings' })], gone: [] }, identity, undefined, deps);
        expect(posted[0].photos).toEqual([]);
        expect(result.lines).toEqual([{ kind: 'fewer-photos', title: 'Seedlings' }]);
    });

    it('a listing that never had a photo is the node\'s to answer too, in words of its own', async () => {
        const { deps } = fakes([], [], refusesNoPhoto);
        const result = await runBring(OFFER, { bring: [listing('a', { title: 'Old need', photos: [] })], gone: [] }, identity, undefined, deps);
        expect(bringLineWords(result.lines[0], 'Mullumbimby')).toBe('"Old need" stayed behind: it has no photo, and Mullumbimby needs at least one.');
        expect(deps.fetchPhoto).not.toHaveBeenCalled();
    });

    it('one that might yet come waits for a later run, and the rest still go', async () => {
        const { deps, posted } = fakes([]);
        deps.fetchPhoto = vi.fn().mockResolvedValueOnce({ failed: 'later' }).mockResolvedValueOnce({ photo: PHOTO });
        const result = await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, undefined, deps);
        expect(posted.map((p) => p.id)).toEqual([broughtId('b', LOCAL)]);
        expect(result).toMatchObject({ brought: 1, kept: true });
    });

    it('on the last try it stops waiting: the node\'s rule answers, so a lost photo can\'t hold the offer open for ever', async () => {
        const { deps } = fakes([], [], refusesNoPhoto);
        deps.fetchPhoto = vi.fn(async () => ({ failed: 'later' as const }));
        const result = await runBring({ ...OFFER, tries: BRING_MOST_TRIES - 1 }, { bring: [listing('a', { title: 'Seedlings' })], gone: [] }, identity, undefined, deps);
        expect(result).toMatchObject({ brought: 0, kept: false, lines: [{ kind: 'photos-failed', title: 'Seedlings' }] });
    });
});

describe('what the new community answers', () => {
    it('its refusal is a line in its own words, and the rest still go', async () => {
        const { deps, posted } = fakes([], [], (body) => (body.title === 'Listing a' ? answer(400, { error: 'Please offer something first.' }) : answer(200, { success: true })));
        const result = await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, undefined, deps);
        expect(posted).toHaveLength(1);
        expect(result.brought).toBe(1);
        expect(bringLineWords(result.lines[0], 'Mullumbimby')).toBe('"Listing a" stayed behind: Please offer something first.');
    });

    it.each([
        ['no answer', () => { throw new TypeError('Network request failed'); }],
        ['its server failing', () => answer(503, {})],
        ['too many posts today', () => answer(429, { error: 'Slow down' })],
        ['a signature it can\'t read yet', () => answer(401, {})],
        ['a page that is not its answer', () => answer(200, '<html>')],
    ])('%s: stops, and keeps the offer', async (_what, sends) => {
        const { deps } = fakes([], [], sends as any);
        const result = await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, undefined, deps);
        expect(result).toMatchObject({ brought: 0, kept: true });
        expect(deps.post).toHaveBeenCalledTimes(1);
    });

    it('a run again posts nothing twice, a post whose answer was lost included', async () => {
        const local: OwnListing[] = [];
        const rows = [listing('a'), listing('b'), listing('c')];
        const { deps, posted } = fakes(rows, local, (body, n) => {
            local.push(listing(body.id));
            if (n === 1) throw new TypeError('the answer never came');
            return answer(200, { success: true });
        });
        const first = await runBring(OFFER, await planBring(OFFER, identity, deps) as BringPlan, identity, undefined, deps);
        expect(first).toMatchObject({ brought: 1, kept: true });
        expect(local).toHaveLength(2);
        const again = await planBring(OFFER, identity, deps) as BringPlan;
        expect(again.bring.map((p) => p.id)).toEqual(['c']);
        await runBring({ ...OFFER, tries: 1 }, again, identity, undefined, deps);
        expect(local.map((p) => p.id)).toEqual(['a', 'b', 'c'].map((id) => broughtId(id, LOCAL)));
        expect(new Set(local.map((p) => p.id)).size).toBe(3);
        expect(posted).toHaveLength(2);
    });

    it('wants a profile photo: the phone sends the one it holds and asks again', async () => {
        let healed = false;
        const { deps, posted } = fakes([], [], () => (healed ? answer(200, { success: true }) : answer(400, { error: 'Please set a profile photo before using the marketplace. Tap your profile to add one.' })));
        deps.healProfile = vi.fn(async () => { healed = true; return true; });
        const result = await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, undefined, deps);
        expect(deps.healProfile).toHaveBeenCalledTimes(1);
        expect(deps.healProfile).toHaveBeenCalledWith(LOCAL);
        expect(posted).toHaveLength(2);
        expect(result).toEqual({ brought: 2, lines: [], kept: false, held: false });
    });

    it('with none to send it stops at the first, says so once, and the question comes back', async () => {
        const words = 'Please set a profile photo before using the marketplace. Tap your profile to add one.';
        const { deps } = fakes([], [], () => answer(400, { error: words }));
        const result = await runBring(OFFER, { bring: [listing('a'), listing('b')], gone: [] }, identity, undefined, deps);
        expect(deps.post).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ brought: 0, lines: [{ kind: 'held', reason: words }], kept: false, held: true });
        expect(bringLineWords(result.lines[0], 'Mullumbimby')).toBe(words);
    });
});

describe('the end of a run', () => {
    const noted = () => noteBringOffer({ publicKey: ME, from: GLOBAL, to: LOCAL, name: 'Mullumbimby', alreadyMember: false, now: 1_000 });

    it('all done: the offer is over, and no later join makes another', async () => {
        await noted();
        await settleBringOffer(OFFER, { brought: 2, lines: [], kept: false, held: false }, 2_000);
        expect(await pendingBringOffer(ME, LOCAL, 2_000)).toBeNull();
        expect(await noted()).toBe(false);
    });

    it('something left: kept, with its yes, and counted', async () => {
        await noted();
        await settleBringOffer(OFFER, { brought: 1, lines: [], kept: true, held: false }, 2_000);
        expect(await pendingBringOffer(ME, LOCAL, 2_000)).toMatchObject({ accepted: true, tries: 1 });
    });

    it('held: asked again tomorrow, not run again unasked', async () => {
        await noted();
        await settleBringOffer({ ...OFFER, accepted: true }, { brought: 0, lines: [], kept: false, held: true }, 2_000);
        expect(await pendingBringOffer(ME, LOCAL, 2_000)).toBeNull();
        expect(await pendingBringOffer(ME, LOCAL, 2_000 + BRING_ASK_AGAIN_MS)).toMatchObject({ accepted: false, asks: 1 });
    });
});

describe('the words', () => {
    it('name the global community, since the phone is on the new one when they are read', () => {
        expect(BRING_WORDS.title('Mullumbimby')).toBe('Bring my listings to Mullumbimby?');
        expect(BRING_WORDS.body(3)).toBe('Your 3 listings on the global community will be posted there too, by you.');
        expect(BRING_WORDS.body(1)).toBe('Your 1 listing on the global community will be posted there too, by you.');
    });

    it('count', () => {
        expect(BRING_WORDS.bring(1)).toBe('Bring it');
        expect(BRING_WORDS.bring(2)).toBe('Bring them');
        expect(BRING_WORDS.done(1, 'Mullumbimby')).toBe('1 listing is now in Mullumbimby.');
        expect(BRING_WORDS.done(4, 'Mullumbimby')).toBe('4 listings are now in Mullumbimby.');
        expect(BRING_WORDS.done(0, 'Mullumbimby')).toBe('None of your listings came across.');
    });
});

describe('fetching a photo', () => {
    class FakeReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: { text: string }) {
            this.result = `data:application/octet-stream;base64,${blob.text}`;
            this.onload?.();
        }
    }
    const served = (status: number, base64 = '') => vi.fn(async () => ({ ok: status === 200, status, blob: async () => ({ text: base64 }) }));

    beforeEach(() => { (globalThis as any).FileReader = FakeReader; });

    it('gives the bytes as they are, typed by what they are and not by what the phone says', async () => {
        (globalThis as any).fetch = served(200, '/9j/4AAQ');
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ photo: 'data:image/jpeg;base64,/9j/4AAQ' });
        (globalThis as any).fetch = served(200, 'iVBORw0KGgoAAAA');
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ photo: 'data:image/png;base64,iVBORw0KGgoAAAA' });
    });

    it('a page that is not an image is no photo: a node would refuse the whole listing for it', async () => {
        (globalThis as any).fetch = served(200, 'PGh0bWw+');
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'gone' });
    });

    it('one past what a node stores is no photo either', async () => {
        (globalThis as any).fetch = served(200, `/9j/${'A'.repeat(2_800_000)}`);
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'gone' });
    });

    it('a 404 is gone; a server failing, a limit or no answer may come right', async () => {
        (globalThis as any).fetch = served(404);
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'gone' });
        (globalThis as any).fetch = served(503);
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'later' });
        (globalThis as any).fetch = served(429);
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'later' });
        (globalThis as any).fetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
        expect(await fetchedPostPhoto('https://g.example/p')).toEqual({ failed: 'later' });
    });
});
