// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Learn on the phone, recognition (slice K8; DESIGN-local-knowledge-fable.md §2.10, §3.7): the opener's half of Thank, and the
// badge on the writer's line. One table over each reader of a page (a member, an owner or admin, the page's writer, a visitor, a
// page gathered with the assistant, Beans not live here, Learn off, the worldwide preview) -> "🫘 Thank {name}" offered or not,
// and what a tap opens: the Ledger tab, plain (no route params: a link from outside the app can fill those), with the writer's
// key and the note 'Thanks for "{title}"' handed over in memory (utils/send-handoff.ts; no name: the Ledger reads it from the
// member list). Nothing is sent from the page. The Ledger's half (can send / first trade / positive balance) is ledger-send-start-render.test.ts. The web's twin
// is apps/pwa/src/pages/LearnPage.thank.test.tsx. The node, the router, the role and the copy are faked at their edges.

const ME = 'me'.padEnd(64, '0');
const ADA = 'ada'.padEnd(64, '0');
const h = vi.hoisted(() => ({
    mode: 'live' as 'live' | 'preview' | 'hidden' | undefined,
    checks: false,
    identity: null as null | { publicKey: string; privateKey: string },
    byId: null as null | Record<string, unknown>,
    sent: [] as Array<{ method: string; path: string; body: any }>,
    reads: [] as string[],
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({ useRouter: () => router, useLocalSearchParams: () => ({}), router }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../post-photo', () => ({ askForPostPhoto: vi.fn() }));
vi.mock('../../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button'), ScrollView: host('div'), ActivityIndicator: host('i'),
        TextInput: ({ value, onChangeText, testID }: any) => el('input', { value, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
        Keyboard: { dismiss: vi.fn() },
        Linking: { openURL: vi.fn(async () => {}) },
        Alert: { alert: vi.fn() },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (make: any) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: h.identity }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => h.mode }));
// A picture the node gives by path is drawn from the community's address (utils/node-uri.ts): read from the phone's store on a device.
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => 'https://node.test') }));
vi.mock('../../components/learn/useLearnWriter', () => ({
    useLearnWriter: (live: boolean) => (live ? { checks: h.checks, waiting: 0 } : { checks: false, waiting: 0 }),
    readMyDrafts: vi.fn(async () => null),
    forgetLearnRole: vi.fn(async () => {}),
}));
vi.mock('../db', () => ({
    signedGet: vi.fn(async (path: string) => {
        h.reads.push(path);
        if (!h.byId) throw new Error('offline');
        return { ok: true, json: async () => [h.byId] };
    }),
    signedRequestWithMethod: vi.fn(async (method: string, path: string, body: any) => { h.sent.push({ method, path, body }); return {}; }),
    reportAbuse: vi.fn(async () => ({})),
}));
// The writer's card draws what it is given: its name, and the badge line when there is one (components/AuthorCard.tsx).
vi.mock('../../components/AuthorCard', () => ({
    AuthorCard: ({ callsign, label, badge }: any) => createElement('div', { 'data-testid': 'author-card' }, `${label}: ${callsign}`,
        badge ? createElement('span', { 'data-testid': 'author-badge' }, badge) : null),
    useMemberRating: () => ({ average: null, count: 0 }),
}));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/PostTagChips', () => ({ PostTagChips: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../../components/chat/ChatPhoto', () => ({ ChatPhotoViewer: () => null }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));

import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import { takeSendRequest } from '../send-handoff';

const page = (extra: Record<string, unknown> = {}, k: Record<string, unknown> = {}) => ({
    id: 'tip', title: 'How recycling works at the tip', description: 'Sort it first.', category: 'local-services', photos: [],
    authorPublicKey: ADA, authorCallsign: 'Ada', status: 'active', active: true,
    knowledge: { sources: [], place: null, lang: null, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 4, gathered: false, ...k },
    ...extra,
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    takeSendRequest();   // nothing handed over from the case before
    Object.assign(h, { mode: 'live', checks: false, identity: { publicKey: ME, privateKey: 'p' }, byId: null, sent: [], reads: [] });
    vi.clearAllMocks();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function showPage(p: Record<string, unknown>, beansLive: boolean) {
    act(() => root.render(createElement(KnowledgeDetail, { page: p as any, beansLive }) as any));
    await settle();
}

type Reader = 'member' | 'checker' | 'writer' | 'visitor' | 'gathered' | 'beans-not-live' | 'off' | 'preview';
describe('the table: who is offered "🫘 Thank {name}", and what it opens (§2.10, §3.7)', () => {
    const TABLE: Array<[Reader, boolean]> = [
        ['member', true],
        ['checker', true],
        // No button for oneself.
        ['writer', false],
        ['visitor', false],
        // Gathered with the assistant: nobody's own writing.
        ['gathered', false],
        // Beans off here, or the worldwide preview of them: there is no Send form to open.
        ['beans-not-live', false],
        ['off', false],
        ['preview', false],
    ];
    it.each(TABLE)('%s: Thank offered %s (red when the button shows where the design says no, or is missing where it says yes)', async (reader, offered) => {
        let p = page();
        if (reader === 'checker') h.checks = true;
        if (reader === 'writer') p = page({ authorPublicKey: ME, authorCallsign: 'Me' });
        if (reader === 'visitor') h.identity = null;
        if (reader === 'gathered') p = page({ authorPublicKey: 'owen'.padEnd(64, '0'), authorCallsign: 'Owen' }, { gathered: true });
        if (reader === 'off') h.mode = 'hidden';
        if (reader === 'preview') h.mode = 'preview';
        await showPage(p, reader !== 'beans-not-live');
        expect(q('knowledge-page')).not.toBeNull();
        const button = q('knowledge-thank');
        expect(button !== null, `${reader}: Thank shown`).toBe(offered);
        if (offered) {
            expect(button!.textContent).toBe('🫘 Thank Ada');
            await act(async () => { button!.click(); });
            await settle();
            // The Ledger tab, with nothing in the route: the writer's key and the note are handed over in memory, taken once.
            expect(router.push.mock.calls).toEqual([['/(tabs)/ledger']]);
            expect(takeSendRequest()).toEqual({ to: ADA, note: 'Thanks for "How recycling works at the tip"' });
            expect(takeSendRequest()).toBeNull();
        }
        // Nothing is sent from the page for it: no tap, no Beans; and nothing is handed over where no button was tapped.
        expect(h.sent).toEqual([]);
        if (!offered) expect(takeSendRequest()).toBeNull();
    });
});

describe('the badge on the writer\'s line', () => {
    it.each([[true, true], [false, false], [undefined, false]] as const)('the node\'s read by id says writerLocalGuide %s: "🗺️ Local guide" shown %s', async (guide, shown) => {
        h.byId = { ...page({}, guide === undefined ? {} : { writerLocalGuide: guide }), type: 'knowledge' };
        await showPage(page(), true);
        expect(h.reads).toEqual(['/api/marketplace/posts?type=knowledge&id=tip']);
        expect(q('author-badge')?.textContent ?? null).toBe(shown ? '🗺️ Local guide' : null);
    });

    it('the copy never carries it: offline, or a copy that says so, shows none until the node\'s read by id says so', async () => {
        h.byId = null;
        await showPage(page({}, { writerLocalGuide: true }), true);
        expect(q('author-badge')).toBeNull();
    });

    it('the writer reads their own badge on their own page (the read by id is made for them too)', async () => {
        const own = page({ authorPublicKey: ME, authorCallsign: 'Me' });
        h.byId = { ...own, knowledge: { ...own.knowledge, writerLocalGuide: true }, type: 'knowledge' };
        await showPage(own, true);
        expect(q('author-badge')?.textContent).toBe('🗺️ Local guide');
    });

    it('a visitor, Learn off and the preview ask the node nothing for it', async () => {
        for (const set of [() => { h.identity = null; }, () => { h.mode = 'hidden'; }, () => { h.mode = 'preview'; }]) {
            Object.assign(h, { mode: 'live', identity: { publicKey: ME, privateKey: 'p' }, reads: [], byId: { ...page({}, { writerLocalGuide: true }), type: 'knowledge' } });
            set();
            await showPage(page(), true);
            expect(h.reads).toEqual([]);
            expect(q('author-badge')).toBeNull();
        }
    });
});
