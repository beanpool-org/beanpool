// @vitest-environment jsdom
/**
 * Pinning S2 fix round 1 (#2769 finding 1): the "···" on the poll card, the event screen and the post screen is drawn for an
 * owner or admin (Pin, or Take the pin off) and for a pinned post's author (Take the pin off), and for nobody else. Each role on
 * each surface, drawn for real as event-host-lets-in-render.test.ts and poll-other-card.test.ts draw them: react-dom in jsdom,
 * React Native's host components as plain tags, and a stubbed node behind utils/db, utils/node-admin (the role) and the profile.
 * The role goes through the real usePinRole hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => [] as Array<{ title: string; msg?: string; buttons?: Array<{ text: string; onPress?: () => void }> }>);
const who = vi.hoisted(() => ({ role: null as null | string, pins: true, me: 'me'.repeat(32) }));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, value, onChangeText, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: any) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, msg?: string, buttons?: any[]) => { alerts.push({ title, msg, buttons }); } },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: who.me, privateKey: 'aa' } }) }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: who.me, privateKey: 'aa', callsign: 'x', createdAt: '' }) }));
const node = vi.hoisted(() => ({ view: null as any }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(), letInToEvent: vi.fn(),
    votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(async () => false), createPost: vi.fn(),
    getPollOtherAnswers: vi.fn(), reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(),
    pinPostOnNode: vi.fn(), unpinPostOnNode: vi.fn(async () => ({ success: true })), getPost: vi.fn(async () => null),
}));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://x.beanpool.org' }));
vi.mock('../node-admin', () => ({ cachedNodeRole: async () => ({ role: who.role, communityName: null }) }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => null }));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('../modal-safe-area', () => ({ pageSheetTopInset: () => 0 }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';
import { PollCard } from '../../components/PollCard';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); alerts.length = 0; node.view = null; who.role = null; who.pins = true; who.me = 'me'.repeat(32); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const HOST = 'host'.repeat(16);
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const event = (pinned: boolean) => ({
    id: 'ev-1', type: 'event', title: 'Garden dinner', description: 'Bring a plate', author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Hana',
    eventStartAt: future(), eventEndAt: new Date(Date.now() + 90_000_000).toISOString(), eventPlaceName: 'Bangalow Hall', photos: [], goingCount: 3, interestedCount: 0,
    ...(pinned ? { pinnedUntil: future(), pinnedAt: new Date().toISOString() } : {}),
});
const poll = (pinned: boolean) => ({
    id: 'poll_1', type: 'poll', title: 'What is missing?', author_pubkey: HOST, author_callsign: 'Mo', status: 'active',
    poll_closes_at: future(), poll_open_vote: 0, totalVotes: 5,
    pollOptions: [{ id: 'o1', text: 'Buses', votes: 3, percentage: 60 }, { id: 'o2', text: 'Trains', votes: 2, percentage: 40 }],
    ...(pinned ? { pinned_until: future(), pinned_at: new Date().toISOString() } : {}),
});
const drawEvent = async (pinned: boolean) => {
    const e = event(pinned); node.view = e;
    await act(async () => { root.render(createElement(EventDetail, { post: e, pinsOn: who.pins }) as never); });
    await settle(); await settle();
};
const drawPoll = async (pinned: boolean) => {
    await act(async () => { root.render(createElement(PollCard, { post: poll(pinned), currentPubkey: who.me, pinsOn: who.pins }) as never); });
    await settle(); await settle();
};

type Reader = { name: string; role: string | null; author: boolean };
const READERS: Reader[] = [
    { name: 'an owner', role: 'owner', author: false },
    { name: 'an admin', role: 'admin', author: false },
    { name: 'a moderator', role: 'moderator', author: false },
    { name: 'a plain member', role: null, author: false },
    { name: "the post's author, a plain member", role: null, author: true },
    { name: "the post's author, an owner", role: 'owner', author: true },
];
// owner/admin: always; the author: only while pinned; a moderator and a plain member: never.
const sees = (r: Reader, pinned: boolean) => r.role === 'owner' || r.role === 'admin' || (pinned && r.author);

const SURFACES = [
    { surface: 'the poll card', menu: 'poll-menu-btn', draw: drawPoll, title: 'Poll options' },
    { surface: 'the event screen', menu: 'event-menu-btn', draw: drawEvent, title: 'Event options' },
];

for (const s of SURFACES) {
    describe(`${s.surface}: the "···"`, () => {
        for (const pinned of [false, true]) {
            for (const r of READERS) {
                it(`${sees(r, pinned) ? 'is drawn for' : 'is NOT drawn for'} ${r.name}, post ${pinned ? 'pinned' : 'not pinned'}`, async () => {
                    who.role = r.role; who.me = r.author ? HOST : 'me'.repeat(32);
                    await s.draw(pinned);
                    expect(q(s.menu) !== null).toBe(sees(r, pinned));
                });
            }
        }

        it('offers an owner Pin on a post that is not pinned, and Take the pin off on one that is', async () => {
            who.role = 'owner';
            await s.draw(false);
            await act(async () => { q(s.menu)!.click(); });
            expect(alerts.at(-1)!.title).toBe(s.title);
            expect(alerts.at(-1)!.buttons!.map(b => b.text)).toEqual(['Pin to the top…', 'Cancel']);
            await act(async () => { root.unmount(); });
            root = createRoot(host);
            await s.draw(true);
            await act(async () => { q(s.menu)!.click(); });
            expect(alerts.at(-1)!.buttons!.map(b => b.text)).toEqual(['Take the pin off', 'Cancel']);
        });

        it('draws no "···" where the community has pins off, whoever the reader is', async () => {
            who.role = 'owner'; who.pins = false;
            await s.draw(true);
            expect(q(s.menu)).toBeNull();
        });
    });
}

describe('the post screen (app/post/[id].tsx)', () => {
    // The screen is too large to draw here; this holds that its header gate is the shared rule and the role is the real hook.
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/post/[id].tsx'), 'utf8');
    it("draws the \"···\" through showPinMenu with the node's role, never on features.pins alone", () => {
        expect(src).toMatch(/showPinMenu\(\{ pinsOn, role: pinRole, pinned: isPostPinned\(post\), isAuthor: isOwnPost \}\)/);
        expect(src).toMatch(/const pinRole = usePinRole\(pinsOn, identity\?\.publicKey\)/);
        expect(src).not.toMatch(/Boolean\(nodeProfile\?\.features\?\.pins\) && \(/);
    });
    it('tells the event screen whether pins are on, and the Market tells each poll card', () => {
        expect(src).toMatch(/<EventDetail [^>]*pinsOn=\{pinsOn\}/);
        const market = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/market.tsx'), 'utf8');
        expect(market).toMatch(/pinsOn=\{Boolean\(nodeProfile\?\.features\?\.pins\)\}/);
    });
    it('words a failed take-off through pinFailureText', () => {
        expect(src).not.toMatch(/e\?\.message \|\| t\('Failed to unpin post'\)/);
        expect(src.match(/pinFailureText\(e, t\('Failed to unpin post'\)\)/g)?.length).toBe(2);
    });
});
