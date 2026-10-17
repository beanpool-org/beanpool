/**
 * The global community's smart link through the app's router (app/+native-intent.ts, utils/global-link.ts;
 * DESIGN-global-entry-fable.md §A row 5, slice P4). `https://beanpool.org/global` (the website's link, apps/website/global.html)
 * and `beanpool://global` open the first screen's door on a phone with no account, the global community's door for an
 * account, and nothing new while a join wizard is half done. A link that carries an invite is the invite's. Every route
 * lands on a screen that exists, on a cold start and warm.
 *
 * Before P4 the router handed both links on unchanged: Expo Router looked for app/global.tsx, which doesn't exist, and
 * showed Unmatched Route (the `every global link opens a screen that exists` cases fail on main).
 *
 * The link only opens a screen: the router reads the phone (a key kept? a wizard half done?) and sends nothing, and the
 * routes it builds carry nothing but which door and when.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

/** The phone as the router reads it: the key kept on it, and the join wizard's record (utils/onboarding-state.ts). */
const phone = vi.hoisted(() => ({
    identity: null as null | { publicKey: string; callsign: string },
    pending: null as null | Record<string, unknown>,
    reads: 0,
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => { phone.reads++; return phone.identity; }) }));
vi.mock('../onboarding-state', () => ({ getPendingOnboarding: vi.fn(async () => { phone.reads++; return phone.pending; }) }));

import { redirectSystemPath, routeGlobalLink } from '../../app/+native-intent';
import { extractInviteToken } from '../invite-parser';
import { linkCarriesInvite } from '../welcome-invite';
import { doorFromLink, doorLinkKey, globalLinkRoute, isGlobalLink, isGlobalPath, type WelcomeMode } from '../global-link';

const ACCOUNT = { publicKey: 'ab'.repeat(16), callsign: 'Damo' };
const WIZARD = { step: 'create', inviteCode: 'INV-ABCD-EFGH', callsign: 'Damo' };

const appDir = path.resolve(__dirname, '../../app');
/** The route file Expo Router matches for an href (as pair-link.test.ts reads it), or null: Unmatched Route. */
function screenFor(href: string): string | null {
    const p = href.replace(/^beanpool:\/\/\/?/i, '').replace(/^https?:\/\/[^/?#]*/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
    if (p === '') return fs.existsSync(path.join(appDir, 'index.tsx')) ? 'index.tsx' : null;
    const segs = p.split('/');
    let dir = appDir;
    const found: string[] = [];
    for (let i = 0; i < segs.length; i++) {
        const last = i === segs.length - 1;
        const entries = fs.readdirSync(dir);
        const exact = last ? entries.find((e) => e === `${segs[i]}.tsx`) : entries.find((e) => e === segs[i]);
        const dynamic = last ? entries.find((e) => /^\[[^\]]+\]\.tsx$/.test(e)) : entries.find((e) => /^\[[^\]]+\]$/.test(e));
        const next = exact ?? dynamic;
        if (!next) return null;
        found.push(next);
        dir = path.join(dir, next);
    }
    return found.join('/');
}
function paramsOf(href: string): Record<string, string> {
    return Object.fromEntries(new URL(href, 'beanpool://x').searchParams);
}

/** Every spelling a system hands over: the website's link (as Chrome's intent link and iOS deliver it) and the app's. */
const GLOBAL_LINKS = [
    'https://beanpool.org/global',
    'https://beanpool.org/global/',
    'https://beanpool.org/global?utm_source=socialism.org',
    'https://beanpool.org/global#join',
    'https://beanpool.org/global.html',
    'https://BEANPOOL.ORG/global',
    'beanpool://global',
    'beanpool:///global',
    'BEANPOOL://global/',
    'beanpool://global?from=site',
    '/global',
    'global',
];

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
    phone.identity = null;
    phone.pending = null;
    phone.reads = 0;
    fetchSpy = vi.fn(async () => { throw new Error('the router must send nothing'); });
    vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function route(link: string, initial: boolean): Promise<string | null> {
    return await redirectSystemPath({ path: link, initial });
}

describe('the global link through the router: cold and warm × account or none × a join wizard half done', () => {
    it.each(GLOBAL_LINKS)('%s, no account: the first screen, asked to open its door, new each arrival', async (link) => {
        for (const initial of [true, false]) {
            const to = await route(link, initial);
            expect(screenFor(to!), `${link} → ${to}`).toBe('welcome.tsx');
            expect(paramsOf(to!).door).toBe('global');
            expect(paramsOf(to!).at).toMatch(/^\d+$/);
        }
    });

    it.each(GLOBAL_LINKS)('%s, an account: the global community\'s door for it, its work held for a tap', async (link) => {
        phone.identity = ACCOUNT;
        for (const initial of [true, false]) {
            const to = await route(link, initial);
            expect(screenFor(to!), `${link} → ${to}`).toBe('join-global.tsx');
            expect(paramsOf(to!)).toEqual({ from: 'link' });
        }
    });

    it.each(GLOBAL_LINKS)('%s, a join wizard half done: nothing new (cold: as from the icon; warm: where the member is)', async (link) => {
        phone.identity = ACCOUNT;
        phone.pending = WIZARD;
        expect(await route(link, true)).toBe('/');
        expect(screenFor('/')).toBe('index.tsx');
        expect(await route(link, false)).toBeNull();
        // A wizard record whose key is gone is nothing to resume either way: the first screen clears it.
        phone.identity = null;
        expect(await route(link, true)).toBe('/');
        expect(await route(link, false)).toBeNull();
    });

    it('a second tap of the same link is a second arrival (the first screen opens its door once per arrival)', async () => {
        const first = await routeGlobalLink(false, async () => ({ account: false, wizardPending: false }), () => 1000);
        const second = await routeGlobalLink(false, async () => ({ account: false, wizardPending: false }), () => 2000);
        expect(first).toBe('/welcome?door=global&at=1000');
        expect(second).toBe('/welcome?door=global&at=2000');
    });

    it('a phone that can\'t be read opens as from its icon (cold) or stays (warm): never a guess at which door', async () => {
        const unreadable = async () => { throw new Error('storage'); };
        expect(await routeGlobalLink(true, unreadable)).toBe('/');
        expect(await routeGlobalLink(false, unreadable)).toBeNull();
    });

    it('the router reads the phone only and sends nothing; the route carries no key, name or address', async () => {
        phone.identity = ACCOUNT;
        const to = await route('https://beanpool.org/global', false);
        expect(phone.reads).toBe(2);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(to).not.toContain(ACCOUNT.publicKey);
        expect(to).not.toContain('Damo');
        expect(to).not.toMatch(/https?:/);
    });
});

describe('an invite always wins', () => {
    const WITH_INVITE = [
        'https://beanpool.org/global?invite=INV-ABCD-EFGH&server=https%3A%2F%2Fmullum.beanpool.org',
        'beanpool://global?invite=INV-ABCD-EFGH&server=https%3A%2F%2Fmullum.beanpool.org',
    ];

    it.each(WITH_INVITE)('%s: not the door; the invite readers take it, and the app opens on a real screen', async (link) => {
        for (const account of [null, ACCOUNT]) {
            phone.identity = account;
            const cold = redirectSystemPath({ path: link, initial: true });
            const warm = redirectSystemPath({ path: link, initial: false });
            // At once, without reading the phone: it is not the global link.
            expect(cold).toBe('/');
            expect(warm).toBeNull();
            expect(phone.reads).toBe(0);
        }
        // What the root layout and the first screen read from the same link (app/_layout.tsx, utils/welcome-invite.ts).
        expect(linkCarriesInvite(link)).toBe(true);
        expect(extractInviteToken(link)).toBe('INV-ABCD-EFGH');
    });

    it('the global link itself reads as no invite to the root layout (it never offers "Switch Nodes?" for it)', () => {
        for (const link of ['https://beanpool.org/global', 'beanpool://global', 'https://beanpool.org/global.html']) {
            expect(linkCarriesInvite(link)).toBe(false);
            const token = extractInviteToken(link);
            // _layout.tsx refuses any of these as a token: an http URL, a path, or shorter than 5.
            expect(token.startsWith('http') || token.includes('/') || token.length < 5, `${link} → ${token}`).toBe(true);
        }
    });
});

describe('other links are not the global link, and are routed as before', () => {
    it.each([
        // The global community's own node: its invites and shared posts, as every node's.
        ['https://global.beanpool.org/', 'index.tsx'],
        ['https://global.beanpool.org/?post=abc', 'post/[id].tsx'],
        ['https://mullum.beanpool.org/?invite=INV-ABCD-EFGH', 'index.tsx'],
        ['beanpool://welcome?invite=INV-ABCD-EFGH&server=https%3A%2F%2Fmullum.beanpool.org', 'welcome.tsx'],
    ])('%s', (link, screen) => {
        const to = redirectSystemPath({ path: link, initial: true });
        expect(typeof to).toBe('string');
        expect(screenFor(to as string)).toBe(screen);
        expect(phone.reads).toBe(0);
    });

    it.each([
        'https://www.beanpool.org/global',
        'http://beanpool.org/global',
        'https://beanpool.org:8443/global',
        'https://beanpool.org/',
        'https://beanpool.org/glob',
        'https://beanpool.org/help.html?next=/global',
        'https://beanpool.org.evil.test/global',
        'https://beanpool.org@evil.test/global',
        'https://evil.test/global',
        'beanpool://globalx',
        'beanpool://global-join',
        'beanpool://join-global',
        'beanpool://x/global',
    ])('%s is not the global link (the phone is not read)', (link) => {
        const to = redirectSystemPath({ path: link, initial: false });
        expect(to instanceof Promise).toBe(false);
        expect(phone.reads).toBe(0);
    });
});

describe('the first screen and the link (doorFromLink): an invite or a wizard wins, and nothing the member is doing is interrupted', () => {
    const MODES: WelcomeMode[] = ['home', 'member', 'create', 'globalJoin', 'recover', 'ssoRecover', 'profileSetup', 'seedBackup', 'onboardingGuide', 'confirmReplace'];
    const OPENS = new Set<WelcomeMode>(['home', 'member', 'create']);

    it.each(MODES)('%s', (mode) => {
        expect(doorFromLink({ mode, inviteInHand: false, wizardPending: false })).toBe(OPENS.has(mode) ? 'open' : 'stay');
        // An invite in hand (arrived by a link, the referrer or the clipboard, or typed): it wins, whichever came first.
        expect(doorFromLink({ mode, inviteInHand: true, wizardPending: false })).toBe('stay');
        // A join wizard half done resumes: the link starts nothing new.
        expect(doorFromLink({ mode, inviteInHand: false, wizardPending: true })).toBe('stay');
    });

    it('each arrival is known by its stamp, so it opens the door once; anything but door=global is none', () => {
        expect(doorLinkKey('global', '1000')).toBe('door:1000');
        expect(doorLinkKey('global', '2000')).not.toBe(doorLinkKey('global', '1000'));
        for (const other of ['', undefined, null, 'Global', ['global'], 'mullum']) expect(doorLinkKey(other, '1000')).toBeNull();
    });

    it('the route the router builds is the one the first screen reads', () => {
        const to = globalLinkRoute({ account: false, wizardPending: false }, true, 1234);
        const p = paramsOf(to!);
        expect(doorLinkKey(p.door, p.at)).toBe('door:1234');
    });

    it('isGlobalPath tells the shape; isGlobalLink also leaves an invite to the invite readers', () => {
        expect(isGlobalPath('https://beanpool.org/global?invite=INV-ABCD-EFGH')).toBe(true);
        expect(isGlobalLink('https://beanpool.org/global?invite=INV-ABCD-EFGH')).toBe(false);
        for (const link of GLOBAL_LINKS) expect(isGlobalLink(link), link).toBe(true);
        for (const junk of [undefined, null, 42, {}, '', ' ']) expect(isGlobalLink(junk)).toBe(false);
    });
});
