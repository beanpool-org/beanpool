// @vitest-environment jsdom
/**
 * The Commons tab on the worldwide community, the whole screen rendered for real (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 row 6, §4): Groups is real, and Enterprises, Decide and the pool are Example
 * Valley's preview, so the screen asks the node for groups and nothing of the reader's own pool balance, enterprises,
 * decisions or members. The first-draw recipe of showcase-ledger-render.test.ts: the mode is decided as on a phone (the
 * phone's own copy of the node's profile, through useNodeProfileState → useReaderFeatures, nothing mocked between), and
 * the screen asks nothing until it is known; an answer begun under another mode never draws over the preview.
 *
 * The net spy: fetch, XMLHttpRequest, WebSocket, every export of utils/db (net-spy-db.ts) and node-post's signed calls.
 * A local community's Commons, the same screen, is drawn first as the control: its calls are seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SAMPLE_COMMUNITY } from '@beanpool/core';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))
                : ListEmptyComponent,
            ListFooterComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const routes = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push(x: unknown) { routes.pushed.push(JSON.stringify(x)); }, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({}),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
// A real member's own account on this phone: in preview their pool, enterprises and votes are never asked about.
const me = vi.hoisted(() => ({ identity: { publicKey: 'a-real-member-key', callsign: 'RealMember' } as Record<string, string> | null }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
// Decide and the pool's own modals draw what they are given: a stand-in shows it, so a late answer drawn is seen.
vi.mock('../../components/DecideSection', () => ({
    DecideSection: ({ decisions, preview }: { decisions: Array<{ title?: string }>; preview?: boolean }) => createElement('div', { 'data-testid': 'decide-section', 'data-preview': String(preview) },
        decisions.map(d => d.title).join(' | '),
        preview ? createElement('div', { 'data-testid': 'voice-credits-card' }, '582') : null,
    ),
}));
vi.mock('../../components/ProposeDecisionModal', () => ({ ProposeDecisionModal: () => null }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));
// Your groups (chat) is the member's own and real here; a stand-in keeps its create modal's native modules out.
vi.mock('../../components/YourGroupsPane', () => ({
    YourGroupsRows: () => null, YourGroupsLoading: () => null, YourGroupsError: () => null,
    useCreateGroupFlow: () => ({ open() {}, modal: null }),
}));
vi.mock('../../components/CommonsInfoModal', () => ({
    CommonsInfoModal: ({ isOpen, commonsBalance }: { isOpen: boolean; commonsBalance?: number }) => (isOpen ? createElement('div', { 'data-testid': 'commons-info' }, `pool ${commonsBalance ?? ''}`) : null),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: ({ amount }: { amount: string | number }) => createElement('span', null, `${amount} Beans`) }));
// The net spy.
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, name => net.answer?.(name)));
vi.mock('../node-post', () => ({
    signedGet: (_url: string, path: string) => { net.calls.push(`signedGet ${path}`); return new Promise(() => {}); },
    signedPost: (_url: string, path: string) => { net.calls.push(`signedPost ${path}`); return new Promise(() => {}); },
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));

import ProjectsScreen from '../../app/(tabs)/projects';

const NODE = 'https://global.example';
function rememberProfile(profile: 'global' | 'local', features: Record<string, boolean>) {
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile, features, checkedAt: new Date().toISOString() } }));
}
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };
/** What a preview of Beans, Enterprises and Decisions may never ask the node. */
const PREVIEWED = ['db.getBalance', 'db.getTreasuries', 'db.getDecisions', 'db.getAllCommunityMembers'];
/** The node's answers when a test holds none: empty, so the screen goes on to ask what it asks next. */
const EMPTY: Record<string, unknown> = {
    getBalance: { earnedCredit: 0, commons: 0 }, getTreasuries: [], getDecisions: { decisions: [] }, getAllCommunityMembers: [],
    fetchGroups: [],
};
const emptyAnswer = (name: string) => (name in EMPTY ? Promise.resolve(EMPTY[name]) : undefined);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = emptyAnswer;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    me.identity = { publicKey: 'a-real-member-key', callsign: 'RealMember' };
    globalThis.fetch = vi.fn(async (url: unknown) => { net.calls.push(`fetch ${String(url)}`); return new Response('{}'); }) as typeof fetch;
    (globalThis as any).XMLHttpRequest = class { open() { net.calls.push('xhr'); } send() { net.calls.push('xhr'); } setRequestHeader() {} };
    (globalThis as any).WebSocket = class { constructor() { net.calls.push('ws'); } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await settle(); };
const text = () => host.textContent ?? '';

describe("the control: a local community's Commons, the same screen", () => {
    it("asks its node for the pool, the enterprises, the decisions and the groups, so the spy sees this screen's calls", async () => {
        rememberProfile('local', { beans: true, enterprises: true, decisions: true, showcase: false });
        await render(createElement(ProjectsScreen));
        expect(net.calls).toEqual(expect.arrayContaining([...PREVIEWED, 'db.fetchGroups']));
        expect(host.querySelector('[data-testid="commons-preview"]')).toBeNull();
    });
});

describe('the Commons on the worldwide community, its profile on the phone', () => {
    it("asks for the groups only, and nothing before the phone's copy of the profile is read", async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(ProjectsScreen));
        expect(host.querySelector('[data-testid="commons-preview"]')).not.toBeNull();
        expect(text()).toContain(SAMPLE_COMMUNITY.enterprises[0].name);
        for (const call of PREVIEWED) expect(net.calls, call).not.toContain(call);
        expect(net.calls).toContain('db.fetchGroups');
        expect(net.calls.filter(c => c !== 'db.fetchGroups' && c !== 'db.fetchYourGroups')).toEqual([]);
    });

    it('is headed Commons, and greets the newcomer with the strip and Example Valley before the real groups (design §1 row 6, §2)', async () => {
        rememberProfile('global', WORLDWIDE);
        const group = (n: number) => ({
            id: `g${n}`, name: `Real group number ${n}`, slug: `real-${n}`, description: 'A group on this node', avatarUrl: null,
            category: 'other', createdBy: 'someone', joinPolicy: 'open', createdAt: '2026-10-01', updatedAt: '2026-10-01', memberCount: 3,
        });
        net.answer = name => (name === 'fetchGroups' ? Promise.resolve(Array.from({ length: 12 }, (_, i) => group(i + 1))) : emptyAnswer(name));
        await render(createElement(ProjectsScreen));
        expect(host.querySelector('[data-testid="page-title-commons"]')?.textContent).toContain('Commons');
        expect(text()).toContain('Real group number 12');
        const strip = text().indexOf(host.querySelector('[data-testid="local-community-strip"]')!.textContent!);
        expect(strip).toBeGreaterThan(-1);
        expect(strip).toBeLessThan(text().indexOf('Real group number 1'));
        expect(text().indexOf(SAMPLE_COMMUNITY.enterprises[0].name)).toBeLessThan(text().indexOf('Real group number 1'));
    });

    it('Example Valley\'s enterprise and project are the list\'s real cards, once each, marked, inside the preview; the list holds none (review of #2063, B2)', async () => {
        rememberProfile('global', WORLDWIDE);
        net.answer = name => (name === 'fetchGroups' ? Promise.resolve([{
            id: 'g1', name: 'Garden group', slug: 'garden', description: 'A real group on this node', avatarUrl: null,
            category: 'other', createdBy: 'someone', joinPolicy: 'open', createdAt: '2026-10-01', updatedAt: '2026-10-01', memberCount: 3,
        }]) : emptyAnswer(name));
        await render(createElement(ProjectsScreen));
        const preview = host.querySelector('[data-testid="commons-preview"]')!;
        const e = SAMPLE_COMMUNITY.enterprises[0];
        const p = SAMPLE_COMMUNITY.projects[0];
        expect(text().split(e.name).length).toBe(2);
        expect(text().split(p.title).length).toBe(2);
        const cards = Array.from(host.querySelectorAll('[data-testid="sample-enterprise-card"]'));
        expect(cards).toHaveLength(2);
        for (const card of cards) {
            expect(preview.contains(card)).toBe(true);
            expect(card.textContent).toContain('Local community');
        }
        expect(cards[0].textContent).toContain(e.name);
        expect(cards[1].textContent).toContain(p.title);
        // The real group follows, outside the preview, with no pill; no Projects or Enterprises chip (none here to list).
        expect(text()).toContain('Garden group');
        expect(text().indexOf('Garden group')).toBeGreaterThan(text().indexOf(p.title));
        expect(text()).not.toContain('🌱 Projects');
        // A card opens the real page, by the sample id, which draws it from the sample.
        await act(async () => { (cards[0] as HTMLElement).click(); });
        expect(routes.pushed.some(x => x.includes(e.id))).toBe(true);
    });

    it('switching to the Decide tab shows the DecideSection fed the sample decisions in preview mode', async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(ProjectsScreen));
        const decideTab = host.querySelector('[aria-label="Decide Section"]') as HTMLElement | null;
        expect(decideTab).not.toBeNull();
        await act(async () => { decideTab!.click(); });
        await settle();
        const section = host.querySelector('[data-testid="decide-section"]');
        expect(section).not.toBeNull();
        expect(section?.getAttribute('data-preview')).toBe('true');
        expect(section?.textContent).toContain(SAMPLE_COMMUNITY.decisions[0].question);
        expect(host.querySelector('[data-testid="voice-credits-card"]')?.textContent).toContain('582');
    });

    it('on the global node the Decide tab has no enterprise preview card and its first content is the Decide screen\'s own; the Groups tab still has it', async () => {
        rememberProfile('global', WORLDWIDE);
        await render(createElement(ProjectsScreen));
        expect(host.querySelector('[data-testid="commons-preview"]')).not.toBeNull();
        expect(host.querySelectorAll('[data-testid="sample-enterprise-card"]')).toHaveLength(2);
        const bakery = SAMPLE_COMMUNITY.enterprises[0];
        expect(text()).toContain(bakery.name);

        const decideTab = host.querySelector('[aria-label="Decide Section"]') as HTMLElement | null;
        expect(decideTab).not.toBeNull();
        await act(async () => { decideTab!.click(); });
        await settle();

        expect(host.querySelector('[data-testid="commons-preview"]')).toBeNull();
        expect(host.querySelectorAll('[data-testid="sample-enterprise-card"]')).toHaveLength(0);
        expect(text()).not.toContain(bakery.name);

        const decideSection = host.querySelector('[data-testid="decide-section"]');
        expect(decideSection).not.toBeNull();
        expect(decideSection?.getAttribute('data-preview')).toBe('true');

        const groupsTab = host.querySelector('[aria-label="Groups Section"]') as HTMLElement | null;
        expect(groupsTab).not.toBeNull();
        await act(async () => { groupsTab!.click(); });
        await settle();

        expect(host.querySelector('[data-testid="commons-preview"]')).not.toBeNull();
        expect(host.querySelectorAll('[data-testid="sample-enterprise-card"]')).toHaveLength(2);
        expect(text()).toContain(bakery.name);
    });
});

describe("a phone that has never heard the worldwide community's profile", () => {
    it("starts as a local community; the member's own answers that land after the switch to preview never draw over it", async () => {
        const held: Array<() => void> = [];
        const own: Record<string, unknown> = {
            getBalance: { earnedCredit: 50, commons: 4321, canOperate: true },
            getTreasuries: [{ publicKey: 'own-ent', name: 'Own Bakery Cooperative', kind: 'enterprise', liveOffers: 3 }],
            getDecisions: { decisions: [{ id: 'own-d', title: 'Own decision to fund a shed', status: 'open', authorPubkey: 'x' }], canPropose: true },
            getAllCommunityMembers: [{ publicKey: 'm1', callsign: 'OwnNeighbour' }],
        };
        net.answer = name => (name in own ? new Promise(resolve => held.push(() => resolve(own[name]))) : emptyAnswer(name));
        let profileLands!: () => void;
        globalThis.fetch = vi.fn((url: unknown) => {
            net.calls.push(`fetch ${String(url)}`);
            return new Promise<Response>(resolve => {
                profileLands = () => resolve(new Response(JSON.stringify({ profile: 'global', features: WORLDWIDE }), { status: 200 }));
            });
        }) as typeof fetch;
        await render(createElement(ProjectsScreen));
        expect(net.calls).toEqual(expect.arrayContaining(['db.getBalance', 'db.getTreasuries', `fetch ${NODE}/api/community/info`]));
        expect(host.querySelector('[data-testid="commons-preview"]')).toBeNull();
        profileLands();
        await settle();
        expect(host.querySelector('[data-testid="commons-preview"]')).not.toBeNull();
        // Now the member's own answers land, one by one as the screen asks.
        for (let i = 0; i < 4 && held.length; i++) { await act(async () => { held.shift()!(); }); await settle(); }
        expect(text()).not.toContain('Own Bakery Cooperative');
        expect(text()).not.toContain('Own decision to fund a shed');
        expect(text()).not.toMatch(/4,?321/);
        // The explainer reads the pool it is given: the preview's own, never the member's.
        const about = host.querySelector('[aria-label="About the Commons"]') as HTMLElement | null;
        if (about) { await act(async () => { about.click(); }); expect(text()).not.toMatch(/pool 4,?321/); }
    });
});
