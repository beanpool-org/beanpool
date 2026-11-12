// @vitest-environment jsdom
/**
 * A community's card screen (app/community-card.tsx, front doors S15) for a member of another community who has asked
 * this one to join: rendered for real, with the real knock memory and status read (utils/knock.ts), so each state is
 * reached the way a phone reaches it: by what the phone remembers and what the community answers. The card says what Find
 * a community says (app/find-community.tsx stateFor, utils/knock.ts knockCardState):
 *   - pending: waiting, and no Ask to join;
 *   - approved: invited, and Join with the invite it sent;
 *   - none (it lapsed, or a no, which a community answers the same way): no answer came, and Ask to join again;
 *   - cancelled within the day: said so, and no Ask to join until it may be asked again;
 *   - unreachable: said so, and Check again.
 * Before PR #2551's review, the screen showed "waiting" for any remembered request, whatever the community answered, and
 * read no cancel: the approved, none and cancelled tests here fail there.
 *
 * And the card is a claim (PR #2551's second review): a link may name any server, which may say it is any community. The
 * screen shows the host it read the card from, and a card that names another host loses its name: the "names another
 * host" tests fail before (the server's chosen name, no host shown).
 *
 * And a phone waiting to be let in (an account, no community: slice S3, PR #2604's review) can open a card: its yes goes to
 * welcome, so the 12 words its key has never shown come next, and its request, like any from the card, says it came from
 * global only from a member there. The waiting and "no fromNode" tests fail before (joined here; "global.beanpool.org").
 *
 * Nothing is contacted: fetch plays the one community (its card, and this key's knock status).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screen doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

/** React Native's AppState, a switch the test turns (foreground / background), with the screens listening to it. */
const appState = vi.hoisted(() => ({ now: 'active', listeners: new Set<(s: string) => void>() }));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID, accessibilityRole, accessibilityLabel, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (disabled) attrs['data-disabled'] = 'true';
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityRole === 'button') attrs.role = 'button';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), ActivityIndicator: el('progress'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (...a: unknown[]) => alerts.push(a) },
        Linking: { openURL: async () => {} },
        AppState: {
            get currentState() { return appState.now; },
            addEventListener: (_type: string, cb: (s: string) => void) => {
                appState.listeners.add(cb);
                return { remove() { appState.listeners.delete(cb); } };
            },
        },
    };
});
const alerts = vi.hoisted(() => [] as unknown[][]);
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const ORIGIN = 'https://riverside.example';
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], replaced: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.replaced.push(to), back() {}, canGoBack: () => true },
    useLocalSearchParams: () => ({ node: 'https://riverside.example' }),
    // Never focused or blurred here: the screen stays shown.
    useFocusEffect: () => {},
    ErrorBoundary: () => null,
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }) };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
const KEY = 'c'.repeat(64);
/** The key a phone with no account drafts when the card's form opens (utils/knock-key.ts). */
const DRAFT = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: '', createdAt: '2026-11-09T00:00:00.000Z', mnemonic: Array(12).fill('word') };
const DEFAULT_IDENTITY = { publicKey: KEY, privateKey: 'd'.repeat(64), callsign: 'Damo' };
let currentIdentity: typeof DEFAULT_IDENTITY | null = DEFAULT_IDENTITY;
/** The app's account (app/IdentityContext.tsx): what the screen reads, and every account it hands the app. */
const ids = vi.hoisted(() => ({ listeners: new Set<() => void>(), set: [] as unknown[] }));
vi.mock('../../app/IdentityContext', async () => {
    const { useSyncExternalStore } = await import('react');
    const subscribe = (l: () => void) => { ids.listeners.add(l); return () => { ids.listeners.delete(l); }; };
    return {
        useIdentity: () => ({
            identity: useSyncExternalStore(subscribe, () => currentIdentity),
            setIdentity: (identity: typeof DEFAULT_IDENTITY) => { ids.set.push(identity); currentIdentity = identity; ids.listeners.forEach((l) => l()); },
        }),
    };
});
/**
 * The phone's key store, under the real utils/knock-key.ts (a phone with no account, shared-listing door A2): what each
 * read of it finds, in order (then `stored`), every key written to it, and how many keys were drafted.
 */
const phoneKey = vi.hoisted(() => ({ reads: [] as unknown[], stored: null as unknown, written: [] as unknown[], drafts: 0 }));
vi.mock('../identity', () => ({
    loadIdentity: async () => (phoneKey.reads.length ? phoneKey.reads.shift() : phoneKey.stored),
    importIdentity: async (identity: unknown) => { phoneKey.written.push(identity); phoneKey.stored = identity; },
    draftIdentity: async () => { phoneKey.drafts++; return { ...DRAFT }; },
}));
const dbRow = vi.hoisted(() => ({ profile: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async () => dbRow.profile),
}));
// The key a request is signed with rides in a test header, so a test can say which key signed it.
vi.mock('../crypto', () => ({
    buildSignedHeaders: async (_m: string, _u: string, _b: string, _priv: string, publicKey: string) => ({ 'X-Test-Signed': '1', 'X-Test-Key': publicKey }),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: async () => 'bundled://phone-wide' }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: async () => {} }));
// The join itself (utils/join-another-community.ts) is Find a community's; here, only that the card hands it the invite.
const joins = vi.hoisted(() => [] as Array<{ targetUrl: string; code: string; knownName?: string | null }>);
vi.mock('../join-another-community', () => ({
    joinAnotherCommunity: async (opts: { targetUrl: string; code: string; knownName?: string | null }) => { joins.push(opts); return { name: 'Riverside' }; },
    joinedNudge: (name: string) => ({ title: `You're in ${name}`, body: 'b', later: 'Next' }),
    PROTECT_REDIRECT: '/(tabs)/settings?section=protection',
    HOME_REDIRECT: '/(tabs)',
}));

import CommunityCardScreen from '../../app/community-card';
import { KNOCKS_STORE_KEY, KNOCK_KEY_STORE_KEY } from '../storage-keys';
import { takeKnockYes } from '../waiting-to-join';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { setLanguage } from '@beanpool/core';

type Answer = { status: 'pending' } | { status: 'none' } | { status: 'approved'; invite: string } | 'offline';
const scene = {
    answer: { status: 'pending' } as Answer, statusReads: 0, knocks: 0, sent: [] as Record<string, unknown>[], card: null as Record<string, unknown> | null,
    /** The key each request to join was signed with; and what the community answers one (201 by default). */
    signers: [] as Array<string | null>, knockAnswer: null as null | { status: number; body: Record<string, unknown> },
    // The community's rule (GET /api/community/known-rule): null is an older node's 404.
    rule: { known: false } as Record<string, unknown> | null,
    /** When set, a status read waits for it: a slow phone's read still out. */
    gate: null as Promise<void> | null,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CARD = { name: 'Riverside', host: 'riverside.example', members: null, area: null, joining: 'requests', askUrl: null, globalUrl: null };

function remember(knock: { sentAt?: string; cancelledAt?: string } = {}): void {
    store.map.set(KNOCKS_STORE_KEY, JSON.stringify({
        pubkey: KEY,
        knocks: [{ url: ORIGIN, name: 'Riverside', key: null, sentAt: knock.sentAt ?? new Date().toISOString(), ...(knock.cancelledAt ? { cancelledAt: knock.cancelledAt } : {}) }],
    }));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    currentIdentity = DEFAULT_IDENTITY;
    dbRow.profile = null;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://home.example');
    nav.pushed.length = 0;
    nav.replaced.length = 0;
    alerts.length = 0;
    joins.length = 0;
    scene.answer = { status: 'pending' };
    appState.now = 'active'; appState.listeners.clear();
    scene.statusReads = 0;
    scene.knocks = 0;
    scene.sent = [];
    scene.card = null;
    scene.rule = { known: false };
    scene.signers = [];
    scene.knockAnswer = null;
    scene.gate = null;
    ids.set.length = 0;
    phoneKey.reads = []; phoneKey.stored = null; phoneKey.written = []; phoneKey.drafts = 0;
    setLanguage('en');
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        const u = String(input);
        if (u === `${ORIGIN}/api/community/card`) return json(scene.card ?? CARD);
        if (u === `${ORIGIN}/api/community/known-rule`) return scene.rule ? json(scene.rule) : json({ error: 'Not found' }, 404);
        if (u === `${ORIGIN}/api/join/knock/status`) {
            scene.statusReads++;
            if (scene.gate) await scene.gate;
            if (scene.answer === 'offline') throw new TypeError('Network request failed');
            return json(scene.answer);
        }
        if (u === `${ORIGIN}/api/join/knock` && init?.method === 'POST') {
            scene.knocks++;
            scene.sent.push(JSON.parse(String(init.body)));
            scene.signers.push((init.headers as Record<string, string> | undefined)?.['X-Test-Key'] ?? null);
            if (scene.knockAnswer) return json(scene.knockAnswer.body, scene.knockAnswer.status);
            return json({ knock: { status: 'pending' } }, 201);
        }
        throw new TypeError(`Network request failed: ${u}`);
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
async function open(): Promise<void> {
    await act(async () => { root.render(createElement(CommunityCardScreen) as any); });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const asked = () => byTestId('community-card-asked')?.textContent ?? null;
const buttons = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '');
async function tap(el: HTMLElement | null): Promise<void> {
    expect(el, 'the button is there').not.toBeNull();
    await act(async () => { el!.click(); });
    await settle();
}

describe("a member's request to join, on the community's card", () => {
    it('pending: waiting for an answer, and no Ask to join', async () => {
        remember();
        await open();
        expect(byTestId('community-card')).not.toBeNull();
        expect(asked()).toBe('You asked to join. No answer yet: communities usually answer within a few days.');
        expect(byTestId('community-card-ask')).toBeNull();
        expect(byTestId('community-card-join')).toBeNull();
        expect(scene.statusReads).toBe(1);
    });

    it('approved: invited, and Join hands the invite it sent to the join (fails before: read "waiting", no Join)', async () => {
        remember();
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await open();
        expect(asked()).toBe('A member invited you. Join now to become a member.');
        expect(byTestId('community-card-ask')).toBeNull();
        expect(byTestId('community-card-join')?.textContent).toBe('Join Riverside');
        await tap(byTestId('community-card-join'));
        expect(joins).toEqual([expect.objectContaining({ targetUrl: ORIGIN, code: 'BP-RIVR-0001', knownName: 'Riverside' })]);
        // The knock is done with: the phone forgets it, and the member is told they're in.
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!).knocks).toEqual([]);
        expect(alerts[0]?.[0]).toBe("You're in Riverside");
    });

    it('none (it lapsed, or a no): the request is no longer open, and Ask to join again (fails before: read "waiting", no Ask)', async () => {
        remember();
        scene.answer = { status: 'none' };
        await open();
        expect(asked()).toBe('This request is no longer open. You can ask again.');
        expect(byTestId('community-card-ask')).not.toBeNull();
    });

    it('asked again after a closed request: while the new answer is read, never the old "no longer open" nor a second Ask', async () => {
        remember();
        scene.answer = { status: 'none' };
        await open();
        expect(asked()).toBe('This request is no longer open. You can ask again.');
        await tap(byTestId('community-card-ask'));
        const message = host.querySelectorAll('input')[1] as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(message, 'Asking again.');
            message.dispatchEvent(new Event('input', { bubbles: true }));
        });
        let release!: () => void;
        scene.gate = new Promise<void>((r) => { release = r; });
        scene.answer = { status: 'pending' };
        await tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLElement);
        expect(scene.knocks).toBe(1);
        // The read is out (review of 22327049): the card must not show the earlier request's line or offer Ask again.
        expect(asked()).not.toBe('This request is no longer open. You can ask again.');
        expect(byTestId('community-card-ask')).toBeNull();
        await act(async () => { release(); });
        await settle();
        expect(asked()).toBe('You asked to join. No answer yet: communities usually answer within a few days.');
    });

    it('cancelled within the day: said so, no Ask to join, and nothing read from the community (fails before: Ask offered)', async () => {
        const now = Date.now();
        remember({ sentAt: new Date(now - 3_600_000).toISOString(), cancelledAt: new Date(now - 60_000).toISOString() });
        await open();
        expect(asked()).toBe('You cancelled your request. You can ask again after 24 hours.');
        expect(byTestId('community-card-ask')).toBeNull();
        expect(scene.statusReads).toBe(0);
    });

    it('unreachable: said so, and Check again reads the answer again', async () => {
        remember();
        scene.answer = 'offline';
        await open();
        expect(asked()).toBe("Couldn't reach this community. Check your connection and try again.");
        expect(byTestId('community-card-ask')).toBeNull();
        scene.answer = { status: 'pending' };
        await tap(byTestId('community-card-check-again'));
        expect(scene.statusReads).toBe(2);
        expect(asked()).toBe('You asked to join. No answer yet: communities usually answer within a few days.');
    });

    it('never asked: Ask to join, and no signed read of its status (a read shows the community who is asking)', async () => {
        await open();
        expect(asked()).toBeNull();
        expect(byTestId('community-card-ask')).not.toBeNull();
        expect(scene.statusReads).toBe(0);
    });

    it('asked from the card: the request is remembered and what the community says now is shown', async () => {
        scene.answer = { status: 'pending' };
        await open();
        await tap(byTestId('community-card-ask'));
        const message = host.querySelectorAll('input')[1] as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(message, 'I live by the river and grow tomatoes.');
            message.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLElement);
        expect(scene.knocks).toBe(1);
        expect(scene.statusReads).toBe(1);
        expect(asked()).toBe('You asked to join. No answer yet: communities usually answer within a few days.');
        // The button says whom it asks (shared-listing door A2: the web's words), and it is gone once asked.
        expect(buttons().filter((b) => b.startsWith('Ask to join'))).toEqual([]);
        // Profile S2-W: sends this community's photo (or none), never the phone-wide canonical copy.
        expect('avatar' in scene.sent[0]).toBe(false);
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!).knocks.map((k: { url: string }) => k.url)).toEqual([ORIGIN]);
    });

    it("does not send this community's photo with the knock even when this community's row holds one", async () => {
        dbRow.profile = { avatar_url: 'bundled://fox' };
        scene.answer = { status: 'pending' };
        await open();
        await tap(byTestId('community-card-ask'));
        const message = host.querySelectorAll('input')[1] as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(message, 'Hello from this community.');
            message.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLElement);
        expect(scene.knocks).toBe(1);
        expect('avatar' in scene.sent[0]).toBe(false);
    });
});

describe('the card is what the server it was read from claims', () => {
    const name = () => byTestId('community-card-name')?.textContent ?? null;
    const shownHost = () => byTestId('community-card-host')?.textContent ?? null;
    // A link names riverside.example, whose card says it is another community.
    const POSING = { ...CARD, name: 'Mullum Community', host: 'mullum.beanpool.org' };

    it("its own host: the community's name, and under it the host the card was read from", async () => {
        await open();
        expect(name()).toBe('Riverside');
        expect(shownHost()).toBe('riverside.example');
    });

    it("its own host, no name of its own: the host is the name, said once", async () => {
        scene.card = { ...CARD, name: null };
        await open();
        expect(name()).toBe('riverside.example');
        expect(shownHost()).toBeNull();
    });

    it("names another host: its name is dropped and the host it was read from is the name (fails before: 'Mullum Community', no host)", async () => {
        scene.card = POSING;
        await open();
        expect(name()).toBe('riverside.example');
        expect(host.textContent).not.toContain('Mullum');
        expect(host.textContent).not.toContain('mullum.beanpool.org');
    });

    it('names no host: its name, with the host it was read from under it', async () => {
        scene.card = { ...CARD, name: 'Mullum Community', host: null };
        await open();
        expect(name()).toBe('Mullum Community');
        expect(shownHost()).toBe('riverside.example');
    });

    it('names another host: a request to it is remembered by its host, never by the name it claimed', async () => {
        scene.card = POSING;
        await open();
        await tap(byTestId('community-card-ask'));
        const message = host.querySelectorAll('input')[1] as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(message, 'I live by the river and grow tomatoes.');
            message.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLElement);
        expect(scene.knocks).toBe(1);
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!).knocks).toEqual([expect.objectContaining({ url: ORIGIN, name: null })]);
    });

    it("names another host: Join says the host, and the join is told no name of the card's", async () => {
        remember();
        scene.card = POSING;
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await open();
        expect(byTestId('community-card-join')?.textContent).toBe('Join riverside.example');
        await tap(byTestId('community-card-join'));
        expect(joins).toEqual([expect.objectContaining({ targetUrl: ORIGIN, code: 'BP-RIVR-0001', knownName: null })]);
    });

    it('the host is matched as the phone reads one: case and a :443 make no other host', async () => {
        scene.card = { ...CARD, host: 'Riverside.Example:443' };
        await open();
        expect(name()).toBe('Riverside');
        expect(shownHost()).toBe('riverside.example');
    });
});

/** Ask to join from the card, with a message, and Send. */
async function askFromCard(): Promise<void> {
    await tap(byTestId('community-card-ask'));
    const message = host.querySelectorAll('input')[1] as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(message, 'I live by the river and grow tomatoes.');
        message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLElement);
}

// A phone with an account and no community (slice S3: its key was made by a knock, so its 12 words have never been shown)
// can open a community's card. Its yes is joined where the words are shown, and its request names no community it came from.
describe('a phone waiting to be let in (an account, no community), on the card', () => {
    beforeEach(() => { store.map.delete('beanpool_anchor_url'); takeKnockYes(KEY); });

    it("a yes: Join hands it to welcome, whose invite step goes on to the 12 words; the card joins nothing itself (fails before: joined here, told its words came with it)", async () => {
        remember();
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await open();
        expect(byTestId('community-card-join')?.textContent).toBe('Join Riverside');
        await tap(byTestId('community-card-join'));
        expect(joins).toEqual([]);
        expect(alerts).toEqual([]);
        expect(nav.replaced).toEqual(['/welcome']);
        expect(takeKnockYes(KEY)).toEqual({ url: ORIGIN, invite: 'BP-RIVR-0001', name: 'Riverside' });
        // Welcome forgets the request once its redeem lands, as for a yes from Find a community.
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!).knocks.map((k: { url: string }) => k.url)).toEqual([ORIGIN]);
    });

    it("a yes on a card that names another host: handed over with no name of the card's", async () => {
        remember();
        scene.card = { ...CARD, name: 'Mullum Community', host: 'mullum.beanpool.org' };
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await open();
        await tap(byTestId('community-card-join'));
        expect(joins).toEqual([]);
        expect(takeKnockYes(KEY)).toEqual({ url: ORIGIN, invite: 'BP-RIVR-0001', name: null });
    });

    it('asked from the card: the request names no community it came from (fails before: "global.beanpool.org")', async () => {
        await open();
        await askFromCard();
        expect(scene.knocks).toBe(1);
        expect(scene.sent[0]).toEqual(expect.objectContaining({ callsign: 'Damo', toNode: 'riverside.example' }));
        expect('fromNode' in scene.sent[0]).toBe(false);
    });
});

describe("what a request from the card says it came from, as Find a community says it (utils/knock-address.ts knockFromNode)", () => {
    it('a member of the global community: global.beanpool.org', async () => {
        store.map.set('beanpool_anchor_url', GLOBAL_NODE_URL);
        await open();
        await askFromCard();
        expect(scene.sent[0]?.fromNode).toBe('global.beanpool.org');
    });

    it('a guest looking around global, with an account elsewhere: no fromNode', async () => {
        store.map.set('beanpool_anchor_url', GLOBAL_NODE_URL);
        store.map.set('beanpool_guest_nodes', JSON.stringify([GLOBAL_NODE_URL]));
        await open();
        await askFromCard();
        expect(scene.knocks).toBe(1);
        expect('fromNode' in scene.sent[0]).toBe(false);
    });

    it('a member of a local community: no fromNode (fails before: "global.beanpool.org")', async () => {
        await open();
        await askFromCard();
        expect(scene.knocks).toBe(1);
        expect('fromNode' in scene.sent[0]).toBe(false);
    });
});

/**
 * Ask to join on a phone with no account (DESIGN-shared-listing-door-fable.md §2.3, the phone row; slice A2): the card asks
 * the community itself, here, as Find a community asks with no account (utils/knock-key.ts): the key is drafted in memory
 * when the form opens, written to the phone only when Send is tapped, and the phone then waits on welcome, whose waiting
 * mode joins a yes through the invite step and shows the 12 words (welcome-waiting-render.test.ts 2,
 * knock-without-account.test.ts). The real utils/knock-key.ts runs, over the phone's key store above.
 * Before A2, Ask to join left the card for the first screen, where the person had to find "Know a community near you?" and
 * type the address again: the "form here", "Send" and "words" tests fail there.
 */
describe('the card with no account on the phone (shared-listing door A2)', () => {
    beforeEach(() => {
        currentIdentity = null;
        store.map.delete('beanpool_anchor_url');
    });

    const field = (label: string) => Array.from(host.querySelectorAll('input')).find((i) => i.getAttribute('aria-label') === label) as HTMLInputElement | undefined;
    async function fill(label: string, value: string): Promise<void> {
        const input = field(label);
        expect(input, `a field "${label}"`).toBeTruthy();
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    const press = (text: string) => tap(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null);
    /** Ask to join, the name and a few words, and Send. */
    async function askWithNoAccount(callsign = 'River Kid'): Promise<void> {
        await tap(byTestId('community-card-ask'));
        await fill('Your name', callsign);
        await fill('A few words about yourself', 'I live by the river and grow tomatoes.');
        await press('Send');
    }
    const KIM = { publicKey: 'ef'.repeat(32), privateKey: '01'.repeat(32), callsign: 'Kim', createdAt: '2026-11-09', mnemonic: Array(12).fill('word') };

    it('never sends a stranger to join the global community first (shared-listing door A1: the note is gone)', async () => {
        await open();
        expect(byTestId('community-card-needs-account')).toBeNull();
        expect(host.textContent).not.toContain('Look around global first');
        expect(byTestId('community-card-ask')).not.toBeNull();
        expect(host.textContent).not.toContain('Explore BeanPool worldwide');
        expect(host.textContent).not.toContain('To ask, you need a BeanPool account first');
        expect(host.textContent).not.toContain('You join the global community first');
        expect(host.textContent).not.toMatch(/global/i);
    });

    it("says whom it asks and what Ask does, in the web's words (A1); reading the card makes no key and reads nothing signed", async () => {
        await open();
        expect(byTestId('community-card-ask')?.textContent).toBe('Ask to join Riverside');
        expect(byTestId('community-card-ask-note')?.textContent)
            .toBe('Makes your account here and sends your request to Riverside. Its members decide. No invite needed.');
        // The other doors stay: an invite and the ways back are welcome's own steps.
        expect(byTestId('community-card-invite')?.textContent).toBe('I have an invite');
        expect(byTestId('community-card-signin')?.textContent).toBe('Already a member');
        expect(phoneKey.drafts).toBe(0);
        expect(scene.statusReads).toBe(0);
        expect(scene.knocks).toBe(0);
    });

    it('Ask to join opens the form here, never the first screen: the key is drafted in memory and nothing is written (fails before: off to /welcome)', async () => {
        await open();
        await tap(byTestId('community-card-ask'));
        expect(nav.replaced).toEqual([]);
        expect(nav.pushed).toEqual([]);
        expect(field('Your name')).toBeTruthy();
        expect(field('A few words about yourself')).toBeTruthy();
        // The name box is empty: there is no account to take a name from.
        expect(field('Your name')!.value).toBe('');
        // The key is drafted as the form opens, off the render: wait for it (it lost the race to a fixed wait on a loaded CI
        // runner, 9 Nov), still exactly one draft.
        await vi.waitFor(() => expect(phoneKey.drafts).toBe(1), { timeout: 2000, interval: 10 });
        expect(phoneKey.written).toEqual([]);
        expect(store.map.has(KNOCK_KEY_STORE_KEY)).toBe(false);
        expect(ids.set).toEqual([]);
        expect(scene.knocks).toBe(0);
        // Cancel: the form closes, and still nothing is written or sent.
        await press('Cancel');
        expect(field('Your name')).toBeUndefined();
        expect(byTestId('community-card-ask')?.textContent).toBe('Ask to join Riverside');
        expect(phoneKey.written).toEqual([]);
        expect(store.map.has(KNOCK_KEY_STORE_KEY)).toBe(false);
        expect(scene.knocks).toBe(0);
    });

    it('a name is needed: nothing is written or sent without one', async () => {
        await open();
        await tap(byTestId('community-card-ask'));
        await fill('A few words about yourself', 'Hello.');
        await press('Send');
        expect(phoneKey.written).toEqual([]);
        expect(scene.knocks).toBe(0);
        expect(nav.replaced).toEqual([]);
    });

    it('Send writes the key once, with the name typed, before the request goes; the request is signed by it, names no community it came from, and the phone waits on welcome (fails before: no form)', async () => {
        await open();
        await askWithNoAccount('River Kid');
        // The key: written once, with the name, and marked as the knock's, so its 12 words show when a community lets it in.
        expect(phoneKey.written).toEqual([expect.objectContaining({ publicKey: DRAFT.publicKey, callsign: 'River Kid', mnemonic: DRAFT.mnemonic })]);
        expect(phoneKey.drafts).toBe(1);
        expect(store.map.get(KNOCK_KEY_STORE_KEY)).toBe(DRAFT.publicKey);
        expect(ids.set).toEqual([expect.objectContaining({ publicKey: DRAFT.publicKey, callsign: 'River Kid' })]);
        // The request: to this community, signed by that key, with nothing from global.
        expect(scene.knocks).toBe(1);
        expect(scene.signers).toEqual([DRAFT.publicKey]);
        expect(scene.sent[0]).toEqual(expect.objectContaining({ callsign: 'River Kid', message: 'I live by the river and grow tomatoes.', toNode: 'riverside.example' }));
        expect('fromNode' in scene.sent[0]).toBe(false);
        expect('avatar' in scene.sent[0]).toBe(false);
        // Remembered under that key, by the host it was read from; and the phone goes to welcome's waiting mode.
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!)).toEqual({ pubkey: DRAFT.publicKey, knocks: [expect.objectContaining({ url: ORIGIN, name: 'Riverside' })] });
        expect(nav.replaced).toEqual(['/welcome']);
        expect(alerts).toEqual([]);
    });

    it('…and what welcome reads then is waiting mode, with this request, a key whose words are new, and nothing handed over to join', async () => {
        await open();
        await askWithNoAccount();
        const { phoneIsWaiting, readWaitingFacts, waitingLines } = await import('../waiting-to-join');
        const { rememberedKnocks } = await import('../knock');
        const { knockKeyIsNew } = await import('../knock-key');
        const facts = await readWaitingFacts();
        expect(phoneIsWaiting({ hasIdentity: true, ...facts })).toBe(true);
        const asked = await rememberedKnocks(DRAFT.publicKey);
        expect(waitingLines(asked, {}).map((l) => [l.kind, 'text' in l ? l.text : null])).toEqual([['waiting', 'Waiting for Riverside: usually a few days.']]);
        // A yes there joins through the invite step, and Safety Backup shows these words as a new account's.
        expect(await knockKeyIsNew(DRAFT.publicKey)).toBe(true);
        expect(takeKnockYes(DRAFT.publicKey)).toBeNull();
    });

    it('a request the community refuses: its words on the form, the key it wrote stays (as from Find a community), and the phone stays on the card', async () => {
        scene.knockAnswer = { status: 429, body: { error: 'Too many requests to join from your network today. Try again tomorrow.', code: 'busy' } };
        await open();
        await askWithNoAccount();
        expect(scene.knocks).toBe(1);
        expect(nav.replaced).toEqual([]);
        expect(host.textContent).toContain('Too many requests to join from your network today. Try again tomorrow.');
        expect(phoneKey.written).toHaveLength(1);
        expect(store.map.get(KNOCK_KEY_STORE_KEY)).toBe(DRAFT.publicKey);
        // Nothing remembered as asked; the form is still open, and Send again signs with the same key, never a second.
        expect(store.map.has(KNOCKS_STORE_KEY)).toBe(false);
        scene.knockAnswer = null;
        await press('Send');
        expect(scene.signers).toEqual([DRAFT.publicKey, DRAFT.publicKey]);
        expect(phoneKey.written).toHaveLength(1);
        expect(phoneKey.drafts).toBe(1);
    });

    it('an account the phone stored after the form opened (an invite join in between) signs the request: the draft is dropped, nothing written, never a second key', async () => {
        // The form opens on a phone with no account (a draft, in memory); by Send, the phone holds Kim's account.
        phoneKey.reads = [null];
        phoneKey.stored = KIM;
        await open();
        await askWithNoAccount('River Kid');
        expect(phoneKey.written).toEqual([]);
        expect(store.map.has(KNOCK_KEY_STORE_KEY)).toBe(false);
        expect(scene.signers).toEqual([KIM.publicKey]);
        expect(ids.set).toEqual([KIM]);
    });

    it("an account that changes between Send's two reads: refused and said, nothing written, nothing sent", async () => {
        phoneKey.reads = [null, KIM, { ...KIM, publicKey: '23'.repeat(32) }];
        await open();
        await askWithNoAccount();
        expect(scene.knocks).toBe(0);
        expect(phoneKey.written).toEqual([]);
        expect(ids.set).toEqual([]);
        expect(nav.replaced).toEqual([]);
        expect(host.textContent).toContain('This phone holds a different BeanPool account, so the request was not sent.');
    });

    it('in Spanish too: the button and the line from the same words as the web', async () => {
        const { catalogsFor } = await import('../words-catalogs');
        setLanguage('es', catalogsFor('es'));
        await open();
        const { t: tr, COMMUNITY_CARD_WORDS: CW } = await import('@beanpool/core');
        expect(byTestId('community-card-ask')?.textContent).toBe(tr(CW.askName, { name: 'Riverside' }));
        expect(byTestId('community-card-ask-note')?.textContent).toBe(tr(CW.askNote, { name: 'Riverside' }));
        expect(byTestId('community-card-ask')?.textContent).not.toBe('Ask to join Riverside');
    });
});

/**
 * The rule on the card (Marty, board card balance-rule-other-doors, 3 Nov 2026: "Yes, show the sentence"): where the
 * community confirms its members, the one sentence its join screen and rules page say, in its own numbers, read from the
 * community itself. Nothing to tick or tap. Before this, the card said nothing of the rule: the "rule on" tests fail there.
 */
describe("the community's rule on its card", () => {
    const RULE = { known: true, knownFloor: 100, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null };
    const SENTENCE = "The admins also keep a list of confirmed members who owe more than half their credit line, or are in debit and haven't made a sale for 60 days.";

    it("rule on: the join screen's sentence, in the community's numbers, and nothing to tick", async () => {
        scene.rule = RULE;
        await open();
        expect(byTestId('community-card-rule')?.textContent).toBe(SENTENCE);
        expect(host.querySelector('input[type="checkbox"]')).toBeNull();
        expect(host.textContent).not.toMatch(/\bI agree\b/i);
    });

    it('rule on, its own numbers: 30% and 21 days', async () => {
        scene.rule = { ...RULE, debtLinePct: 30, quietDays: 21 };
        await open();
        expect(byTestId('community-card-rule')?.textContent).toBe("The admins also keep a list of confirmed members who owe more than 30% of their credit line, or are in debit and haven't made a sale for 21 days.");
    });

    it('rule on, for a phone with no account too: the card is the same door', async () => {
        currentIdentity = null;
        scene.rule = RULE;
        await open();
        expect(byTestId('community-card-rule')?.textContent).toBe(SENTENCE);
    });

    it('rule off: no sentence', async () => {
        scene.rule = { known: false };
        await open();
        expect(byTestId('community-card')).not.toBeNull();
        expect(byTestId('community-card-rule')).toBeNull();
        expect(host.textContent).not.toContain("The admins can see");
    });

    it('an older node (404): no sentence', async () => {
        scene.rule = null;
        await open();
        expect(byTestId('community-card')).not.toBeNull();
        expect(byTestId('community-card-rule')).toBeNull();
    });
});

describe('a yes shows itself while the card is open (Damo, 9 Nov 2026: it only showed after a manual refresh)', () => {
    const goTo = async (state: 'active' | 'background') => {
        appState.now = state;
        await act(async () => { for (const cb of [...appState.listeners]) cb(state); });
        await settle();
    };

    it('asks once as the card opens, and the yes comes in on its own when the app is next in front: Join, nothing pressed (fails before: one read)', async () => {
        remember();
        await open();
        expect(scene.statusReads).toBe(1);
        expect(byTestId('community-card-join')).toBeNull();
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await goTo('background');
        await goTo('active');
        expect(scene.statusReads).toBe(2);
        expect(asked()).toBe('A member invited you. Join now to become a member.');
        expect(byTestId('community-card-join')?.textContent).toBe('Join Riverside');
        // Nothing joined by itself: Join is the member's tap.
        expect(joins).toEqual([]);
        expect(nav.pushed).toEqual([]);
    });

    it('in the background it asks nothing; once there is a yes it asks no more', async () => {
        remember();
        await open();
        await goTo('background');
        await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
        expect(scene.statusReads).toBe(1);
        scene.answer = { status: 'approved', invite: 'BP-RIVR-0001' };
        await goTo('active');
        expect(scene.statusReads).toBe(2);
        await goTo('background');
        await goTo('active');
        expect(scene.statusReads).toBe(2);
    });

    it('a card that was never asked reads nothing from the community, however often the app comes back', async () => {
        await open();
        await goTo('background');
        await goTo('active');
        expect(scene.statusReads).toBe(0);
    });
});
