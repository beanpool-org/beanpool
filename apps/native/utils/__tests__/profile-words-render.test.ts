// @vitest-environment jsdom
/**
 * A member's profile in the member's language (words slice S3, sweep B11): app/public-profile.tsx, drawn for real inside
 * the real LanguageProvider, with what only it draws (the channel chips, components/ChannelChips.tsx) and the photo
 * viewer every avatar opens (components/MemberAvatar.tsx). React Native's host components are plain tags carrying what a
 * member reads (profile-events-words-harness.ts); the phone's database, the node and the quiz are stubbed at their modules.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint or
 * alert with letters outside a bracket bypassed t(). What members wrote is shown as written: a name, a bio, a listing's
 * title, a review's comment; so are the node's own words (the trust verdict, its reasons and tips: slice S4) and the
 * working-style words core's archetypes.ts writes (the welcome sweep, #2206, makes those word() keys; the profile shows
 * them through t() once that lands: listed in the PR).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => (await import('./profile-events-words-harness')).nativeMock(alerts));
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
    useFocusEffect: () => {},
    ErrorBoundary: () => null,
}));
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: (p: { accessibilityLabel?: string }) => h('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : {}) };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
// Keys of digits only, so what is drawn of a key (its first 16 characters) has no letters to mistake for words.
const OWN = '9'.repeat(64);
const KOFI = '3'.repeat(64);
const ROSA = '2'.repeat(64);
const who = vi.hoisted(() => ({ value: { identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
/** What the phone's copy and the node answer: set per case. */
const data = vi.hoisted(() => ({
    profiles: {} as Record<string, Record<string, unknown> | null>,
    posts: [] as Record<string, unknown>[],
    ratings: null as null | Record<string, unknown>,
    given: [] as Record<string, unknown>[],
    balance: null as null | Record<string, unknown>,
    friends: [] as unknown[],
    trust: null as null | Record<string, unknown>,
    vouched: [] as unknown[],
}));
vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async (k: string) => data.profiles[k] ?? null),
    getMemberRatings: vi.fn(async () => data.ratings),
    getMemberPosts: vi.fn(async () => data.posts),
    getBalance: vi.fn(async () => data.balance),
    getRatingsGiven: vi.fn(async () => data.given),
    getFriendsLocal: vi.fn(async () => data.friends),
    getTrustProfile: vi.fn(async () => data.trust),
    vouchMember: vi.fn(async (...a: unknown[]) => { data.vouched.push(a); }),
    updateMemberProfile: vi.fn(async () => undefined),
}));
vi.mock('../blocklist', () => ({ blockUser: vi.fn(async () => undefined) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null) }));
const chans = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => chans.list) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));
const community = vi.hoisted(() => ({ beans: true, preview: false }));
vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => ({ profile: community.beans ? 'local' : 'global', checkedAt: '2026-10-19T00:00:00.000Z', features: { beans: community.beans } }),
}));
vi.mock('../use-reader-features', () => ({ useShowcaseMode: () => (community.preview ? 'preview' : 'off') }));
vi.mock('../reads-own', () => ({ readsOwn: vi.fn(async () => true) }));
vi.mock('../members-lookup', () => ({ cardNeedsFetch: () => false, fetchCardByKey: vi.fn(async () => 'fresh') }));
vi.mock('../image-processing', () => ({ avatarUri: (url: string | null) => url }));
vi.mock('../node-post', () => ({ anchorUrl: async () => null, getCachedAnchorUrl: () => 'https://mullum.example' }));
vi.mock('../bundled-avatars', () => ({ resolveBundledAvatar: () => null }));
// The avatars are stand-ins on the screen (the viewer is checked on its own below); the quiz and the review sheet are other screens.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
// Not this sweep's: the showcase's mark draws the line it is handed, which is checked.
vi.mock('../../components/showcase/LocalCommunityMark', async () => {
    const { createElement: h } = await import('react');
    return { LocalCommunityMark: ({ text }: { text: string }) => h('span', { 'data-testid': 'local-line' }, text) };
});

import { ARCHETYPES, LOCAL_COMMUNITY_LINES, calculateSynergy, pseudoLocalise, setLanguage, type ArchetypeKey, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import PublicProfileScreen from '../../app/public-profile';
import { bypassing, bracketed, unfit } from './profile-events-words-harness';

/** What core's archetypes.ts writes (the welcome sweep's: shown as written here until it lands). */
function archetypeWords(...keys: ArchetypeKey[]): string[] {
    const out: string[] = [];
    for (const k of keys) {
        const a = ARCHETYPES[k];
        out.push(a.name, a.tagline, a.description, a.collaborationStyle, a.communicationTip, ...a.superpowers);
    }
    return out;
}
function synergyWords(viewer: ArchetypeKey, member: ArchetypeKey): string[] {
    const s = calculateSynergy(viewer, member);
    return [s.title, s.headline, s.summary, s.collaborationTip ?? '', ...s.strengths];
}

/** The node's own words (slice S4) and what members wrote. */
const NODE_WORDS = ['New & unvouched — take normal precautions', 'New member with no completed trades yet.', 'Meet somewhere public the first time.'];
const MEMBERS = ['Kofi', 'Rosa', 'Wren', 'Grows tomatoes and fixes bikes.', 'Bike repair', 'Tomato seedlings', 'Great tomatoes, on time.', 'Lovely to deal with.', 'Kofi Tube'];

const TRUST = (over: Record<string, unknown> = {}) => ({
    tier: { name: 'Newcomer', emoji: '🌱' }, earnedCredit: 0, stats: { tradeCount: 0, uniquePartners: 0 }, completionRate: null,
    risk: { band: 'red', headline: NODE_WORDS[0], reasons: [NODE_WORDS[1]], tips: [NODE_WORDS[2]] },
    vouchedInBy: { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null },
    mutualCount: 1, mutualConnections: [{ publicKey: ROSA, callsign: 'Rosa', avatarUrl: null }],
    joinedAt: '2026-03-01T00:00:00.000Z', lastActiveAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), elderVouch: null,
    ...over,
});
const RATINGS = {
    average: 4.5, count: 2, asProvider: { average: 5 }, asReceiver: { average: 4 },
    ratings: [
        { stars: 5, role: 'provider', createdAt: '2026-09-12T00:00:00.000Z', comment: 'Great tomatoes, on time.' },
        { stars: 4, role: 'receiver', createdAt: '2026-08-02T00:00:00.000Z', comment: '' },
    ],
};
const POSTS = [
    { id: 'p1', type: 'offer', title: 'Bike repair', credits: 15, photos: '["/uploads/a.jpg"]' },
    { id: 'p2', type: 'need', title: 'Tomato seedlings', credits: 4, photos: null },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    nav.params = {};
    nav.pushed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    community.beans = true;
    community.preview = false;
    chans.list = [];
    data.profiles = {
        [KOFI]: { public_key: KOFI, callsign: 'Kofi', avatar_url: null, bio: 'Grows tomatoes and fixes bikes.', joined_at: '2026-03-01T00:00:00.000Z', archetype: null },
        [OWN]: { public_key: OWN, callsign: 'Wren', avatar_url: null, bio: null, joined_at: '2026-01-05T00:00:00.000Z', archetype: null },
    };
    data.posts = POSTS;
    data.ratings = RATINGS;
    data.given = [];
    data.balance = { balance: 12.5, earnedCredit: 40, tier: { name: 'Resident', emoji: '🏡' }, trustStats: { tradeCount: 3 }, canVouch: false };
    data.friends = [{}, {}];
    data.trust = TRUST();
    data.vouched.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(PublicProfileScreen)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const button = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
/** The button that reads exactly `shown` (words already drawn: a pseudo-locale sentence with its placeholders filled). */
const buttonReading = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === shown) ?? null;
const said = () => alerts.said;
const xx = (s: string) => pseudoLocalise(s);

describe('another member\'s profile in the pseudo-locale: every word came through t() (words S3l)', () => {
    it('Beans on, a newcomer: the header, the trust panel and its verdict line, connections in common, the chemistry invite, ratings and listings', async () => {
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        expect(host.textContent).toContain(xx('Trust Profile'));
        expect(host.textContent).toContain(xx('{pct}% Reciprocity Health').replace('{pct}', '100'));
        // The node's tier name, in the member's language.
        expect(host.textContent).toContain(xx('Newcomer'));
        expect(host.textContent).toContain(xx('{n} Trust Points').replace('{n}', '0'));
        expect(host.textContent).toContain(xx('Active {n}d ago').replace('{n}', '3'));
        // The bold label sits inside its sentence.
        const line = xx('🌱 {label} Has not completed any trades yet. Complete a marketplace trade with them to help build their community trust score.').split('{label}');
        expect(host.textContent).toContain(`${line[0]}${xx('New Member:')}${line[1]}`);
        expect(host.textContent).toContain(xx('👥 {n} connection in common').replace('{n}', '1'));
        expect(host.textContent).toContain(xx('Invited directly by the system admin'));
        expect(host.textContent).toContain(xx('Take the 60-second quiz to get tips for working with {name}.').replace('{name}', 'Kofi'));
        expect(host.textContent).toContain(xx('OVERALL'));
        expect(host.textContent).toContain(xx('Listings ({n})').replace('{n}', '2'));
        expect(host.textContent).toContain(xx('OFFER'));
        expect(host.querySelector(`[aria-label="${xx('Block user {name}').replace('{name}', 'Kofi')}"]`)).not.toBeNull();
        expect(bracketed(host)).toBeGreaterThan(30);
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS], said())).toEqual([]);

        await click(buttonReading(xx('Reviews ({n})').replace('{n}', '2')), 'Reviews');
        expect(host.textContent).toContain(xx('PROVIDED SERVICE'));
        expect(host.textContent).toContain(xx('RECEIVED SERVICE'));
        expect(host.textContent).toContain(xx('No comment provided.'));
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS], said())).toEqual([]);
    });

    it('a mixed track record vouched in by a member, the vouch levels, and blocking', async () => {
        data.trust = TRUST({
            stats: { tradeCount: 4, uniquePartners: 1 }, completionRate: 0.5, tier: { name: 'Steward', emoji: '🌿' }, earnedCredit: 120,
            vouchedInBy: { kind: 'member', publicKey: ROSA, callsign: 'Rosa', avatarUrl: null, tier: 'Elder' },
            mutualCount: 2, mutualConnections: [{ publicKey: ROSA, callsign: 'Rosa', avatarUrl: null }, { publicKey: '4'.repeat(64), callsign: null, avatarUrl: null }],
        });
        data.balance = { ...data.balance!, canVouch: true };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        const mixed = xx('⚠️ {label} Completed {n} trades with a {pct}% completion rate across {partners}.')
            .replace('{n}', '4').replace('{pct}', '50').replace('{partners}', xx('{n} partner').replace('{n}', '1')).split('{label}');
        expect(host.textContent).toContain(`${mixed[0]}${xx('Mixed Track Record:')}${mixed[1]}`);
        expect(host.textContent).toContain(xx('Steward'));
        expect(host.textContent).toContain(xx('🌱 Vouched in by {name}').replace('{name}', 'Rosa'));
        expect(host.textContent).toContain(xx('{tier} tier · tap to reach out').replace('{tier}', xx('Elder')));
        expect(host.textContent).toContain(xx('👥 {n} connections in common').replace('{n}', '2'));
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS, '4'.repeat(8)], said())).toEqual([]);

        await click(button('🤝 Vouch for Member'), 'Vouch');
        expect(said()).toEqual([xx('Vouch for {name}').replace('{name}', 'Kofi'),
            xx('Choose how deep a credit line to extend. This lets them trade on credit down to that floor — it reflects your confidence in them. No beans leave your wallet.'),
            xx('Light · −{n}').replace('{n}', '25'), xx('Standard · −{n}').replace('{n}', '50'), xx('Deep · −{n}').replace('{n}', '100'), xx('Cancel')]);
        alerts.said.length = 0;
        data.trust = null;
        await act(async () => { await alerts.buttons[1].onPress?.(); });
        await settle();
        expect(data.vouched).toEqual([[KOFI, 2]]);
        // No fresh profile from the node: the badge names the voucher, as before.
        expect(host.textContent).toContain(xx('Vouched by {name}').replace('{name}', 'Wren'));

        await click(buttonReading(xx('Block {name}').replace('{name}', 'Kofi')), 'Block Kofi');
        expect(said()).toEqual([xx('Block {name}?').replace('{name}', 'Kofi'),
            xx('This will instantly hide all posts, offers, and messages from {name}, and notify moderation.').replace('{name}', 'Kofi'), xx('Cancel'), xx('Block User')]);
        alerts.said.length = 0;
        await act(async () => { await alerts.buttons[1].onPress?.(); });
        await settle();
        expect(said()).toEqual([xx('User Blocked'), xx('{name} has been blocked and removed from your feed.').replace('{name}', 'Kofi'), xx('OK')]);
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS, '4'.repeat(8)], said())).toEqual([]);
    });

    it('a proven partner, a founding member, both quizzes taken: the chemistry card\'s own words (the archetype words are core\'s)', async () => {
        data.trust = TRUST({
            stats: { tradeCount: 9, uniquePartners: 5 }, completionRate: 0.95, vouchedInBy: { kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null },
            risk: { band: 'green', headline: NODE_WORDS[0], reasons: [], tips: [] },
        });
        data.profiles[KOFI] = { ...data.profiles[KOFI]!, archetype: 'weaver' };
        data.profiles[OWN] = { ...data.profiles[OWN]!, archetype: 'spark' };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        const proven = xx('🤝 {label} Earned trust through {n} completed trades across {partners}.')
            .replace('{n}', '9').replace('{partners}', xx('{n} unique partners').replace('{n}', '5')).split('{label}');
        expect(host.textContent).toContain(`${proven[0]}${xx('Proven Partner:')}${proven[1]}`);
        expect(host.textContent).toContain(xx('Founding member'));
        expect(host.textContent).toContain(xx('Here since the community began'));
        expect(host.textContent).toContain(xx('Collaboration tip:'));
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS, ...synergyWords('spark', 'weaver')], said())).toEqual([]);
    });

    it('the member has taken the quiz and this one hasn\'t: the nudge, its label, and the message it starts in the sender\'s language', async () => {
        data.profiles[OWN] = { ...data.profiles[OWN]!, archetype: 'spark' };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        expect(host.textContent).toContain(xx("{name} hasn't taken the working style quiz yet. Send a friendly nudge in chat to get tips for working together.").replace('{name}', 'Kofi'));
        const nudge = host.querySelector(`[aria-label="${xx('Nudge {name} to take the working style quiz').replace('{name}', 'Kofi')}"]`);
        await click(nudge, 'Nudge');
        expect(nav.pushed).toEqual([{ pathname: `/chat/${KOFI}`, params: { prefill: xx('Hey {name}! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡').replace('{name}', 'Kofi') } }]);
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS], said())).toEqual([]);
    });

    it('a member with no name and no card, and an elder\'s vouch with no name: every sentence has its own words in place of the name', async () => {
        data.profiles[KOFI] = null;
        data.trust = TRUST({ elderVouch: { callsign: null } });
        nav.params = { publicKey: KOFI };
        await renderIn('xx');
        expect(host.textContent).toContain(xx('Take the 60-second quiz to get tips for working with this member.'));
        expect(host.textContent).toContain(xx('Vouched by an Elder'));
        expect(host.querySelector(`[aria-label="${xx('Block user')}"]`)).not.toBeNull();
        expect(host.textContent).toContain(xx('Block User'));
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS], said())).toEqual([]);
    });

    it('where Beans are off: the meeting advice, and the showcase\'s line in the member\'s language', async () => {
        community.beans = false;
        community.preview = true;
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        expect(host.querySelector('[data-testid="meeting-tips"]')?.textContent).toContain(xx('Meeting someone new'));
        expect(host.querySelector('[data-testid="local-line"]')?.textContent).toBe(xx(LOCAL_COMMUNITY_LINES.profile));
        expect(host.textContent).not.toContain(xx('{n} Trust Points').replace('{n}', '0'));
        expect(bypassing(host, [...MEMBERS], said())).toEqual([]);
    });

    it("a member's channels: each chip, its spoken name with and without a handle, verified or not; brands as written", async () => {
        chans.list = [
            { id: 'c1', platform: 'youtube', handle: 'Kofi Tube', url: 'https://youtube.com/@kofi', isVerified: true, supportsAutolist: true },
            { id: 'c2', platform: 'website', handle: null, url: 'https://kofi.example', isVerified: false, supportsAutolist: false },
        ];
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        expect(host.querySelector(`[aria-label="${xx('External channels')}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx('{platform} {handle} (verified account)').replace('{platform}', 'YouTube').replace('{handle}', 'Kofi Tube')}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx('Website')}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx('Verified account')}"]`)).not.toBeNull();
        expect(host.querySelector(`[data-hint="${xx('Opens external channel link')}"]`)).not.toBeNull();
        expect(bypassing(host, [...NODE_WORDS, ...MEMBERS, 'YouTube'], said())).toEqual([]);
    });

    it('a listing seen as a visitor names nobody: the plain state', async () => {
        nav.params = { publicKey: 'hidden' };
        await renderIn('xx');
        expect(host.textContent).toContain(xx('Who posted this is shown to members of this community. Join it to see their profile.'));
        expect(bypassing(host)).toEqual([]);
    });
});

describe('the member\'s own profile in the pseudo-locale', () => {
    it('the header, the trust card, the stats, the working style invite, and the three tabs', async () => {
        data.given = [{ id: 'g1', target_avatar: null, target_pubkey: ROSA, target_callsign: 'Rosa', created_at: '2026-10-01T00:00:00.000Z', stars: 5, comment: 'Lovely to deal with.', transaction_id: 'tx1' }];
        nav.params = { publicKey: OWN };
        await renderIn('xx');
        expect(host.textContent).toContain(xx('My Profile'));
        expect(host.textContent).toContain(xx('Edit'));
        expect(host.textContent).toContain(xx('Resident'));
        expect(host.textContent).toContain(xx('{n} trust points').replace('{n}', '40'));
        expect(host.textContent).toContain('+12.5');
        expect(host.textContent).toContain(xx('Friends'));
        expect(host.textContent).toContain(xx('Your Working Style'));
        expect(host.textContent).toContain(xx('Received ({n})').replace('{n}', '2'));
        expect(host.textContent).toContain(xx('Given ({n})').replace('{n}', '1'));
        expect(bypassing(host, [...MEMBERS], said())).toEqual([]);
        await click(buttonReading(xx('Given ({n})').replace('{n}', '1')), 'Given');
        expect(host.textContent).toContain(xx('Edit Review'));
        expect(bypassing(host, [...MEMBERS], said())).toEqual([]);
    });

    it('with a working style: its card\'s own words, the two quiz buttons (the archetype words are core\'s)', async () => {
        data.profiles[OWN] = { ...data.profiles[OWN]!, archetype: JSON.stringify({ primary: 'weaver', secondary: 'spark', mode: 'quick' }) };
        data.posts = [];
        data.ratings = { average: 0, count: 0, ratings: [] };
        nav.params = { publicKey: OWN };
        await renderIn('xx');
        expect(host.textContent).toContain(xx('Secondary rhythm: {emoji} {name}').replace('{emoji}', ARCHETYPES.spark.emoji).replace('{name}', ARCHETYPES.spark.name));
        expect(host.textContent).toContain(xx('How you work best:'));
        expect(host.textContent).toContain(xx('🧭 More accurate'));
        expect(host.textContent).toContain(xx('🔄 Retake'));
        expect(host.textContent).toContain(xx('No active listings.'));
        expect(bypassing(host, [...MEMBERS, ...archetypeWords('weaver', 'spark')], said())).toEqual([]);
    });
});

describe('the photo viewer every avatar opens, in the pseudo-locale', () => {
    it('the avatar\'s label, the viewer\'s labels and its hint', async () => {
        const { MemberAvatar } = await vi.importActual<typeof import('../../components/MemberAvatar')>('../../components/MemberAvatar');
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'xx' },
                createElement(MemberAvatar, { avatarUrl: 'https://mullum.example/a.jpg', pubkey: KOFI, callsign: 'Kofi', enlargeable: true })) as any);
        });
        await settle();
        await click(host.querySelector(`[aria-label="${xx("View {name}'s photo").replace('{name}', 'Kofi')}"]`), 'the avatar');
        expect(host.querySelector(`[aria-label="${xx('Close photo')}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx("{name}'s photo").replace('{name}', 'Kofi')}"]`)).not.toBeNull();
        expect(host.textContent).toContain(xx('Tap anywhere to close'));
        expect(bypassing(host, ['Kofi'])).toEqual([]);
    });
});

describe('in English nothing is bracketed, and the words are as they were', () => {
    it('another member', async () => {
        data.trust = TRUST({ stats: { tradeCount: 4, uniquePartners: 1 }, completionRate: 0.5 });
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('en');
        expect(bracketed(host)).toBe(0);
        for (const english of ['Trust Profile', '50% Reciprocity Health', 'Newcomer', '0 Trust Points', 'Member since 1 Mar 2026 · Active 3d ago',
            '⚠️ Mixed Track Record: Completed 4 trades with a 50% completion rate across 1 partner.', '👥 1 connection in common',
            'Take the 60-second quiz to get tips for working with Kofi.', '⚡ Take 60s Quiz', 'Trades', 'Partners', 'Completion', 'Listings (2)', 'Reviews (2)',
            'OVERALL', 'AS PROVIDER', 'OFFER', 'NEED', 'Active', 'Block Kofi', 'Blocking will instantly hide their content from your feed and notify moderation.', '📅 Joined 1 Mar 2026']) {
            expect(host.textContent, english).toContain(english);
        }
    });

    it('the member\'s own', async () => {
        nav.params = { publicKey: OWN };
        await renderIn('en');
        expect(bracketed(host)).toBe(0);
        for (const english of ['My Profile', 'Edit', 'Resident', '40 trust points', '+12.5', 'Beans', 'Friends', 'Trades', 'Your Working Style',
            'Take the 60-second quiz on how you prefer to work. Neighbours then get tips for working with you.', 'Received (2)', 'Given']) {
            expect(host.textContent, english).toContain(english);
        }
    });
});

describe('the profile at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('another member: no word wider than the page, nothing stuck in a row; the tabs shrink to fit their third', async () => {
        data.trust = TRUST({ vouchedInBy: { kind: 'member', publicKey: ROSA, callsign: 'Rosa', avatarUrl: null, tier: 'Elder' }, elderVouch: { callsign: 'Rosa' } });
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderIn('xx');
        // 320 - 2 × 16 (the cards' margin) - 2 × 14 (their padding).
        expect(unfit(host, 320 - 32 - 28, [...NODE_WORDS, ...MEMBERS])).toEqual([]);
        for (const english of ['Listings ({n})', 'Reviews ({n})']) {
            const tab = Array.from(host.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith(xx(english).split('{n}')[0]))!;
            expect(tab, english).toBeTruthy();
            expect(tab.getAttribute('data-shrinks'), english).toBe('true');
            expect(tab.getAttribute('data-lines'), english).toBe('1');
        }
    });

    it('the member\'s own', async () => {
        nav.params = { publicKey: OWN };
        await renderIn('xx');
        expect(unfit(host, 320 - 32 - 28, [...MEMBERS])).toEqual([]);
    });
});

describe('the profile follows a language picked while it is open', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws it in French from the real catalog, with nothing by hand', async () => {
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(PublicProfileScreen)),
                createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(host.textContent).toContain('Back');
        expect(host.textContent).toContain('Newcomer');
        expect(host.textContent).toContain('OFFER');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        // Words the catalog already has (the drafting pass writes this screen's own after merge): Back, the node's tier
        // name read as one of the tiers this build knows, a listing's kind.
        for (const key of ['Back', 'Newcomer\u0004trust tier', 'OFFER']) {
            expect(typeof fr[key], key).toBe('string');
            expect(host.textContent).toContain(fr[key] as string);
        }
        for (const english of ['Back', 'Newcomer', 'OFFER']) expect(host.textContent, english).not.toContain(english);
    });
});
