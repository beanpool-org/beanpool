/**
 * The global community's smart link through the app's router (app/+native-intent.ts, utils/global-link.ts;
 * DESIGN-global-entry-fable.md §A row 5, slice P4). `https://beanpool.org/global` (the website's link, apps/website/global.html)
 * and `beanpool://global` open the first screen's door on a phone with no account; for an account, what the phone's one rule
 * for the global community offers it (utils/global-entry.ts): the global community's door, the BeanPool sheet for a member,
 * nothing for an account it closed (PR #2122 review); and nothing new while a join wizard is half done. A link that carries
 * an invite is the invite's. Every route lands on a screen that exists, on a cold start and warm.
 *
 * Before P4 the router handed both links on unchanged: Expo Router looked for app/global.tsx, which doesn't exist, and
 * showed Unmatched Route (the `every global link opens a screen that exists` cases fail on main).
 *
 * The link only opens a screen: the router reads the phone (a key kept? a wizard half done? what global last answered about
 * the key?) and sends nothing, and the routes it builds carry nothing but which door and when.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

/**
 * The phone as the router reads it: the key kept on it, the join wizard's record (utils/onboarding-state.ts), the keys global
 * closed (global-join-existing.ts accountClosedAtGlobal), and the phone's store, where global-entry.ts keeps what global
 * last answered about each key (read by the real readGlobalStanding).
 */
const phone = vi.hoisted(() => ({
    identity: null as null | { publicKey: string; callsign: string },
    pending: null as null | Record<string, unknown>,
    closed: [] as string[],
    store: new Map<string, string>(),
    reads: 0,
    globalReads: 0,
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => { phone.reads++; return phone.identity; }) }));
vi.mock('../onboarding-state', () => ({ getPendingOnboarding: vi.fn(async () => { phone.reads++; return phone.pending; }) }));
vi.mock('../global-join-existing', () => ({
    accountClosedAtGlobal: vi.fn(async (key: string | null | undefined) => { phone.globalReads++; return !!key && phone.closed.includes(key); }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => { phone.globalReads++; return phone.store.get(k) ?? null; }),
        setItem: vi.fn(async () => { throw new Error('the router must write nothing'); }),
        removeItem: vi.fn(async () => { throw new Error('the router must write nothing'); }),
    },
}));

import { redirectSystemPath, routeGlobalLink } from '../../app/+native-intent';
import { extractInviteToken } from '../invite-parser';
import { linkCarriesInvite } from '../welcome-invite';
import { doorFromLink, doorLinkKey, globalLinkRoute, isGlobalLink, isGlobalPath, type WelcomeMode } from '../global-link';
import { GLOBAL_STANDING_STORE_KEY, GLOBAL_STANDING_TTL_MS, globalEntryState, type GlobalStanding } from '../global-entry';

const ACCOUNT = { publicKey: 'ab'.repeat(16), callsign: 'Damo' };
const WIZARD = { step: 'create', inviteCode: 'INV-ABCD-EFGH', callsign: 'Damo' };

/** Global's last answer about the account's key, kept on the phone `ageMs` ago, as global-entry.ts askGlobalStanding keeps it. */
function kept(standing: 'member' | 'stranger', ageMs = 0): void {
    phone.store.set(GLOBAL_STANDING_STORE_KEY, JSON.stringify({ [ACCOUNT.publicKey]: { standing, at: Date.now() - ageMs } }));
}

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
    phone.closed = [];
    phone.store.clear();
    phone.reads = 0;
    phone.globalReads = 0;
    fetchSpy = vi.fn(async () => { throw new Error('the router must send nothing'); });
    vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function route(link: string, initial: boolean): Promise<string | null> {
    return await redirectSystemPath({ path: link, initial });
}

describe('the global link through the router: cold and warm × account or none × what global answered × a join wizard half done', () => {
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

    it.each(GLOBAL_LINKS)('%s, an account global closed: nothing to offer, not even over a member answer (cold: as from the icon; warm: stays)', async (link) => {
        phone.identity = ACCOUNT;
        phone.closed = [ACCOUNT.publicKey];
        expect(await route(link, true)).toBe('/');
        expect(screenFor('/')).toBe('index.tsx');
        expect(await route(link, false)).toBeNull();
        kept('member');
        expect(await route(link, true)).toBe('/');
        expect(await route(link, false)).toBeNull();
    });

    it.each(GLOBAL_LINKS)('%s, a member there (global said so under a day ago): no door, the BeanPool sheet, whose row switches to it', async (link) => {
        phone.identity = ACCOUNT;
        kept('member');
        for (const initial of [true, false]) {
            const to = await route(link, initial);
            expect(screenFor(to!), `${link} → ${to}`).toBe('beanpool.tsx');
            expect(paramsOf(to!)).toEqual({});
        }
    });

    it('a stranger there, or a member answer over a day old: the door, held for a tap (the door\'s own check decides)', async () => {
        phone.identity = ACCOUNT;
        kept('stranger');
        expect(await route('https://beanpool.org/global', false)).toBe('/join-global?from=link');
        kept('member', GLOBAL_STANDING_TTL_MS + 1);
        expect(await route('https://beanpool.org/global', true)).toBe('/join-global?from=link');
        expect(await route('beanpool://global', false)).toBe('/join-global?from=link');
    });

    it('the closed mark and kept answer are another key\'s: the door for this one', async () => {
        phone.identity = ACCOUNT;
        phone.closed = ['cd'.repeat(16)];
        phone.store.set(GLOBAL_STANDING_STORE_KEY, JSON.stringify({ ['cd'.repeat(16)]: { standing: 'member', at: Date.now() } }));
        expect(await route('https://beanpool.org/global', false)).toBe('/join-global?from=link');
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
        // What global last answered about the key, from the phone's store: the kept answer and the closed mark.
        expect(phone.globalReads).toBe(2);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(to).not.toContain(ACCOUNT.publicKey);
        expect(to).not.toContain('Damo');
        expect(to).not.toMatch(/https?:/);
    });
});

describe('the link follows the phone\'s one rule for the global community (utils/global-entry.ts globalEntryState)', () => {
    it('for every answer global could have left: the rule\'s member gets the sheet, closedAccount nothing, any other state the door', () => {
        for (const standing of ['member', 'stranger', 'unknown'] as GlobalStanding[]) {
            for (const closedHere of [false, true]) {
                for (const initial of [true, false]) {
                    const to = globalLinkRoute({ account: true, wizardPending: false, standing, closedHere }, initial, 1);
                    // The router asks no door: the door screen asks it as it opens, and says so itself when it can't be used.
                    const rule = globalEntryState({ account: true, standing, door: 'open', closedHere, saved: false });
                    const expected = rule === 'member' ? '/beanpool'
                        : rule === 'closedAccount' ? (initial ? '/' : null)
                        : '/join-global?from=link';
                    expect(to, `${standing} closed=${closedHere} initial=${initial} (${rule})`).toBe(expected);
                }
            }
        }
        // Nothing read: as `unknown`, not closed. The door.
        expect(globalLinkRoute({ account: true, wizardPending: false }, false, 1)).toBe('/join-global?from=link');
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

describe('a door a link opened holds its signed work until the member taps (app/join-global.tsx, app/welcome.tsx)', () => {
    // The 12-words door's work (utils/door-work.ts) is a POST signed by the joining key. Opened by a tap it starts with the
    // door; opened by a link or the install referrer it waits: the link only opens the screen.
    const read = (file: string) => fs.readFileSync(path.join(appDir, file), 'utf8');

    it('join-global: from=link holds the work; the door\'s opening starts it only when not held; either way in releases it', () => {
        const src = read('join-global.tsx');
        expect(src).toContain('useState(fromParam === FROM_LINK)');
        expect(src).toContain("if (!heldForTap) startWork(GLOBAL_NODE_URL, account.identity, 'words');");
        expect(src).toMatch(/function chooseWords\(\) \{[\s\S]{0,300}setHeldForTap\(false\);/);
        expect(src).toMatch(/async function handleSignIn\(provider: SsoProvider\) \{\s*setHeldForTap\(false\);/);
    });

    it('welcome: only the link and the referrer open the door held; a tap on Explore (a press event) never does', () => {
        const src = read('welcome.tsx');
        expect(src).toContain("setDoorHeld(how === 'link');");
        expect(src.match(/openGlobalDoor\('link'\)/g)).toHaveLength(1);
        expect(src).toContain("if (!doorHeld) doorWork.start(GLOBAL_NODE_URL, key.identity, 'words');");
        expect(src).toMatch(/function chooseWordsAtDoor\(\) \{[\s\S]{0,300}setDoorHeld\(false\);/);
        expect(src).toMatch(/async function handleGlobalSignIn\(provider: SsoProvider\) \{\s*setDoorHeld\(false\);/);
        // The link's door and the referrer's both go through the one check (doorFromLink).
        expect(src.match(/await openDoorFromLink\(\)|void openDoorFromLink\(\)/g)).toHaveLength(2);
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
