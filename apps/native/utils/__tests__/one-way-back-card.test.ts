// @vitest-environment jsdom
/**
 * The "one way back" card (components/OneWayBackCard.tsx), rendered for real: react-dom in jsdom, React Native's host
 * components as plain tags, the real utils/one-way-back.ts and node-post signing, and a stubbed global community whose
 * `GET /api/community/me` answers as routes/community.ts does. Every request is counted.
 *
 * PR #1452 re-review (03cd9d2a), findings 1-3:
 * 1. A sign-in added after "I still have my 12 words" (here or elsewhere) puts the offer away for good.
 * 2. Where the key vault keeps a copy of the key, the card never says "one way back"; adding a sign-in is still offered
 *    quietly in Settings (it lifts the 12-words limits).
 * 3. The asking is bounded: at most one ask per account every ONE_WAY_BACK_ASK_EVERY_MS, a guest's 403 and `ordinary`
 *    kept like any answer, a done record never asks, and a phone using another community never asks about a done one.
 *    The test prints requests per hour of Market use, a focus every 2 minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
        createElement(tag, { ...(onPress ? { onClick: onPress } : {}), ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}) }, children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TouchableOpacity: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
const focus = vi.hoisted(() => ({ run: null as null | (() => void) }));
vi.mock('expo-router', () => ({
    router: { push: vi.fn() },
    // The screen gains focus: mounted focused, and again whenever the test says so.
    useFocusEffect: (cb: () => void) => {
        useEffect(() => { focus.run = cb; cb(); }, [cb]);
    },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), vault: new Set<string>(), anchor: '' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../db', () => ({ getMyPosts: vi.fn(async () => []) }));
vi.mock('../vault', () => ({ vaultCopyKnown: vi.fn(async (publicKey: string) => mem.vault.has(publicKey)) }));
vi.mock('../node-post', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-post')>()),
    anchorUrl: vi.fn(async () => mem.anchor || null),
}));
// The sheet as the real one ends a link: the record says linked, then onLinked. It shows the community it was handed.
vi.mock('../../components/LinkSignInSheet', () => ({
    LinkSignInSheet: ({ visible, identity, community, onLinked, onClose }: any) => visible
        ? createElement('button', {
            'data-community': community ?? '',
            onClick: async () => {
                const { finishOneWayBack } = await import('../one-way-back');
                await finishOneWayBack(identity.publicKey, 'linked');
                node.rules = 'ordinary';
                onLinked({ kind: 'linked', provider: 'google', enrolment: null });
                onClose();
            },
        }, 'sheet: Done')
        : null,
}));

import { OneWayBackCard } from '../../components/OneWayBackCard';
import { ONE_WAY_BACK_TEXT, finishOneWayBack, readOneWayBack, startOneWayBack, startOneWayBackPutAway } from '../one-way-back';
import { draftIdentity } from '../identity';

const GLOBAL = 'https://global.beanpool.org';
const OTHER = 'https://mullum.beanpool.org';
const node = { rules: 'words' as 'words' | 'ordinary' | 'guest', asks: 0 };

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
    mem.async.clear();
    mem.vault.clear();
    mem.anchor = GLOBAL;
    node.rules = 'words';
    node.asks = 0;
    who.identity = await draftIdentity();
    globalThis.fetch = vi.fn(async (url: any) => {
        const u = new URL(String(url));
        if (u.pathname !== '/api/community/me') throw new TypeError(`unexpected ${u.href}`);
        node.asks++;
        if (node.rules === 'guest') return new Response(JSON.stringify({ error: 'Read access requires a member identity' }), { status: 403 });
        const words = node.rules === 'words';
        const ends = new Date(Date.now() + (words ? 168 : 72) * 3600_000).toISOString();
        return new Response(JSON.stringify({ probation: { rules: node.rules, ageEndsAt: ends, endsWhen: { hours: words ? 168 : 72, keptPosts: 3 } } }), { status: 200 });
    }) as any;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T08:00:00Z') });
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

async function settle() {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(place: 'landing' | 'settings') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(OneWayBackCard, { place }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}

const text = () => document.body.textContent ?? '';
const warning = () => text().includes(ONE_WAY_BACK_TEXT.body);
const quietOffer = () => text().includes('A sign-in can be a second way back');

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(label));
    if (!found) throw new Error(`no button "${label}" in: ${text()}`);
    return found as HTMLButtonElement;
}

/** An hour of Market use: a focus every 2 minutes. The asks it made, all told (the first render included). */
async function anHourOfFocuses(): Promise<number> {
    for (let i = 0; i < 30; i++) {
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await act(async () => { focus.run?.(); });
        await settle();
    }
    return node.asks;
}

// A 12-words join at any community's open door starts the record (app/join-open-door.tsx), and the card opens the sheet
// for it: the sheet names that community where it would name the global one (VR2 review r4407770716).
describe('the sheet names the community the record is about', () => {
    async function sheetFor(url: string): Promise<string | null> {
        mem.anchor = url;
        await startOneWayBack(who.identity.publicKey, url);
        await render('settings');
        await act(async () => { button('Add a sign-in').click(); });
        await settle();
        return button('sheet: Done').getAttribute('data-community');
    }

    it('another community\'s door: its saved name', async () => {
        mem.async.set('beanpool_saved_nodes', JSON.stringify([{ url: OTHER, alias: 'Mullumbimby' }]));
        expect(await sheetFor(OTHER)).toBe('Mullumbimby');
    });

    it('another community\'s door with no saved name: its host', async () => {
        expect(await sheetFor(OTHER)).toBe('mullum.beanpool.org');
    });

    it('the global community\'s door: no name, so the sheet says the global community as before', async () => {
        mem.async.set('beanpool_saved_nodes', JSON.stringify([{ url: GLOBAL, alias: 'Global' }]));
        expect(await sheetFor(GLOBAL)).toBe('');
    });
});

describe('finding 1: a sign-in added after "I still have my 12 words" puts the offer away for good', () => {
    it('added from Settings\' quiet offer: gone, and the record says linked', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        await render('settings');
        expect(quietOffer()).toBe(true);
        await act(async () => { button(ONE_WAY_BACK_TEXT.addSignIn).click(); });
        await act(async () => { button('sheet: Done').click(); });
        await settle();
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
        expect(quietOffer()).toBe(false);
        // Another focus later changes nothing.
        vi.setSystemTime(Date.now() + 3 * 3600_000);
        await act(async () => { focus.run?.(); });
        await settle();
        expect(quietOffer()).toBe(false);
    });

    it('added elsewhere (the web, another phone): the node says ordinary, and the checked record becomes linked', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        node.rules = 'ordinary';
        await render('settings');
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
        expect(quietOffer()).toBe(false);
    });
});

describe('finding 2: the key vault keeps a copy: never "one way back"', () => {
    it('no record here, the node says words, the vault keeps a copy: no card on the Market, no record started', async () => {
        mem.vault.add(who.identity.publicKey);
        await render('landing');
        expect(warning()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toBeNull();
    });

    it('a 12-words record, then Protect with on a vault build: the warning goes; Settings still offers a sign-in, quietly', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        mem.vault.add(who.identity.publicKey);
        await render('landing');
        expect(warning()).toBe(false);
        act(() => root?.unmount());
        await render('settings');
        expect(warning()).toBe(false);
        expect(quietOffer()).toBe(true);
    });

    it('control: no vault copy, the node says words: the warning card', async () => {
        await render('landing');
        expect(warning()).toBe(true);
    });
});

describe('finding 3: the asking is bounded (an hour of Market use, a focus every 2 minutes)', () => {
    const counts: Record<string, number> = {};
    afterEach(() => { console.log(`[one-way-back asks per hour] ${JSON.stringify(counts)}`); });

    it('a guest on global (403): its answer is kept like any other', async () => {
        node.rules = 'guest';
        await render('landing');
        counts.guest = await anHourOfFocuses();
        // Asked at 0, 30 and 60 minutes: once per half hour.
        expect(counts.guest).toBeLessThanOrEqual(3);
    });

    it('a sign-in member of global (ordinary): asked once, then a done record, and never again', async () => {
        node.rules = 'ordinary';
        await render('landing');
        counts.signInMember = await anHourOfFocuses();
        expect(counts.signInMember).toBe(1);
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
    });

    it('a 12-words member with no sign-in yet: at most one ask per half hour', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render('landing');
        counts.wordsMember = await anHourOfFocuses();
        expect(counts.wordsMember).toBeLessThanOrEqual(3);
        expect(warning()).toBe(true);
    });

    it('a done record ("I still have my 12 words") on a phone using another community: never asks global', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        mem.anchor = OTHER;
        await render('landing');
        counts.checkedElsewhere = await anHourOfFocuses();
        expect(counts.checkedElsewhere).toBe(0);
    });

    it('a linked record anywhere: never asks', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'linked');
        await render('settings');
        counts.linked = await anHourOfFocuses();
        expect(counts.linked).toBe(0);
    });

    it('kept across app starts: a new card (a restart) inside the half hour asks nothing', async () => {
        node.rules = 'guest';
        await render('landing');
        expect(node.asks).toBe(1);
        act(() => root?.unmount());
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await render('landing');
        expect(node.asks).toBe(1);
    });
});

// Home's Arrange hands the card a band for as long as it is open (components/home/quiet.ts): the card's inside goes quiet, but
// it is the same inside. Draw it bare in one state and wrapped in the other and React rebuilds it on Arrange › and on Done (the
// review of #2867): the buttons' places are measured again and anything the card holds starts over.
describe('Home\'s Arrange band: the card\'s inside is not rebuilt when the band goes up or comes down', () => {
    it('the same elements stand through no band → band → no band', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render('landing');
        const inside = (): Element[] => Array.from(document.querySelectorAll('button, span'));
        const before = inside();
        expect(before.length).toBeGreaterThan(2);
        expect(warning()).toBe(true);
        const draw = (band?: ReactNode) => act(async () => {
            root!.render(createElement(OneWayBackCard, { place: 'landing', band }) as unknown as Parameters<Root['render']>[0]);
        });
        await draw(createElement('div', { 'data-testid': 'band' }, 'ONE WAY BACK'));
        await settle();
        expect(document.querySelector('[data-testid="band"]')).not.toBeNull();
        expect(before.filter(e => !e.isConnected).map(e => e.textContent)).toEqual([]);
        await draw(undefined);
        await settle();
        expect(document.querySelector('[data-testid="band"]')).toBeNull();
        expect(before.filter(e => !e.isConnected).map(e => e.textContent)).toEqual([]);
        expect(warning()).toBe(true);
    });
});

// DESIGN-home-default-fable.md §2.5 (Marty's pick 2, 13 Nov 2026; slice D2): the reminder for every member whose 12 words
// are their only way back, by what the account has (Home's `me.wayBack`), not how it joined. Sign-up counts as the first
// showing: day one is First steps' line only, the card comes once after the first post and once after a week, then
// Settings. Where the node takes no sign-in from them (review of #3110, round 2: `linkState` refuses an invited member),
// the card offers none.
describe('an invite sign-up that carried on: no card on day one, card after the first post, card after a week, then Settings', () => {
    const SIGNED_UP = Date.parse('2026-10-02T08:00:00Z');
    const kept: unknown[] = [];
    /** Home's word for an invited member with no sign-in: the words are the only way back, and the node takes no sign-in from them. */
    const homeWord = (over: Partial<{ words: boolean; door: boolean; kept: boolean }> = {}) => ({
        url: OTHER, standing: { words: true, joinedAt: SIGNED_UP, door: false, kept: false, ...over },
    });
    async function drawCard(place: 'landing' | 'settings', word = homeWord()) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(OneWayBackCard, { place, homeWord: word }) as unknown as Parameters<Root['render']>[0]); });
        await settle();
    }
    const again = async (place: 'landing' | 'settings' = 'landing', word = homeWord()) => {
        act(() => root?.unmount());
        host?.remove();
        await drawCard(place, word);
    };
    const short = () => text().includes('Your 12 words are how you get back in. Check you still have them.');
    const posted = async (yes: boolean) => {
        const db = await import('../db');
        (db.getMyPosts as ReturnType<typeof vi.fn>).mockResolvedValue(yes ? [{ id: 'p1' }] : []);
    };

    beforeEach(async () => {
        mem.anchor = OTHER;
        kept.length = 0;
        await posted(false);
        const nodeFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url: any, init?: any) => {
            const u = new URL(String(url));
            if (u.pathname === '/api/members/preferences' && init?.method === 'POST') {
                kept.push(JSON.parse(String(init.body)).preferences);
                return new Response(JSON.stringify({}), { status: 200 });
            }
            return (nodeFetch as any)(url, init);
        }) as any;
        // The invite sign-up's end (app/welcome.tsx): the reminder starts put away.
        await startOneWayBackPutAway(who.identity.publicKey, OTHER, SIGNED_UP);
    });

    it('day one: no card on Home, the record is put away and only Home\'s word moves it (/api/community/me is never asked)', async () => {
        await drawCard('landing');
        expect(short()).toBe(false);
        expect(warning()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ url: OTHER, by: 'wayBack', dismissedAt: SIGNED_UP });
        expect(node.asks).toBe(0);
    });

    it('after the first post: the card once, with its own words, no "Add a sign-in", and Show my 12 words / I still have my 12 words', async () => {
        await posted(true);
        vi.setSystemTime(SIGNED_UP + 2 * 3600_000);
        await drawCard('landing');
        expect(short()).toBe(true);
        expect(warning()).toBe(false);
        // The card's name for TalkBack says the same, not "one way back" (review of #3113, §2.5).
        const labels = Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'));
        expect(labels).toContain('Your 12 words are how you get back in. Check you still have them.');
        expect(labels.join('\n')).not.toContain('one way back');
        expect(text()).not.toContain('Add a sign-in');
        expect(text()).toContain('Show my 12 words');
        expect(text()).toContain('I still have my 12 words');
        await act(async () => { button('✕').click(); });
        await settle();
        expect(short()).toBe(false);
        await again();
        expect(short()).toBe(false);
        expect(node.asks).toBe(0);
    });

    it('after a week: once more; then Settings only', async () => {
        vi.setSystemTime(SIGNED_UP + 8 * 24 * 3600_000);
        await drawCard('landing');
        expect(short()).toBe(true);
        await act(async () => { button('✕').click(); });
        await settle();
        await again();
        expect(short()).toBe(false);
        vi.setSystemTime(SIGNED_UP + 40 * 24 * 3600_000);
        await again();
        expect(short()).toBe(false);
        await again('settings');
        expect(short()).toBe(true);
        expect(text()).not.toContain('Add a sign-in');
    });

    it('"I still have my 12 words" is kept on the account (words_kept), and the card is done on this phone', async () => {
        await posted(true);
        await drawCard('landing');
        await act(async () => { button('I still have my 12 words').click(); });
        await settle();
        expect(kept).toEqual([{ words_kept: true }]);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
        expect(short()).toBe(false);
    });

    it('said on another device (Home\'s word kept) or a sign-in linked there (wayBack covered): done here too', async () => {
        await posted(true);
        await drawCard('landing', homeWord({ kept: true }));
        expect(short()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
        mem.async.clear();
        await startOneWayBackPutAway(who.identity.publicKey, OTHER, SIGNED_UP);
        await again('landing', homeWord({ words: false }));
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'linked' });
    });

    it('a say-so on another device that lands while the card is up ends it on this visit, with no new focus (review of #3113)', async () => {
        await posted(true);
        await drawCard('landing');
        expect(short()).toBe(true);
        // Home's network answer replaces its stored copy: the same community, `words` still true, `kept` now true.
        const runs = focus.run;
        await act(async () => {
            root!.render(createElement(OneWayBackCard, { place: 'landing', homeWord: homeWord({ kept: true }) }) as unknown as Parameters<Root['render']>[0]);
        });
        await settle();
        expect(focus.run, 'no new focus: only the word changed').toBe(runs);
        expect(short()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
    });

    it('no record on this phone (signed up elsewhere): Home\'s word starts it put away at the join date, never at once', async () => {
        mem.async.clear();
        await drawCard('landing');
        expect(short()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ url: OTHER, by: 'wayBack', joinedAt: SIGNED_UP, dismissedAt: SIGNED_UP });
    });

    it('where the node takes a sign-in from them (Home\'s safety card: the 12-words door), the door\'s card and Add a sign-in, as decided', async () => {
        mem.async.clear();
        await startOneWayBack(who.identity.publicKey, OTHER, SIGNED_UP);
        await drawCard('landing', homeWord({ door: true }));
        expect(warning()).toBe(true);
        expect(text()).toContain('Add a sign-in');
        expect(Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'))).toContain('Your account has one way back');
    });
});
