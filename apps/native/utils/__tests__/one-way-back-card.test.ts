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
vi.mock('../vault', () => ({ vaultSignInCopyKnown: vi.fn(async (publicKey: string) => mem.vault.has(publicKey)) }));
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
import { wordsWrittenDownStoreKey } from '../storage-keys';
import { vaultSignInCopyKnown } from '../vault';

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
// showing: day one is First steps' line only. Then core's schedule (slice B1 of DESIGN-notify-and-backup-asks-fable-amend2.md
// §12.3, Marty's pick 10 of 21 Nov 2026): once at the first Beans, with the fact; once 30 days after joining; then every 90
// days while there is something to lose. Where the node takes no sign-in from them (review of #3110, round 2: `linkState`
// refuses an invited member), the card offers none.
describe('an invite sign-up that carried on: no card on day one, then the first Beans, 30 days, and every 90 days while there is something to lose', () => {
    const SIGNED_UP = Date.parse('2026-10-02T08:00:00Z');
    const DAY = 24 * 3600_000;
    const kept: unknown[] = [];
    /** Home's word for an invited member with no sign-in: the words are the only way back, and the node takes no sign-in from them. */
    const homeWord = (over: Partial<{ words: boolean; door: boolean; kept: boolean }> = {}) => ({
        url: OTHER, standing: { words: true, joinedAt: SIGNED_UP, door: false, kept: false, ...over },
    });
    type ToLose = { balance_c: number | null; holds: boolean };
    async function drawCard(place: 'landing' | 'settings', word = homeWord(), toLose?: ToLose) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(OneWayBackCard, { place, homeWord: word, toLose }) as unknown as Parameters<Root['render']>[0]); });
        await settle();
    }
    const again = async (place: 'landing' | 'settings' = 'landing', word = homeWord(), toLose?: ToLose) => {
        act(() => root?.unmount());
        host?.remove();
        await drawCard(place, word, toLose);
    };
    /** The card's one sentence (core WAY_BACK_WORDS.line), the same on every card since B1. */
    const short = () => text().includes(ONE_WAY_BACK_TEXT.body);
    const FACT = "You have 40 Beans here now. Keep a way back in, so they don't go with a lost phone.";
    const fact = () => text().includes(FACT);
    const posted = async (posts: { id: string; status?: string }[]) => {
        const db = await import('../db');
        (db.getMyPosts as ReturnType<typeof vi.fn>).mockResolvedValue(posts);
    };

    beforeEach(async () => {
        mem.anchor = OTHER;
        kept.length = 0;
        await posted([]);
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
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ url: OTHER, by: 'wayBack', dismissedAt: SIGNED_UP });
        expect(node.asks).toBe(0);
    });

    it('a first post no longer brings it (1.4.7 did); the first Beans do, once, with the fact, no "Add a sign-in", and Show my 12 words / I still have my 12 words', async () => {
        await posted([{ id: 'p1' }]);
        vi.setSystemTime(SIGNED_UP + 2 * 3600_000);
        await drawCard('landing');
        expect(short()).toBe(false);
        // Home's answer says 40 Beans: the record keeps when they were first seen, and the card comes with the fact.
        await again('landing', homeWord(), { balance_c: 4000, holds: false });
        expect(fact()).toBe(true);
        expect(short()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ beansAt: SIGNED_UP + 2 * 3600_000 });
        // The card's name for TalkBack says the same, never "one way back".
        const labels = Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'));
        expect(labels).toContain(FACT);
        expect(labels.join('\n')).not.toContain('one way back');
        expect(text()).not.toContain('Add a sign-in');
        expect(text()).toContain('Show my 12 words');
        expect(text()).toContain('I still have my 12 words');
        await act(async () => { button('✕').click(); });
        await settle();
        expect(fact()).toBe(false);
        await again('landing', homeWord(), { balance_c: 4000, holds: false });
        expect(fact() || short()).toBe(false);
        expect(node.asks).toBe(0);
    });

    it('30 days after joining: once more, nothing to lose needed; then every 90 days only while there is something to lose', async () => {
        vi.setSystemTime(SIGNED_UP + 30 * DAY - 60_000);
        await drawCard('landing');
        expect(short()).toBe(false);
        vi.setSystemTime(SIGNED_UP + 30 * DAY);
        await again();
        expect(short()).toBe(true);
        await act(async () => { button('✕').click(); });
        await settle();
        await again();
        expect(short()).toBe(false);
        // 90 days on with nothing to lose: stays away; Settings still has it.
        vi.setSystemTime(SIGNED_UP + 121 * DAY);
        await again();
        expect(short()).toBe(false);
        await again('settings');
        expect(short()).toBe(true);
        expect(text()).not.toContain('Add a sign-in');
        // A live listing of theirs on this phone: something to lose, so it is back.
        await posted([{ id: 'p1', status: 'active' }]);
        await again();
        expect(short()).toBe(true);
        await act(async () => { button('✕').click(); });
        await settle();
        // An open deal or a role, from Home: back again 90 days after that ✕, not before.
        await posted([]);
        vi.setSystemTime(SIGNED_UP + 210 * DAY);
        await again('landing', homeWord(), { balance_c: 0, holds: true });
        expect(short()).toBe(false);
        vi.setSystemTime(SIGNED_UP + 211 * DAY);
        await again('landing', homeWord(), { balance_c: 0, holds: true });
        expect(short()).toBe(true);
    });

    it('a way back kept is never reminded: the words said written down in Ways back, with Beans and 400 days gone', async () => {
        mem.async.set(wordsWrittenDownStoreKey(who.identity.publicKey), '1');
        vi.setSystemTime(SIGNED_UP + 400 * DAY);
        await drawCard('landing', homeWord(), { balance_c: 4000, holds: true });
        expect(short() || fact()).toBe(false);
        // Control: taken back in Ways back, the card is due again.
        mem.async.set(wordsWrittenDownStoreKey(who.identity.publicKey), '0');
        await again('landing', homeWord(), { balance_c: 4000, holds: true });
        expect(short() || fact()).toBe(true);
    });

    it('"I still have my 12 words" is kept on the account (words_kept), and the card is done on this phone', async () => {
        vi.setSystemTime(SIGNED_UP + 30 * DAY);
        await drawCard('landing');
        expect(short()).toBe(true);
        await act(async () => { button('I still have my 12 words').click(); });
        await settle();
        expect(kept).toEqual([{ words_kept: true }]);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
        expect(short()).toBe(false);
    });

    it('said on another device (Home\'s word kept) or a sign-in linked there (wayBack covered): done here too', async () => {
        vi.setSystemTime(SIGNED_UP + 30 * DAY);
        await drawCard('landing', homeWord({ kept: true }));
        expect(short()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
        mem.async.clear();
        await startOneWayBackPutAway(who.identity.publicKey, OTHER, SIGNED_UP);
        await again('landing', homeWord({ words: false }));
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'linked' });
    });

    it('a say-so on another device that lands while the card is up ends it on this visit, with no new focus (review of #3113)', async () => {
        vi.setSystemTime(SIGNED_UP + 30 * DAY);
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

    // The parity read of D2 against D3 (rows 9 and 10): "I still have my 12 words" on the door's own Home card, as the web's
    // has it. Since B1 every card says the one sentence, "If this phone is lost, this is how you get back in." (true on every
    // door, the first design §5.1), and never "one way back".
    it('the 12-words door of a local community (Home\'s safety card): Add a sign-in, I still have my 12 words, and the one sentence', async () => {
        mem.async.clear();
        await startOneWayBack(who.identity.publicKey, OTHER, SIGNED_UP);
        await drawCard('landing', homeWord({ door: true }));
        expect(short()).toBe(true);
        const labels = Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'));
        expect(labels).toContain(ONE_WAY_BACK_TEXT.body);
        expect(labels.join('\n')).not.toContain('one way back');
        expect(text()).toContain('Add a sign-in');
        expect(text()).toContain('I still have my 12 words');
        expect(text()).toContain('Show my 12 words');
    });

    it('the global community\'s door: the one sentence, its name for TalkBack the same, with I still have my 12 words beside the sign-in', async () => {
        mem.async.clear();
        mem.anchor = GLOBAL;
        await startOneWayBack(who.identity.publicKey, GLOBAL, SIGNED_UP);
        await drawCard('landing', { url: GLOBAL, standing: { words: true, joinedAt: SIGNED_UP, door: true, kept: false } });
        expect(warning()).toBe(true);
        expect(Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'))).toContain(ONE_WAY_BACK_TEXT.body);
        expect(text()).toContain('Add a sign-in');
        await act(async () => { button('I still have my 12 words').click(); });
        await settle();
        expect(kept).toEqual([{ words_kept: true }]);
        expect(await readOneWayBack(who.identity.publicKey)).toMatchObject({ done: 'checked' });
        expect(warning()).toBe(false);
    });
});

// Review of #3348, finding 1: Home's notifications card waits for this card's word that it settled, on Home's landing. The word
// comes only once the card's NEWEST read has ended on that landing's own answer of Home, after `onUp` has said what it found;
// a read a newer one replaced says nothing, and each read that starts says "deciding again" (null).
describe("the card's word to Home: settled on the landing's own answer, after its newest read (review of #3348)", () => {
    const SIGNED_UP = Date.parse('2026-10-02T08:00:00Z');
    const homeWord = { url: OTHER, standing: { words: true, joinedAt: SIGNED_UP, door: false, kept: false } };
    /** What the card said to Home, in order: `up:true|false` (onUp) and `settled:<landing>|null` (onSettled). */
    const said: string[] = [];
    function draw(balance_c: number, settleFor: number | null) {
        const el = createElement(OneWayBackCard, {
            place: 'landing', homeWord, toLose: { balance_c, holds: false }, settleFor,
            onUp: (up: boolean) => said.push(`up:${up}`), onSettled: (n: number | null) => said.push(`settled:${n}`),
        });
        return act(async () => { root!.render(el as unknown as Parameters<Root['render']>[0]); });
    }
    /** A read of the card held until the test lets it go: the vault's answer is one of the reads it waits on together. */
    function holdNextRead(): () => void {
        let go!: () => void;
        const gate = new Promise<void>((r) => { go = r; });
        vi.mocked(vaultSignInCopyKnown).mockImplementationOnce(async () => { await gate; return false; });
        return go;
    }
    const settledAt = (n: number) => said.indexOf(`settled:${n}`);
    const landingsSettled = () => said.filter(w => w.startsWith('settled:') && w !== 'settled:null');

    beforeEach(async () => {
        said.length = 0;
        mem.anchor = OTHER;
        // An invite sign-up two hours in: the card is put away until the first Beans (core's schedule).
        await startOneWayBackPutAway(who.identity.publicKey, OTHER, SIGNED_UP);
        vi.setSystemTime(SIGNED_UP + 2 * 3600_000);
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    it('no landing answer yet (settleFor null): its read ends and it says nothing settled', async () => {
        await draw(0, null);
        await settle();
        expect(said).toContain('up:false');
        expect(landingsSettled()).toEqual([]);
    });

    it("first Beans arrive in the landing's own answer, in the same frame as the landing: up first, settled after, never settled while down", async () => {
        await draw(0, null);
        await settle();
        said.length = 0;
        // Home's answer with the first Beans and the landing's end, together (the card reads again for the Beans).
        await draw(4000, 1);
        await settle();
        expect(said).toContain('up:true');
        expect(settledAt(1)).toBeGreaterThan(said.indexOf('up:true'));
        expect(said.slice(0, settledAt(1))).toContain('settled:null');
    });

    it('a read a newer one replaced says nothing; only the newest read, when it ends, settles the landing', async () => {
        const first = holdNextRead();
        await draw(0, 1);
        await settle();
        expect(settledAt(1)).toBe(-1);
        // Home's answer brings the first Beans while the landing's read is out: a second read starts and is held too.
        const second = holdNextRead();
        await draw(4000, 1);
        await settle();
        // The first read ends: replaced, it decides nothing.
        first();
        await settle();
        expect(settledAt(1)).toBe(-1);
        expect(said).not.toContain('up:true');
        // The newest read ends: up, then settled.
        second();
        await settle();
        expect(said).toContain('up:true');
        expect(settledAt(1)).toBeGreaterThan(said.indexOf('up:true'));
    });

    it("a landing it settled on, then a new one: it settles the new one only once that landing's answer is in", async () => {
        await draw(0, 1);
        await settle();
        expect(settledAt(1)).toBeGreaterThan(-1);
        said.length = 0;
        // Home lands again: its answer is not in yet (null), then it is (2).
        await draw(0, null);
        await settle();
        expect(landingsSettled()).toEqual([]);
        await draw(0, 2);
        await settle();
        expect(said).toEqual(['settled:2']);
    });
});
