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

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID, accessibilityRole, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
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
const DEFAULT_IDENTITY = { publicKey: KEY, privateKey: 'd'.repeat(64), callsign: 'Damo' };
let currentIdentity: typeof DEFAULT_IDENTITY | null = DEFAULT_IDENTITY;
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: currentIdentity }),
}));
const dbRow = vi.hoisted(() => ({ profile: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async () => dbRow.profile),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'X-Test-Signed': '1' }) }));
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
import { KNOCKS_STORE_KEY } from '../storage-keys';
import { takeKnockYes } from '../waiting-to-join';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { setLanguage } from '@beanpool/core';

type Answer = { status: 'pending' } | { status: 'none' } | { status: 'approved'; invite: string } | 'offline';
const scene = { answer: { status: 'pending' } as Answer, statusReads: 0, knocks: 0, sent: [] as Record<string, unknown>[], card: null as Record<string, unknown> | null };

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
    scene.statusReads = 0;
    scene.knocks = 0;
    scene.sent = [];
    scene.card = null;
    setLanguage('en');
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        const u = String(input);
        if (u === `${ORIGIN}/api/community/card`) return json(scene.card ?? CARD);
        if (u === `${ORIGIN}/api/join/knock/status`) {
            scene.statusReads++;
            if (scene.answer === 'offline') throw new TypeError('Network request failed');
            return json(scene.answer);
        }
        if (u === `${ORIGIN}/api/join/knock` && init?.method === 'POST') {
            scene.knocks++;
            scene.sent.push(JSON.parse(String(init.body)));
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
        expect(buttons()).not.toContain('Ask to join');
        // Profile S2-W: sends this community's photo (or none), never the phone-wide canonical copy.
        expect('avatar' in scene.sent[0]).toBe(false);
        expect(JSON.parse(store.map.get(KNOCKS_STORE_KEY)!).knocks.map((k: { url: string }) => k.url)).toEqual([ORIGIN]);
    });

    it("sends this community's photo with the knock when this community's row holds one", async () => {
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
        expect(scene.sent[0].avatar).toBe('bundled://fox');
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

describe('the card with no account on the phone', () => {
    it('shows how to ask via global community, and old sentence is gone', async () => {
        currentIdentity = null;
        await open();
        expect(byTestId('community-card-needs-account')?.textContent).toBe('Look around global first, join there to get an account, then find Riverside in Find a community.');
        expect(host.textContent).not.toContain('Explore BeanPool worldwide');
        expect(host.textContent).not.toContain('To ask, you need a BeanPool account first');
        expect(host.textContent).not.toContain('You join the global community first');
    });
});
