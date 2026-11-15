// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Keeping Local knowledge right on the phone (slice K5 B; DESIGN-local-knowledge-fable.md §3.2 items 9-11, §3.5, §2.4, §2.10;
// the node is #3203). One table over each action ("This helped", "Still right", "Suggest a fix", "Mark as out of date") and each
// reader (a member, the page's writer, an owner or admin, a visitor, Learn switched off, the worldwide preview): what the page
// offers and what a tap sends. Then each refusal the node answers (a standby, the switch off, its own page, an owner's fix, a fix
// already waiting, a dropped connection) shows the node's own sentence and never a success it didn't give. The web's twin is
// apps/pwa/src/pages/LearnPage.keep.test.tsx. The node, the router, the role and the copy are faked at their edges.

const ME = 'me'.padEnd(64, '0');
const h = vi.hoisted(() => ({
    mode: 'live' as 'live' | 'preview' | 'hidden' | undefined,
    params: {} as Record<string, string>,
    checks: false,
    identity: null as null | { publicKey: string; privateKey: string },
    pages: [] as any[],
    byId: null as null | Record<string, unknown>,
    sent: [] as Array<{ method: string; path: string; body: any }>,
    refuse: null as null | { status?: number; message: string; code?: string },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({
    useRouter: () => router, useLocalSearchParams: () => h.params, router,
    useFocusEffect: (fn: () => void | (() => void)) => { useEffect(() => fn(), [fn]); },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, disabled, accessibilityState } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button'), ScrollView: host('div'), ActivityIndicator: host('i'),
        TextInput: ({ value, onChangeText, testID, placeholder }: any) => el('input', { value, placeholder, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }), emit: vi.fn() },
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
vi.mock('../../components/learn/useLearnWriter', () => ({
    useLearnWriter: (live: boolean) => (live ? { checks: h.checks, waiting: 0 } : { checks: false, waiting: 0 }),
    readMyDrafts: vi.fn(async () => null),
    forgetLearnRole: vi.fn(async () => {}),
}));
vi.mock('../post-photo', () => ({ askForPostPhoto: vi.fn() }));
vi.mock('../db', () => ({
    getKnowledgePost: vi.fn(async (id: string) => h.pages.find((p) => p.id === id) ?? null),
    signedGet: vi.fn(async () => {
        if (!h.byId) throw new Error('offline');
        return { ok: true, json: async () => [h.byId] };
    }),
    signedRequestWithMethod: vi.fn(async (method: string, path: string, body: any) => {
        h.sent.push({ method, path, body });
        const r = h.refuse;
        if (r) throw Object.assign(new Error(r.message), r.status === undefined ? {} : { status: r.status, code: r.code });
        const p = h.pages[0];
        if (path.endsWith('/helped')) return { helped: (p.knowledge.helped ?? 0) + (body.on ? 1 : -1), helpedByMe: body.on };
        if (path.endsWith('/checked')) return { post: { ...p, knowledge: { ...p.knowledge, checkedAt: '2026-11-16T00:00:00.000Z', outdatedAt: null, outdatedNote: null } } };
        if (path.endsWith('/outdated')) return { post: { ...p, knowledge: { ...p.knowledge, outdatedAt: '2026-11-16T00:00:00.000Z', outdatedNote: body.note || null } } };
        if (path.endsWith('/outdated/clear')) return { post: { ...p, knowledge: { ...p.knowledge, outdatedAt: null, outdatedNote: null } } };
        if (path.endsWith('/edit')) return { post: { ...p, title: body.title } };
        if (path === '/api/knowledge/drafts') return { draft: { id: 'fix-1', kind: 'fix', fixOf: p.id } };
        return {};
    }),
    reportAbuse: vi.fn(async () => ({})),
}));
vi.mock('../../components/AuthorCard', () => ({
    AuthorCard: ({ callsign, label }: any) => createElement('div', { 'data-testid': 'author-card' }, `${label}: ${callsign}`),
    useMemberRating: () => ({ average: null, count: 0 }),
}));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../../components/chat/ChatPhoto', () => ({ ChatPhotoViewer: () => null }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: vi.fn(() => ({})), requireOptionalNativeModule: vi.fn(() => null), EventEmitter: vi.fn(() => ({})), NativeModulesProxy: {} }));

import { KnowledgeDetail } from '../../components/learn/KnowledgeDetail';
import { editBody, fixBody, formOfPage, pageActions } from '../../components/learn/learn-keep';
import NewKnowledgeScreen from '../../app/learn/new';

const page = (extra: Record<string, unknown> = {}, k: Record<string, unknown> = {}) => ({
    id: 'tip', title: 'How recycling works at the tip', description: 'Sort it first.', category: 'local-services', photos: [],
    authorPublicKey: 'ada'.padEnd(64, '0'), authorCallsign: 'Ada', status: 'active', active: true,
    knowledge: {
        sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], place: 'Manse Road', lang: null,
        checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 2, gathered: false, ...k,
    },
    ...extra,
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(h, { mode: 'live', params: {}, checks: false, identity: { publicKey: ME, privateKey: 'p' }, pages: [page()], byId: null, sent: [], refuse: null });
    vi.clearAllMocks();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (element: any) => { act(() => root.render(element)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const has = (id: string) => q(id) !== null;
const click = async (id: string) => { const el = q(id); expect(el, id).toBeTruthy(); await act(async () => { el!.click(); }); await settle(); };
const type = (id: string, text: string) => {
    const input = q(id) as HTMLInputElement;
    expect(input, id).toBeTruthy();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const showPage = () => show(createElement(KnowledgeDetail, { page: h.pages[0] }));

type Reader = 'member' | 'writer' | 'checker' | 'visitor' | 'off' | 'preview';
function as(reader: Reader) {
    if (reader === 'writer') h.pages = [page({ authorPublicKey: ME, authorCallsign: 'Me' })];
    if (reader === 'checker') h.checks = true;
    if (reader === 'visitor') h.identity = null;
    if (reader === 'off') h.mode = 'hidden';
    if (reader === 'preview') h.mode = 'preview';
}

describe('the table: who is offered which action on a page (§2.4)', () => {
    // [reader, helped, fix, still right, mark out of date, edit]
    const TABLE: Array<[Reader, boolean, boolean, boolean, boolean, boolean]> = [
        ['member', true, true, false, false, false],
        ['writer', false, true, false, true, false],
        ['checker', true, false, true, true, true],
        ['visitor', false, false, false, false, false],
        ['off', false, false, false, false, false],
        ['preview', false, false, false, false, false],
    ];
    it.each(TABLE)('%s: helped %s, suggest a fix %s, still right %s, mark out of date %s, edit %s', async (reader, helped, fix, still, mark, edit) => {
        as(reader);
        await showPage();
        expect(has('knowledge-page')).toBe(true);
        expect(has('knowledge-helped')).toBe(helped);
        expect(has('knowledge-fix')).toBe(fix);
        expect(has('knowledge-still-right')).toBe(still);
        expect(has('knowledge-mark')).toBe(mark);
        expect(has('knowledge-edit')).toBe(edit);
        // Opening a page sends nothing: no tap, no stamp, no Beans.
        expect(h.sent).toEqual([]);
    });

    it('the rule itself, as the web holds it: an owner or admin who wrote the page edits it and has no tap of their own', () => {
        expect(pageActions({ signedIn: true, live: true, own: true, checks: true, outdated: false }))
            .toEqual({ helped: false, fix: false, edit: true, stillRight: true, markOutdated: true, clearMark: false });
        expect(pageActions({ signedIn: true, live: true, own: false, checks: true, outdated: true })).toMatchObject({ markOutdated: false, clearMark: true });
        expect(pageActions({ signedIn: true, live: true, own: true, checks: false, outdated: true })).toMatchObject({ markOutdated: false, clearMark: false });
    });

    it('the count shows from 1 beside the button, and to the writer without one; never at 0', async () => {
        await showPage();
        expect(q('knowledge-helped-count')!.textContent).toBe('Helped 2');
        as('writer');
        await showPage();
        expect(has('knowledge-helped')).toBe(false);
        expect(q('knowledge-helped-count')!.textContent).toBe('Helped 2');
        h.pages = [page({}, { helped: 0 })];
        await showPage();
        expect(has('knowledge-helped-count')).toBe(false);
    });
});

describe('what each action sends, and what the page shows after the node answers', () => {
    it('"This helped": on, shown as done with the new count; a second tap takes it back', async () => {
        await showPage();
        expect(q('knowledge-helped')!.textContent).toBe('👍 This helped');
        await click('knowledge-helped');
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/posts/tip/helped', body: { on: true } }]);
        expect(q('knowledge-helped')!.textContent).toBe('👍 Helped ✓');
        expect(q('knowledge-helped-count')!.textContent).toBe('Helped 3');
        await click('knowledge-helped');
        expect(h.sent[1]).toEqual({ method: 'POST', path: '/api/knowledge/posts/tip/helped', body: { on: false } });
    });

    it('a member who tapped before reads it as done: a signed read of the page by id says so (the copy never does)', async () => {
        h.byId = page({}, { helped: 5, helpedByMe: true });
        await showPage();
        expect(q('knowledge-helped')!.textContent).toBe('👍 Helped ✓');
        expect(q('knowledge-helped-count')!.textContent).toBe('Helped 5');
    });

    it('"Still right": shown as done, and the page is checked this month', async () => {
        as('checker');
        await showPage();
        await click('knowledge-still-right');
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/posts/tip/checked', body: undefined }]);
        expect(q('knowledge-still-right')!.textContent).toBe('Still right ✓');
        expect(q('knowledge-still-right')!.getAttribute('data-disabled')).toBe('true');
        expect(q('knowledge-page')!.textContent).toContain('Checked Nov 2026');
    });

    it('"Mark as out of date" with a note: the amber box shows it; an owner then reads "Clear the mark"', async () => {
        as('checker');
        await showPage();
        await click('knowledge-mark');
        type('knowledge-mark-note', '  The tip closes on Mondays now  ');
        await click('knowledge-mark-send');
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/posts/tip/outdated', body: { note: 'The tip closes on Mondays now' } }]);
        expect(q('knowledge-outdated')!.textContent).toContain('The tip closes on Mondays now');
        expect(has('knowledge-mark')).toBe(false);
        await click('knowledge-clear');
        expect(h.sent[1]).toEqual({ method: 'POST', path: '/api/knowledge/posts/tip/outdated/clear', body: undefined });
        expect(has('knowledge-outdated')).toBe(false);
    });

    it('the node\'s answer stays shown until the copy holds that change: a sync that brings an older copy doesn\'t undo it', async () => {
        as('checker');
        h.pages = [page({ updatedAt: '2026-11-01T00:00:00.000Z' })];
        await showPage();
        const later = '2026-11-16T09:00:00.000Z';
        const mod = await import('../db');
        (mod.signedRequestWithMethod as any).mockImplementationOnce(async (method: string, path: string, body: any) => {
            h.sent.push({ method, path, body });
            return { post: { ...h.pages[0], updatedAt: later, knowledge: { ...h.pages[0].knowledge, outdatedAt: later, outdatedNote: body.note } } };
        });
        await click('knowledge-mark');
        type('knowledge-mark-note', 'Closed on Mondays');
        await click('knowledge-mark-send');
        expect(q('knowledge-outdated')!.textContent).toContain('Closed on Mondays');
        // An unrelated sync re-reads the copy, which doesn't hold the mark yet: the mark stays.
        await show(createElement(KnowledgeDetail, { page: { ...h.pages[0] } }));
        expect(q('knowledge-outdated')!.textContent).toContain('Closed on Mondays');
        // The copy catches up (and here another admin's later word wins): the copy is shown.
        await show(createElement(KnowledgeDetail, { page: page({ updatedAt: '2026-11-16T10:00:00.000Z' }, { outdatedAt: '2026-11-16T10:00:00.000Z', outdatedNote: 'Open again' }) }));
        expect(q('knowledge-outdated')!.textContent).toContain('Open again');
    });

    it('"Suggest a fix" and "Edit" open the form screen for this page', async () => {
        await showPage();
        expect(q('knowledge-fix')!.textContent).toBe('Something changed? Suggest a fix');
        await click('knowledge-fix');
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn/new', params: { fix: 'tip' } });
        as('writer');
        await showPage();
        expect(q('knowledge-fix')!.textContent).toBe('Suggest a fix');
        h.checks = true;
        await showPage();
        await click('knowledge-edit');
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn/new', params: { edit: 'tip' } });
    });
});

describe('the form as "Suggest a fix" and as "Edit" (§3.5)', () => {
    it('a fix: "WHAT CHANGED? *" first, the page as it shows, no photo; the note is asked for; only what changed is sent, to the waiting list', async () => {
        h.params = { fix: 'tip' };
        await show(createElement(NewKnowledgeScreen));
        expect(host.textContent).toContain('WHAT CHANGED? *');
        expect((q('learn-new-title') as HTMLInputElement).value).toBe('How recycling works at the tip');
        expect((q('learn-new-place') as HTMLInputElement).value).toBe('Manse Road');
        expect(has('learn-new-add-photo')).toBe(false);
        expect(host.textContent).toContain('An owner or admin checks it first. The page stays as it is until then.');
        expect(q('learn-new-send')!.textContent).toBe('Send to the admins');
        await click('learn-new-send');
        expect(q('learn-new-problem')!.textContent).toBe('Say what changed.');
        expect(h.sent).toEqual([]);
        type('learn-new-note', 'Closed on Mondays since March');
        type('learn-new-body', 'Sort it first. Closed on Mondays.');
        await click('learn-new-send');
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/drafts', body: { fixOf: 'tip', note: 'Closed on Mondays since March', body: 'Sort it first. Closed on Mondays.' } }]);
        expect(host.textContent).toContain('An owner or admin will check it.');
        expect(h.sent.some((s) => s.path.endsWith('/edit'))).toBe(false);
    });

    it('an owner\'s edit saves at once, in the page\'s language, without photos, and goes back to the page', async () => {
        h.checks = true;
        h.pages = [page({}, { lang: 'es' })];
        h.params = { edit: 'tip' };
        await show(createElement(NewKnowledgeScreen));
        expect(q('learn-new-send')!.textContent).toBe('Save');
        type('learn-new-title', 'How the tip works now');
        await click('learn-new-send');
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/posts/tip/edit', body: {
            title: 'How the tip works now', body: 'Sort it first.', topic: 'local-services', place: 'Manse Road',
            sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], lang: 'es',
        } }]);
        expect(router.back).toHaveBeenCalled();
    });

    it('a page that isn\'t in Learn any more: one line, no form', async () => {
        h.pages = [];
        h.params = { fix: 'gone' };
        await show(createElement(NewKnowledgeScreen));
        expect(has('learn-new-page-missing')).toBe(true);
        expect(has('learn-new-send')).toBe(false);
    });

    it('the rules: the note alone sends no part; a cleared place and a removed link are sent; an edit always sends place and sources', () => {
        const p = page() as any;
        expect(fixBody(p, formOfPage(p), ' Gone ')).toEqual({ fixOf: 'tip', note: 'Gone' });
        expect(fixBody(p, { ...formOfPage(p), title: ` ${p.title} `, topic: 'emergencies', place: '', sources: [] }, 'x'))
            .toEqual({ fixOf: 'tip', note: 'x', topic: 'emergencies', place: '', sources: [] });
        expect(editBody(p, { ...formOfPage(p), place: '', sources: [] })).toEqual({ title: p.title, body: p.description, topic: 'local-services', place: '', sources: [] });
    });
});

describe('a refusal shows the node\'s own sentence, never a success it didn\'t give', () => {
    const STANDBY = 'This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.';
    const OFF = 'Learn isn’t part of this community.';
    const CASES: Array<[string, Reader, { status?: number; message: string; code?: string }, () => Promise<void>, () => void]> = [
        ['helped, standby', 'member', { status: 503, message: STANDBY, code: 'standby' }, () => click('knowledge-helped'),
            () => expect(q('knowledge-helped')!.textContent).toBe('👍 This helped')],
        ['helped, switch off', 'member', { status: 404, message: OFF, code: 'feature_off' }, () => click('knowledge-helped'),
            () => expect(q('knowledge-helped-count')!.textContent).toBe('Helped 2')],
        ['helped, own page', 'member', { status: 403, message: 'This is your own page: “This helped” is for other members.', code: 'own_page' }, () => click('knowledge-helped'),
            () => expect(q('knowledge-helped')!.textContent).toBe('👍 This helped')],
        ['still right, standby', 'checker', { status: 503, message: STANDBY, code: 'standby' }, () => click('knowledge-still-right'),
            () => expect(q('knowledge-still-right')!.textContent).toBe('Still right')],
        ['still right, not an admin any more', 'checker', { status: 403, message: 'Only this community’s owners and admins can do this to Local knowledge.', code: 'admins_only' },
            () => click('knowledge-still-right'), () => expect(q('knowledge-still-right')!.textContent).toBe('Still right')],
        ['mark, switch off', 'writer', { status: 404, message: OFF, code: 'feature_off' }, async () => { await click('knowledge-mark'); await click('knowledge-mark-send'); },
            () => expect(has('knowledge-outdated')).toBe(false)],
        ['mark, a member who is neither', 'writer', { status: 403, message: 'Only its writer, or this community’s owners and admins, can mark it out of date.', code: 'writer_or_admins' },
            async () => { await click('knowledge-mark'); await click('knowledge-mark-send'); }, () => expect(has('knowledge-outdated')).toBe(false)],
        ['still right, dropped connection', 'checker', { message: 'Network request failed' }, () => click('knowledge-still-right'),
            () => expect(q('knowledge-still-right')!.textContent).toBe('Still right')],
    ];
    it.each(CASES)('%s', async (_name, reader, refuse, go, unchanged) => {
        as(reader);
        await showPage();
        h.refuse = refuse;
        await go();
        const said = refuse.status === undefined ? 'Couldn’t send it. Check your connection and try again.' : refuse.message;
        expect(q('knowledge-refusal')!.textContent).toBe(said);
        unchanged();
    });

    const FIX_REFUSALS: Array<[string, { status: number; message: string; code: string }]> = [
        ['a fix already waiting', { status: 409, message: 'You’ve already suggested a fix to this page. Wait for an answer, or take it back.', code: 'fix_waiting' }],
        ['an owner or admin (edit instead)', { status: 409, message: 'You’re an owner or admin here, so you change a page at once: edit it instead.', code: 'edit_instead' }],
        ['a standby', { status: 503, message: STANDBY, code: 'standby' }],
        ['the switch off', { status: 404, message: OFF, code: 'feature_off' }],
        ['too many waiting', { status: 429, message: 'You have 3 waiting already. Wait for an answer, or take one back.', code: 'too_many_waiting' }],
    ];
    it.each(FIX_REFUSALS)('a fix refused (%s) says so under the button and shows no "Sent"', async (_name, refuse) => {
        h.params = { fix: 'tip' };
        await show(createElement(NewKnowledgeScreen));
        type('learn-new-note', 'Closed on Mondays');
        h.refuse = refuse;
        await click('learn-new-send');
        expect(q('learn-new-problem')!.textContent).toBe(refuse.message);
        expect(has('learn-new-done-screen')).toBe(false);
    });
});
