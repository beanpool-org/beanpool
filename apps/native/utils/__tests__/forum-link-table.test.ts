/**
 * The forum's links into the phone (slice F7, round 2; review of #3228 at 182aed8e): every link the server's public pages emit
 * for the forum (apps/server forum-public-pages.ts forumPageDoors: the front and a section page `beanpool://forum?node=<origin>`,
 * a topic page `…&topic=<id>`), in every spelling a system hands over, with a missing, malformed or other community's node and
 * an unknown or malformed topic, and the forum screens' own paths, x every reader (a visitor on the community, a member there,
 * a member of another community, a phone signed out, a visitor in a private preview, a visitor on a local community, a phone
 * halfway through a join wizard: a key and no guest mark, round 3), cold and warm -> the screen opened. The invariant: a forum opens only for the community the link names, and only when it is the one in
 * use; anything else opens nothing new. Never a different community's forum.
 *
 * Before this round the link fell through app/+native-intent.ts to the visitors' tab at /forum, whose member branch sent a
 * member of another community to their own community's members' forum (fails on 182aed8e: the member-elsewhere rows).
 *
 * The router is the real app/+native-intent.ts; the phone (the community in use, the guest mark, the key, the visitor check) is
 * mocked at its modules, so the router's own read of the phone is what runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

const phone = vi.hoisted(() => ({
    anchor: null as string | null,
    guest: false,
    forumPublic: false,
    identity: null as null | { publicKey: string },
    wizard: false,
}));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => phone.anchor) }));
vi.mock('../nodes', () => ({ isGuestNode: vi.fn(async () => phone.guest) }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => phone.identity) }));
vi.mock('../forum-public', () => ({ visitorForumHere: vi.fn(async () => phone.guest && phone.forumPublic) }));
vi.mock('../onboarding-state', () => ({ getPendingOnboarding: vi.fn(async () => (phone.wizard ? { step: 'profile' } : null)) }));

import { redirectSystemPath, routeForumLink } from '../../app/+native-intent';
import {
    MEMBER_FORUM_LIST, VISITOR_FORUM_TAB, forumLinkFromSystemPath, forumLinkRoute, forumOrigin, isForumPath,
} from '../forum-link';

/** The worldwide community as a page names it, and another community (neutral names: no node names in tests). */
const WORLD = 'https://world.example';
const OTHER = 'https://riverside.example';
const TOPIC = 'ft-0123456789abcdef01234567';
const KEY = { publicKey: 'ab'.repeat(16) };

/** A page's "Open in the app", built as forumPageDoors builds it (its spelling is pinned against the server's source below). */
const pageLink = (origin: string, topic: string | null) =>
    `beanpool://forum?node=${encodeURIComponent(origin)}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`;

type Reader = 'visitor' | 'visitor-with-key' | 'member' | 'member-elsewhere' | 'signed-out' | 'preview-visitor' | 'local-visitor'
    | 'wizard-half-done' | 'visitor-wizard-half-done';
const READERS: Record<Reader, typeof phone> = {
    'visitor': { anchor: WORLD, guest: true, forumPublic: true, identity: null, wizard: false },
    'visitor-with-key': { anchor: WORLD, guest: true, forumPublic: true, identity: KEY, wizard: false },
    'member': { anchor: WORLD, guest: false, forumPublic: true, identity: KEY, wizard: false },
    'member-elsewhere': { anchor: OTHER, guest: false, forumPublic: false, identity: KEY, wizard: false },
    'signed-out': { anchor: null, guest: false, forumPublic: false, identity: null, wizard: false },
    'preview-visitor': { anchor: WORLD, guest: true, forumPublic: false, identity: null, wizard: false },
    'local-visitor': { anchor: OTHER, guest: true, forumPublic: false, identity: KEY, wizard: false },
    // Halfway through a join wizard for the community in use (review note on 424fb857): a key and no guest mark, which reads
    // as a member; and a visitor there who has started to join. Nothing new for either, as the global link does.
    'wizard-half-done': { anchor: WORLD, guest: false, forumPublic: true, identity: KEY, wizard: true },
    'visitor-wizard-half-done': { anchor: WORLD, guest: true, forumPublic: true, identity: KEY, wizard: true },
};

/** What a link names when it is usable: the front or a section (no topic), or a topic. Null: it names nothing. */
type Names = 'list' | 'topic' | null;
const LINKS: ReadonlyArray<[string, string, Names]> = [
    ['front page', pageLink(WORLD, null), 'list'],
    ['section page (the same link as the front)', pageLink(WORLD, null), 'list'],
    ['topic page', pageLink(WORLD, TOPIC), 'topic'],
    ['unknown topic (a well-made id the node may not have)', pageLink(WORLD, 'ft-ffffffffffffffffffffffff'), 'topic'],
    ['topic first, node second', `beanpool://forum?topic=${TOPIC}&node=${encodeURIComponent(WORLD)}`, 'topic'],
    ['three slashes', pageLink(WORLD, TOPIC).replace('beanpool://', 'beanpool:///'), 'topic'],
    ['bare path', pageLink(WORLD, TOPIC).replace('beanpool://', '/'), 'topic'],
    ['no leading slash', pageLink(WORLD, TOPIC).replace('beanpool://', ''), 'topic'],
    ['trailing slash', pageLink(WORLD, TOPIC).replace('forum?', 'forum/?'), 'topic'],
    ['upper case', pageLink(WORLD, null).replace('forum', 'FORUM'), 'list'],
    ['node spelled with a slash, capitals and its port', pageLink('HTTPS://World.Example:443/', TOPIC), 'topic'],
    ['with a fragment', `${pageLink(WORLD, TOPIC)}#x`, 'topic'],
    ['no node, no topic', 'beanpool://forum', null],
    ['no node, a topic', `beanpool://forum?topic=${TOPIC}`, null],
    ['empty node', `beanpool://forum?node=&topic=${TOPIC}`, null],
    ['node without a scheme', pageLink('world.example', TOPIC), null],
    ['node with a login', pageLink('https://someone@world.example', TOPIC), null],
    ['node with a path', pageLink(`${WORLD}/forum`, TOPIC), null],
    ['node with a query', pageLink(`${WORLD}?x=1`, TOPIC), null],
    ['node as a script', pageLink('javascript:alert(1)', TOPIC), null],
    ['two nodes', `${pageLink(WORLD, TOPIC)}&node=${encodeURIComponent(WORLD)}`, null],
    ['another community\'s node', pageLink(OTHER, TOPIC), 'topic'],
    ['another community\'s front', pageLink(OTHER, null), 'list'],
    ['topic with a slash', pageLink(WORLD, 'ft-1/../x'), null],
    ['topic too long', pageLink(WORLD, `ft-${'a'.repeat(62)}`), null],
    ['topic that is a members\' screen: new', pageLink(WORLD, 'new'), null],
    ['topic that is a members\' screen: first-looks', pageLink(WORLD, 'first-looks'), null],
    ['empty topic', `${pageLink(WORLD, null)}&topic=`, null],
    ['two topics', `${pageLink(WORLD, TOPIC)}&topic=ft-abc`, null],
    ['a members\' topic screen\'s path', `beanpool://forum/${TOPIC}`, null],
    ['a members\' topic screen\'s path, with the node', `beanpool://forum/${TOPIC}?node=${encodeURIComponent(WORLD)}`, null],
    ['the public page\'s own path', `beanpool://forum/t/${TOPIC}`, null],
    ['the new topic screen', 'beanpool://forum/new', null],
    ['the first looks screen', 'beanpool://forum/first-looks', null],
    ['the visitors\' topic screen\'s path', `beanpool://forum-public/${TOPIC}`, null],
    ['the visitors\' tab\'s path', 'beanpool://visitor-forum', null],
];

/** The community a link names (when it names one), for the expectation. */
const named = (link: string) => forumLinkFromSystemPath(link)?.origin ?? null;

/** The one rule, spelled out for the table: the named community's forum, only when it is the one in use; else nothing new. */
function expected(link: string, names: Names, reader: Reader, initial: boolean): string | null {
    const nothing = initial ? '/' : null;
    const at = READERS[reader];
    if (names === null || at.wizard || named(link) !== forumOrigin(at.anchor)) return nothing;
    const topic = forumLinkFromSystemPath(link)!.topic;
    // As the phone reads the community in use: a guest whose forum anyone may read is a visitor; a key and no guest mark, a member.
    if (at.guest && at.forumPublic) return names === 'topic' ? `/forum-public/${topic}` : VISITOR_FORUM_TAB;
    if (!at.guest && at.identity) return names === 'topic' ? `/forum/${topic}` : MEMBER_FORUM_LIST;
    return nothing;
}

const appDir = path.resolve(__dirname, '../../app');

/** Every route file's URL path (Expo Router: groups dropped, `index` is its folder's path), against the file. */
function routePaths(dir = appDir, rel = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(rel, entry.name);
        if (entry.isDirectory()) { out.push(...routePaths(path.join(dir, entry.name), file)); continue; }
        if (!/\.tsx?$/.test(entry.name) || /^(_layout|\+)/.test(entry.name) || /^[A-Z]/.test(entry.name)) continue;
        const url = file.replace(/\.tsx?$/, '').split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).filter((s, i, all) => !(s === 'index' && i === all.length - 1)).join('/');
        out.push([url, file]);
    }
    return out;
}

/** The route file Expo Router matches for an href, or null (Unmatched Route). */
function screenFor(href: string): string | null {
    const p = href.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/^\(tabs\)\/?/, '');
    const files = routePaths();
    const exact = files.find(([url]) => url === p);
    if (exact) return exact[1];
    const parent = p.split('/').slice(0, -1).join('/');
    const dynamic = files.find(([url]) => url.startsWith(parent ? `${parent}/` : '') && /^\[[^\]/]+\]$/.test(url.slice(parent ? parent.length + 1 : 0)));
    return dynamic ? dynamic[1] : null;
}

beforeEach(() => { Object.assign(phone, READERS['signed-out']); });

describe('the forum\'s links x every reader -> the screen opened, never a different community\'s forum', () => {
    for (const [what, link, names] of LINKS) {
        it(`${what}: ${link}`, async () => {
            expect(isForumPath(link)).toBe(true);
            for (const reader of Object.keys(READERS) as Reader[]) {
                for (const initial of [true, false]) {
                    Object.assign(phone, READERS[reader]);
                    const route = await redirectSystemPath({ path: link, initial });
                    expect({ reader, initial, route }).toEqual({ reader, initial, route: expected(link, names, reader, initial) });
                    // The invariant, apart from the spelled-out rule: a forum route only for the community in use, named by the link.
                    if (route !== '/' && route !== null) {
                        expect(named(link)).toBe(forumOrigin(READERS[reader].anchor));
                        expect(screenFor(route)).not.toBeNull();
                    }
                }
            }
        });
    }

    it('the member of another community: no forum at all, whatever the link names (the review\'s case)', async () => {
        Object.assign(phone, READERS['member-elsewhere']);
        for (const [, link] of LINKS) {
            for (const initial of [true, false]) {
                const route = await redirectSystemPath({ path: link, initial });
                // Their own community's forum only from a link that names their own community; the world's links open nothing.
                if (named(link) !== OTHER) expect(route).toBe(initial ? '/' : null);
            }
        }
    });

    it('every usable route lands on the screen it means', () => {
        expect(screenFor(`/forum-public/${TOPIC}`)).toBe(path.join('forum-public', '[id].tsx'));
        expect(screenFor(`/forum/${TOPIC}`)).toBe(path.join('forum', '[id].tsx'));
        expect(screenFor(VISITOR_FORUM_TAB)).toBe(path.join('(tabs)', 'visitor-forum.tsx'));
        expect(screenFor(MEMBER_FORUM_LIST)).toBe(path.join('(tabs)', 'chats.tsx'));
    });

    it('a phone that can\'t be read opens nothing new', async () => {
        const fail = async () => { throw new Error('no store'); };
        expect(await routeForumLink(pageLink(WORLD, TOPIC), true, fail)).toBe('/');
        expect(await routeForumLink(pageLink(WORLD, TOPIC), false, fail)).toBeNull();
    });

    it('the pure rule agrees: only the community in use, as the phone reads it', () => {
        const link = { origin: WORLD, topic: TOPIC };
        expect(forumLinkRoute(link, { anchor: `${WORLD}/`, reader: 'visitor', wizardPending: false }, false)).toBe(`/forum-public/${TOPIC}`);
        expect(forumLinkRoute(link, { anchor: OTHER, reader: 'visitor', wizardPending: false }, false)).toBeNull();
        expect(forumLinkRoute(link, { anchor: OTHER, reader: 'member', wizardPending: false }, false)).toBeNull();
        expect(forumLinkRoute(link, { anchor: null, reader: 'member', wizardPending: false }, true)).toBe('/');
        expect(forumLinkRoute(link, { anchor: WORLD, reader: 'elsewhere', wizardPending: false }, true)).toBe('/');
        expect(forumLinkRoute(link, { anchor: WORLD, reader: 'member', wizardPending: false }, false)).toBe(`/forum/${TOPIC}`);
    });

    it('a phone halfway through a join wizard (a key, no guest mark: it reads as a member) gets nothing new, cold or warm', async () => {
        const link = { origin: WORLD, topic: TOPIC };
        expect(forumLinkRoute(link, { anchor: WORLD, reader: 'member', wizardPending: true }, true)).toBe('/');
        expect(forumLinkRoute(link, { anchor: WORLD, reader: 'member', wizardPending: true }, false)).toBeNull();
        expect(forumLinkRoute({ origin: WORLD, topic: null }, { anchor: WORLD, reader: 'visitor', wizardPending: true }, false)).toBeNull();
        // Through the router, as the phone is read: the wizard's record is what decides, not the key.
        Object.assign(phone, READERS['wizard-half-done']);
        expect(await redirectSystemPath({ path: pageLink(WORLD, TOPIC), initial: true })).toBe('/');
        expect(await redirectSystemPath({ path: pageLink(WORLD, TOPIC), initial: false })).toBeNull();
        Object.assign(phone, { wizard: false });
        expect(await redirectSystemPath({ path: pageLink(WORLD, TOPIC), initial: false })).toBe(`/forum/${TOPIC}`);
    });
});

describe('the links the table reads are the ones the server pages emit, and no route shares the forum\'s path', () => {
    it('forumPageDoors spells "Open in the app" as the table builds it; a section page has no topic, as the front', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../../server/src/forum-public-pages.ts'), 'utf-8');
        expect(src).toContain('const appQuery = `node=${encodeURIComponent(ctx.appOrigin)}${topicId ? `&topic=${encodeURIComponent(topicId)}` : \'\'}`;');
        expect(src).toContain('app: `beanpool://forum?${appQuery}`');
        // The front and a section page pass no topic; a topic page its own id.
        expect(src.match(/doorsHtml\(ctx, null, w\)/g)).toHaveLength(2);
        expect(src).toContain('doorsHtml(ctx, topic.id, w)');
        // And nothing else on the server, the web or core emits a beanpool://forum link.
        const emitters: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); continue; }
                if (/\.(ts|tsx)$/.test(e.name) && !/(\.test\.|^test-)/.test(e.name) && /beanpool:\/\/forum/.test(fs.readFileSync(p, 'utf-8'))) emitters.push(path.relative(path.resolve(__dirname, '../../../..'), p));
            }
        };
        for (const d of ['../../../server/src', '../../../pwa/src', '../../../../packages/beanpool-core/src']) walk(path.resolve(__dirname, d));
        expect(emitters).toEqual([path.join('apps', 'server', 'src', 'forum-public-pages.ts')]);
    });

    it('no two route files share a URL path, and only app/forum/ may hold /forum (a later app/forum/index.tsx collides with nothing)', () => {
        const all = routePaths();
        const seen = new Map<string, string[]>();
        for (const [url, file] of all) seen.set(url, [...(seen.get(url) ?? []), file]);
        const shared = [...seen].filter(([, files]) => files.length > 1).map(([url, files]) => [url, files.slice().sort()]);
        // The app's start (app/index.tsx) and the tabs' Home ((tabs)/index.tsx) are both "/": Expo Router's own pair, as before.
        expect(shared).toEqual([['', [path.join('(tabs)', 'index.tsx'), 'index.tsx'].sort()]]);
        for (const [url, file] of all) {
            if (url === 'forum' || url.startsWith('forum/')) expect(file.startsWith(`forum${path.sep}`)).toBe(true);
        }
    });
});
