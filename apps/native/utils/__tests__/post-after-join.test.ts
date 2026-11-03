/**
 * The listing an invite was sent from, kept from the join to the landing (utils/post-after-join.ts), and the routes that
 * carry it: the root layout's guard takes it once the new member is on Home; +native-intent never opens it for a friend
 * who has not joined; the install referrer and the welcome params carry it as an id and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));

import { POST_AFTER_JOIN_KEY, POST_AFTER_JOIN_MS, holdPostAfterJoin, postRoute, takePostAfterJoin, type PostStore } from '../post-after-join';
import { readInstallReferrer } from '../install-referrer';
import { inviteToApply } from '../welcome-invite';
import { redirectSystemPath } from '../../app/+native-intent';
import { inviteLink } from '../names-invite';
import { extractInviteToken, normaliseInviteCode } from '../invite-parser';

const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const NODE = 'https://mullum.beanpool.org';

function memory(): PostStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: async (k) => map.get(k) ?? null,
        setItem: async (k, v) => { map.set(k, v); },
        removeItem: async (k) => { map.delete(k); },
    };
}

describe('the listing kept from the join to the landing', () => {
    it('is held as the community, the id and the time, and taken once', async () => {
        const store = memory();
        await holdPostAfterJoin(NODE, POST, 1_000, store);
        expect(JSON.parse(store.map.get(POST_AFTER_JOIN_KEY)!)).toEqual({ community: NODE, id: POST, at: 1_000 });
        expect(await takePostAfterJoin(NODE, 2_000, store)).toBe(`/post/${POST}`);
        expect(await takePostAfterJoin(NODE, 2_000, store)).toBeNull();
        expect(store.map.size).toBe(0);
    });

    it('is compared as a community is: a trailing slash or a capital changes nothing', async () => {
        const store = memory();
        await holdPostAfterJoin('https://Mullum.beanpool.org/', POST, 1_000, store);
        expect(await takePostAfterJoin(NODE, 2_000, store)).toBe(`/post/${POST}`);
    });

    it('is dropped for another community, and never kept for later', async () => {
        const store = memory();
        await holdPostAfterJoin(NODE, POST, 1_000, store);
        expect(await takePostAfterJoin('https://castlemaine.beanpool.org', 2_000, store)).toBeNull();
        expect(await takePostAfterJoin(NODE, 2_000, store)).toBeNull();
        await holdPostAfterJoin(NODE, POST, 1_000, store);
        expect(await takePostAfterJoin(null, 2_000, store)).toBeNull();
    });

    it('is dropped when it waited longer than a join takes, or is dated in the future', async () => {
        const store = memory();
        await holdPostAfterJoin(NODE, POST, 1_000, store);
        expect(await takePostAfterJoin(NODE, 1_000 + POST_AFTER_JOIN_MS + 1, store)).toBeNull();
        expect(store.map.size).toBe(0);
        await holdPostAfterJoin(NODE, POST, 9_000, store);
        expect(await takePostAfterJoin(NODE, 1_000, store)).toBeNull();
    });

    it('holds nothing that is not an id, and opens nothing from a slot that was tampered with', async () => {
        const store = memory();
        for (const bad of ['../../x', 'a b', 'https://evil.example', '', null, undefined, 12]) {
            await holdPostAfterJoin(NODE, bad, 1_000, store);
            expect(store.map.size, String(bad)).toBe(0);
        }
        for (const raw of ['not json', '[]', '"x"', JSON.stringify({ community: NODE, id: '../../x', at: 1_000 }), JSON.stringify({ community: NODE, id: POST, at: 'now' }), JSON.stringify({ id: POST, at: 1_000 })]) {
            store.map.set(POST_AFTER_JOIN_KEY, raw);
            expect(await takePostAfterJoin(NODE, 2_000, store), raw).toBeNull();
            expect(store.map.has(POST_AFTER_JOIN_KEY), raw).toBe(false);
        }
    });

    it('a store that fails opens nothing and throws nothing', async () => {
        const broken: PostStore = { getItem: async () => { throw new Error('disk'); }, setItem: async () => { throw new Error('disk'); }, removeItem: async () => { throw new Error('disk'); } };
        await expect(holdPostAfterJoin(NODE, POST, 1_000, broken)).resolves.toBeUndefined();
        await expect(takePostAfterJoin(NODE, 2_000, broken)).resolves.toBeNull();
    });

    it('opens the post screen with the id escaped', () => {
        expect(postRoute(POST)).toBe(`/post/${POST}`);
        expect(postRoute('sample-ladder')).toBe('/post/sample-ladder');
        expect(postRoute('a/b')).toBeNull();
        expect(postRoute(undefined)).toBeNull();
    });
});

describe('the ways the listing reaches the join', () => {
    it('the install referrer carries it beside the invite, as an id', () => {
        expect(readInstallReferrer(`invite=INV-AB12-CD34&server=${encodeURIComponent(NODE)}&post=${POST}`))
            .toEqual({ kind: 'invite', invite: 'INV-AB12-CD34', server: NODE, post: POST });
        expect(readInstallReferrer(`invite=INV-AB12-CD34&server=${encodeURIComponent(NODE)}`))
            .toEqual({ kind: 'invite', invite: 'INV-AB12-CD34', server: NODE });
        expect(readInstallReferrer(`invite=INV-AB12-CD34&server=${encodeURIComponent(NODE)}&post=${encodeURIComponent('../x')}`))
            .toEqual({ kind: 'invite', invite: 'INV-AB12-CD34', server: NODE });
    });

    it('the welcome params carry it with the invite they arrived with', () => {
        const { arrival } = inviteToApply(null, { invite: 'INV-AB12-CD34', server: NODE, post: POST, t: '1' }, new Set());
        expect(arrival).toEqual({ from: 'params', invite: 'INV-AB12-CD34', server: NODE, post: POST });
        const plain = inviteToApply(null, { invite: 'INV-AB12-CD34', server: NODE, t: '1' }, new Set()).arrival;
        expect(plain).toEqual({ from: 'params', invite: 'INV-AB12-CD34', server: NODE });
    });
});

describe('the link, read by an app that never heard of it', () => {
    const LINK = inviteLink(NODE, 'INV-AB12-CD34', POST);

    it('is the invite link with the listing after the code', () => {
        expect(LINK).toBe(`${NODE}/?invite=INV-AB12-CD34&post=${POST}`);
        expect(inviteLink(NODE, 'INV-AB12-CD34')).toBe(`${NODE}/?invite=INV-AB12-CD34`);
    });

    it('still gives the code to the phone parsers that existed before it, and the web parsers', async () => {
        expect(extractInviteToken(LINK)).toBe('INV-AB12-CD34');
        expect(normaliseInviteCode(LINK)).toBe('INV-AB12-CD34');
        // As a member shares it: in a message beside other words.
        expect(normaliseInviteCode(`Join my BeanPool Node!\n${LINK}\nNode URL: ${NODE}`)).toBe('INV-AB12-CD34');
    });

    it('is no shared listing for a friend who has not joined: the router never opens the post', () => {
        for (const initial of [true, false]) {
            const to = redirectSystemPath({ path: LINK, initial });
            expect(to, String(initial)).toBe(LINK);
            expect(String(to)).not.toContain('/post/');
            const deep = `beanpool://welcome?invite=INV-AB12-CD34&server=${encodeURIComponent(NODE)}&post=${POST}`;
            expect(redirectSystemPath({ path: deep, initial }), deep).toBe(deep);
        }
        // A shared listing with no invite opens as it always did.
        expect(redirectSystemPath({ path: `${NODE}/?post=${POST}`, initial: true })).toBe(`/post/${POST}`);
    });
});
