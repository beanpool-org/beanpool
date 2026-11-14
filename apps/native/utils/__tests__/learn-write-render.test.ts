// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Writing Local knowledge on the phone (slice K4; DESIGN-local-knowledge-fable.md §3.3, §3.4 as amended): Learn's button and its
// "waiting" line, the form as a screen (a member's suggestion and an owner's or admin's own page), and My suggestions. The node,
// the router, the role and the photo picker are faked at their edges; the screens and the words are the real ones.

const h = vi.hoisted(() => ({
    mode: 'live' as 'live' | 'preview' | 'hidden' | undefined,
    params: {} as Record<string, string>,
    checks: false,
    waiting: 0,
    mine: null as null | { waiting: any[]; answered: any[] },
    pages: [] as any[],
    sent: [] as Array<{ method: string; path: string; body: any }>,
    answer: null as null | ((path: string, body: any) => any),
    alerts: [] as Array<{ title: string; buttons?: Array<{ text: string; onPress?: () => void }> }>,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({
    useRouter: () => router, useLocalSearchParams: () => h.params, router,
    useFocusEffect: (fn: () => void | (() => void)) => { useEffect(() => fn(), [fn]); },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('expo-image', () => ({ Image: ({ source, accessibilityLabel }: any) => createElement('img', { src: source?.uri, alt: accessibilityLabel }) }));
vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    // `data-accessible` is RN's own default: a Pressable is an accessibility element unless told `accessible={false}`
    // (Pressable.js: accessible !== false), a View only when told `accessible`. On iOS such an element folds its children in.
    // Text is left out on purpose: its words fold into the button around it, as they should.
    const host = (tag: string, accessibleByDefault = false) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled, accessibilityState, accessible } = props;
        const attrs: Record<string, unknown> = {};
        attrs['data-accessible'] = String(accessibleByDefault ? accessible !== false : accessible === true);
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    };
    return {
        View: host('div'), Text: host('span'), Pressable: host('button', true), ScrollView: host('div'), ActivityIndicator: host('i'),
        Modal: ({ visible, children }: any) => (visible ? el('div', { 'data-testid': 'modal' }, children) : null),
        TextInput: ({ value, onChangeText, testID, placeholder, accessibilityLabel }: any) =>
            el('input', { value, placeholder, 'aria-label': accessibilityLabel, 'data-testid': testID, onChange: (e: any) => onChangeText(e.target.value) }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }), emit: vi.fn() },
        Keyboard: { dismiss: vi.fn() },
        Alert: { alert: vi.fn((title: string, _message?: string, buttons?: any[]) => { h.alerts.push({ title, buttons }); }) },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (make: any) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.padEnd(64, '0'), privateKey: 'p' } }) }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => h.mode }));
vi.mock('../../components/learn/useLearnWriter', () => ({
    useLearnWriter: (live: boolean) => (live ? { checks: h.checks, waiting: h.waiting } : { checks: false, waiting: 0 }),
    readMyDrafts: vi.fn(async () => h.mine),
    forgetLearnRole: vi.fn(async () => {}),
}));
vi.mock('../post-photo', () => ({ askForPostPhoto: (add: (p: string) => void) => add('data:image/jpeg;base64,AAAA') }));
vi.mock('../db', () => ({
    getKnowledgePosts: vi.fn(async () => h.pages),
    signedGet: vi.fn(async () => { throw new Error('offline'); }),
    signedRequestWithMethod: vi.fn(async (method: string, path: string, body: any) => {
        h.sent.push({ method, path, body });
        return h.answer ? h.answer(path, body) : {};
    }),
}));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    ExampleHeader: ({ text }: any) => createElement('div', { 'data-testid': 'example-header' }, text),
    SHEET_ROUTES: { start: '/start-community', nearYou: '/find-community' },
    markTone: () => ({ fg: '#000', bg: '#fff', border: '#000' }),
}));
vi.mock('../../components/ListPhoto', () => ({ ListPhoto: ({ fallback }: any) => createElement('div', null, fallback) }));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { forgetLearnRole, readMyDrafts } from '../../components/learn/useLearnWriter';
import LearnScreen from '../../app/learn';
import NewKnowledgeScreen from '../../app/learn/new';
import MySuggestionsScreen from '../../app/learn/mine';

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(h, { mode: 'live', params: {}, checks: false, waiting: 0, mine: null, pages: [], sent: [], answer: null, alerts: [] });
    vi.clearAllMocks();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguage('en');
});

const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); }); };
const show = async (element: any) => { act(() => root.render(element)); await settle(); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const type = (id: string, text: string) => {
    const input = q(id) as HTMLInputElement;
    expect(input, id).toBeTruthy();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const text = () => host.textContent ?? '';
const fill = () => {
    type('learn-new-title', 'How recycling works at the tip');
    type('learn-new-body', 'Bring it sorted. The tip is open daily.');
};

describe("Learn's own door to writing (amended §3.1 items 4 and 8)", () => {
    it('a member reads "＋ Suggest knowledge" at the bottom; it opens the form, told it came from Learn', async () => {
        await show(createElement(LearnScreen));
        expect(q('learn-suggest')?.textContent).toBe('＋ Suggest knowledge');
        await click(q('learn-suggest'));
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn/new', params: { from: 'learn' } });
    });

    it('an owner or admin reads "＋ Add local knowledge" (theirs publishes at once)', async () => {
        h.checks = true;
        await show(createElement(LearnScreen));
        expect(q('learn-suggest')?.textContent).toBe('＋ Add local knowledge');
    });

    it('with nothing in Learn, the empty line keeps the same button', async () => {
        await show(createElement(LearnScreen));
        expect(q('learn-empty')?.textContent).toBe('Nothing here yet. Know something locals should know?');
        expect(q('learn-suggest')).not.toBeNull();
    });

    it('an empty search offers "Suggest knowledge" beside "Search the Market…"', async () => {
        await show(createElement(LearnScreen));
        type('learn-search', 'kayak');
        await settle();
        expect(q('learn-search-suggest')?.textContent).toBe('Suggest knowledge');
        await click(q('learn-search-suggest'));
        expect(router.push).toHaveBeenCalledWith({ pathname: '/learn/new', params: { from: 'learn' } });
    });

    it('a member with something waiting reads "1 of yours is waiting for an admin ›", which opens My suggestions', async () => {
        h.waiting = 1;
        await show(createElement(LearnScreen));
        expect(q('learn-waiting')?.textContent).toBe('1 of yours is waiting for an admin ›');
        await click(q('learn-waiting'));
        expect(router.push).toHaveBeenCalledWith('/learn/mine');
        h.waiting = 0;
        await show(createElement(LearnScreen, { key: 2 }));
        expect(q('learn-waiting')).toBeNull();
    });

    it('in the worldwide preview the button opens the sheet that leads to a local community, never the form', async () => {
        h.mode = 'preview';
        await show(createElement(LearnScreen));
        await click(q('learn-suggest'));
        expect(router.push).not.toHaveBeenCalled();
        expect(q('modal')).not.toBeNull();
    });
});

describe('the form, a member (§3.3)', () => {
    it("has the design's fields, in order, the member's button and the line under it", async () => {
        await show(createElement(NewKnowledgeScreen));
        const t = text();
        const order = [
            'Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.',
            'TITLE *', 'WHAT TO KNOW *', 'TOPIC *', 'WHERE (OPTIONAL)', 'WHERE CAN PEOPLE CHECK THIS? (OPTIONAL)', 'PHOTO (OPTIONAL)',
            'Your own photo. Without one, a picture for the topic is shown.', 'Send to the admins', 'An owner or admin checks it before anyone sees it.',
        ];
        let at = -1;
        for (const words of order) {
            const next = t.indexOf(words, at + 1);
            expect(next, words).toBeGreaterThan(at);
            at = next;
        }
        expect((q('learn-new-title') as HTMLInputElement).placeholder).toBe('e.g. How recycling works at the tip');
        expect((q('learn-new-body') as HTMLInputElement).placeholder).toBe('Put the answer first. Then the details.');
        expect((q('learn-new-place') as HTMLInputElement).placeholder).toBe('e.g. The tip on Manse Road');
        for (const topic of ['emergencies', 'local-services', 'getting-around', 'growing-animals', 'health-help', 'places-history', 'good-to-know']) {
            expect(q(`learn-new-topic-${topic}`), topic).not.toBeNull();
        }
    });

    it('says what is missing and sends nothing', async () => {
        await show(createElement(NewKnowledgeScreen));
        await click(q('learn-new-send'));
        expect(q('learn-new-problem')?.textContent).toBe('Give it a title.');
        fill();
        await click(q('learn-new-send'));
        expect(q('learn-new-problem')?.textContent).toBe('Pick a topic.');
        expect(h.sent).toEqual([]);
    });

    it('sends to the waiting list with its link and photo, then says "Sent" and that they will hear back', async () => {
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-local-services'));
        type('learn-new-place', 'The tip on Manse Road');
        await click(q('learn-new-add-link'));
        type('learn-new-link-url-0', 'https://council.example/tip');
        type('learn-new-link-label-0', 'The council');
        await click(q('learn-new-add-photo'));
        await click(q('learn-new-send'));
        expect(h.sent).toEqual([{
            method: 'POST',
            path: '/api/knowledge/drafts',
            body: {
                title: 'How recycling works at the tip', body: 'Bring it sorted. The tip is open daily.', topic: 'local-services',
                place: 'The tip on Manse Road', sources: [{ url: 'https://council.example/tip', label: 'The council' }], lang: 'en',
                photos: ['data:image/jpeg;base64,AAAA'],
            },
        }]);
        expect(text()).toContain('Sent');
        expect(text()).toContain('An owner or admin will check it. You’ll hear back here.');
        await click(q('learn-new-done'));
        expect(router.back).toHaveBeenCalled();
    });

    it('a link that is not a web address is refused before sending', async () => {
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-good-to-know'));
        await click(q('learn-new-add-link'));
        type('learn-new-link-url-0', 'council.example');
        await click(q('learn-new-send'));
        expect(q('learn-new-problem')?.textContent).toBe('A link must start with https:// or http://');
        expect(h.sent).toEqual([]);
    });

    it('at most five links and three photos', async () => {
        await show(createElement(NewKnowledgeScreen));
        for (let i = 0; i < 5; i += 1) await click(q('learn-new-add-link'));
        expect(q('learn-new-link-url-4')).not.toBeNull();
        expect(q('learn-new-add-link')).toBeNull();
        for (let i = 0; i < 3; i += 1) await click(q('learn-new-add-photo'));
        expect(host.querySelectorAll('img')).toHaveLength(3);
        expect(q('learn-new-add-photo')).toBeNull();
    });

    it("the node's refusal shows in its own words (it speaks the member's language), and the form keeps what was written", async () => {
        h.answer = () => { throw Object.assign(new Error('You have 3 waiting already. Wait for an answer, or take one back.'), { status: 429, code: 'too_many_waiting' }); };
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-emergencies'));
        await click(q('learn-new-send'));
        expect(q('learn-new-problem')?.textContent).toBe('You have 3 waiting already. Wait for an answer, or take one back.');
        expect((q('learn-new-title') as HTMLInputElement).value).toBe('How recycling works at the tip');
    });

    it('no answer from the node reads "Couldn’t send it…", never the phone’s own English, and the form keeps what was written', async () => {
        const noAnswers: Array<[string, unknown]> = [
            // React Native's fetch with no signal, and utils/db.ts's own throws before it asks: no status, so not the node's words.
            ['no signal', new TypeError('Network request failed')],
            ['off-grid', new Error('You are off-grid. Please connect to a BeanPool Node.')],
            ['no identity', new Error('No identity found. You must be logged in.')],
            // An answer without the node's words: a proxy's 502 page, an empty 500.
            ['unsaid', Object.assign(new Error('Bad Gateway'), { status: 502, unsaid: true })],
            ['empty', Object.assign(new Error('  '), { status: 500 })],
        ];
        for (const [name, thrown] of noAnswers) {
            h.answer = () => { throw thrown; };
            h.sent = [];
            act(() => root.unmount());
            root = createRoot(host);
            await show(createElement(NewKnowledgeScreen, { key: name }));
            fill();
            await click(q('learn-new-topic-emergencies'));
            await click(q('learn-new-send'));
            expect(h.sent.map((x) => x.path), name).toEqual(['/api/knowledge/drafts']);
            expect(q('learn-new-problem')?.textContent, name).toBe('Couldn’t send it. Check your connection and try again.');
            expect((q('learn-new-title') as HTMLInputElement).value, name).toBe('How recycling works at the tip');
            expect(q('learn-new-done-screen'), name).toBeNull();
        }
    });

    it('an owner or admin the phone took for a member: the node says publish instead, and the button becomes Publish', async () => {
        h.answer = (path) => {
            if (path === '/api/knowledge/drafts') throw Object.assign(new Error('You’re an owner or admin here, so your own page goes into Learn at once: publish it instead.'), { status: 409, code: 'publish_instead' });
            return { post: { id: 'p1' } };
        };
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-emergencies'));
        await click(q('learn-new-send'));
        expect(q('learn-new-send')?.textContent).toBe('Publish');
        expect(forgetLearnRole).toHaveBeenCalledTimes(1);
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/drafts', '/api/knowledge/posts']);
        expect(text()).toContain('Published');
    });

    it('every word on it comes through t()', async () => {
        setLanguage('xx');
        await show(createElement(NewKnowledgeScreen));
        expect(text()).toContain(pseudoLocalise('Send to the admins'));
        expect(text()).toContain(pseudoLocalise('WHERE CAN PEOPLE CHECK THIS? (OPTIONAL)'));
        expect(text()).not.toContain('Send to the admins');
    });
});

describe('the form, an owner or admin (§3.3 as amended)', () => {
    it('reads Publish, says the Pulse announces it, publishes at once, then "Published" with Open Learn', async () => {
        h.checks = true;
        h.answer = () => ({ post: { id: 'p1' } });
        await show(createElement(NewKnowledgeScreen));
        expect(q('learn-new-send')?.textContent).toBe('Publish');
        expect(text()).toContain('It goes into Learn, and the Pulse announces it.');
        fill();
        await click(q('learn-new-topic-health-help'));
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/posts']);
        expect(text()).toContain('Published');
        expect(text()).toContain('It’s in Learn.');
        await click(q('learn-new-open-learn'));
        expect(router.replace).toHaveBeenCalledWith('/learn');
    });

    it('an owner or admin no longer (the remembered role is out of date): the node says admins only, and it goes as a suggestion, once', async () => {
        h.checks = true;
        h.answer = (path) => {
            if (path === '/api/knowledge/posts') throw Object.assign(new Error('Only this community’s owners and admins can do this to Local knowledge.'), { status: 403, code: 'admins_only' });
            return { draft: { id: 'd1' } };
        };
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-health-help'));
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/posts', '/api/knowledge/drafts']);
        expect(h.sent[1].body).toEqual(h.sent[0].body);
        expect(forgetLearnRole).toHaveBeenCalledTimes(1);
        expect(text()).toContain('Sent');
        expect(text()).toContain('An owner or admin will check it. You’ll hear back here.');
        expect(text()).not.toContain('Published');
    });

    it('…and when the suggestion is refused too, it says why, reads "Send to the admins", and asks nothing more', async () => {
        h.checks = true;
        h.answer = (path) => {
            if (path === '/api/knowledge/posts') throw Object.assign(new Error('Only this community’s owners and admins can do this to Local knowledge.'), { status: 403, code: 'admins_only' });
            throw Object.assign(new Error('You have 3 waiting already. Wait for an answer, or take one back.'), { status: 429, code: 'too_many_waiting' });
        };
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-health-help'));
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/posts', '/api/knowledge/drafts']);
        expect(q('learn-new-problem')?.textContent).toBe('You have 3 waiting already. Wait for an answer, or take one back.');
        expect(q('learn-new-send')?.textContent).toBe('Send to the admins');
        expect(text()).toContain('An owner or admin checks it before anyone sees it.');
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/posts', '/api/knowledge/drafts', '/api/knowledge/drafts']);
    });

    it('a member refused admins_only is not sent round again (only an owner’s or admin’s page falls back)', async () => {
        h.answer = () => { throw Object.assign(new Error('Only this community’s owners and admins can do this to Local knowledge.'), { status: 403, code: 'admins_only' }); };
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-health-help'));
        await click(q('learn-new-send'));
        expect(h.sent.map((s) => s.path)).toEqual(['/api/knowledge/drafts']);
        expect(q('learn-new-problem')?.textContent).toBe('Only this community’s owners and admins can do this to Local knowledge.');
    });

    it('opened from Learn, Open Learn goes back to it rather than opening a second', async () => {
        h.checks = true;
        h.params = { from: 'learn' };
        h.answer = () => ({ post: { id: 'p1' } });
        await show(createElement(NewKnowledgeScreen));
        fill();
        await click(q('learn-new-topic-health-help'));
        await click(q('learn-new-send'));
        await click(q('learn-new-open-learn'));
        expect(router.back).toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });
});

describe('My suggestions (§3.4)', () => {
    const at = '2026-11-03T09:00:00.000Z';
    const draft = (over: Record<string, unknown>) => ({
        id: 'd1', kind: 'new', title: 'Bins', topic: 'local-services', state: 'waiting', createdAt: at, answeredAt: null, postId: null, reason: null, reasonWords: null, ...over,
    });

    it('a waiting row: its title, New, since when, and Take it back, which asks first and then takes it off the list', async () => {
        h.mine = { waiting: [draft({ id: 'w1', title: 'Bin days' })], answered: [] };
        await show(createElement(MySuggestionsScreen));
        const row = q('learn-mine-row-w1')!;
        expect(row.textContent).toContain('Bin days');
        expect(row.textContent).toContain('New');
        expect(row.textContent).toContain('Waiting since 3 Nov');
        await click(q('learn-mine-take-back-w1'));
        expect(h.alerts[0].title).toBe('Take this back? The admins won’t see it.');
        expect(h.alerts[0].buttons?.map((b) => b.text)).toEqual(['Keep it', 'Take it back']);
        h.mine = { waiting: [], answered: [] };
        await act(async () => { h.alerts[0].buttons![1].onPress!(); });
        await settle();
        expect(h.sent).toEqual([{ method: 'POST', path: '/api/knowledge/drafts/w1/withdraw', body: {} }]);
        expect(q('learn-mine-row-w1')).toBeNull();
    });

    it('to a screen reader, only an "Added" row is one element; a waiting row’s "Take it back" is its own button', async () => {
        h.mine = {
            waiting: [draft({ id: 'w1', title: 'Bin days' })],
            answered: [
                draft({ id: 'a1', title: 'Tip hours', state: 'approved', answeredAt: at, postId: 'p9' }),
                draft({ id: 'a2', title: 'Ferry', state: 'declined', answeredAt: at, reason: 'elsewhere', reasonWords: 'That ferry is two towns over.' }),
            ],
        };
        await show(createElement(MySuggestionsScreen));
        expect(q('learn-mine-row-w1')?.getAttribute('data-accessible')).toBe('false');
        expect(q('learn-mine-row-a2')?.getAttribute('data-accessible')).toBe('false');
        expect(q('learn-mine-row-a1')?.getAttribute('data-accessible')).toBe('true');
        expect(q('learn-mine-row-a1')?.getAttribute('data-role')).toBe('button');
        const takeBack = q('learn-mine-take-back-w1')!;
        expect(takeBack.getAttribute('data-accessible')).toBe('true');
        expect(takeBack.getAttribute('data-role')).toBe('button');
        // The whole screen: no element a screen reader reaches sits inside another (iOS would fold it in, out of reach).
        const reached = Array.from(host.querySelectorAll('[data-accessible="true"]'));
        expect(reached.length).toBeGreaterThan(0);
        for (const el of reached) {
            expect(el.parentElement?.closest('[data-accessible="true"]'), el.getAttribute('data-testid') ?? el.textContent ?? '').toBeNull();
        }
    });

    it('a "Take it back" the node didn’t take says so under its row, which stays; a 404 reads the list again', async () => {
        const standby = 'This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.';
        const couldNot = 'Couldn’t send it. Check your connection and try again.';
        const refusals: Array<[string, unknown, string]> = [
            ['standby', Object.assign(new Error(standby), { status: 503, code: 'standby' }), standby],
            ['no signal', new TypeError('Network request failed'), couldNot],
            ['unsaid', Object.assign(new Error('Bad Gateway'), { status: 502, unsaid: true }), couldNot],
        ];
        for (const [name, thrown, words] of refusals) {
            h.mine = { waiting: [draft({ id: 'w1', title: 'Bin days' })], answered: [] };
            h.alerts = [];
            h.answer = () => { throw thrown; };
            act(() => root.unmount());
            root = createRoot(host);
            await show(createElement(MySuggestionsScreen, { key: name }));
            vi.mocked(readMyDrafts).mockClear();
            await click(q('learn-mine-take-back-w1'));
            await act(async () => { h.alerts[0].buttons![1].onPress!(); });
            await settle();
            expect(q('learn-mine-row-w1'), name).not.toBeNull();
            expect(q('learn-mine-problem-w1')?.textContent, name).toBe(words);
            expect(q('learn-mine-row-w1')?.textContent, name).toContain(words);
            expect(readMyDrafts, name).not.toHaveBeenCalled();
        }
        // Answered or taken back meanwhile: the node's 404 is no failure; the list is read again as the node has it.
        h.answer = () => { throw Object.assign(new Error('This suggestion isn’t waiting any more: it was answered or taken back.'), { status: 404, code: 'not_found' }); };
        h.alerts = [];
        h.mine = { waiting: [], answered: [draft({ id: 'w1', title: 'Bin days', state: 'approved', answeredAt: at, postId: 'p9' })] };
        await click(q('learn-mine-take-back-w1'));
        await act(async () => { h.alerts[0].buttons![1].onPress!(); });
        await settle();
        expect(readMyDrafts).toHaveBeenCalled();
        expect(q('learn-mine-problem-w1')).toBeNull();
        expect(q('learn-mine-take-back-w1')).toBeNull();
        expect(q('learn-mine-row-w1')?.textContent).toContain('Added');
    });

    it('answered rows stay: "Added" opens its page; "Not added: {reason}" shows the admin’s own words', async () => {
        h.mine = {
            waiting: [],
            answered: [
                draft({ id: 'a1', title: 'Tip hours', state: 'approved', answeredAt: at, postId: 'p9' }),
                draft({ id: 'a2', title: 'Ferry', state: 'declined', answeredAt: at, reason: 'elsewhere', reasonWords: 'That ferry is two towns over.' }),
            ],
        };
        await show(createElement(MySuggestionsScreen));
        expect(q('learn-mine-row-a1')?.textContent).toContain('Added');
        expect(q('learn-mine-row-a2')?.textContent).toContain("Not added: It isn't about this area");
        expect(q('learn-mine-row-a2')?.textContent).toContain('That ferry is two towns over.');
        expect(q('learn-mine-take-back-a1')).toBeNull();
        await click(q('learn-mine-row-a1'));
        expect(router.push).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'p9', kind: 'knowledge' } });
    });

    it('with nothing, the empty line and the button to suggest', async () => {
        h.mine = { waiting: [], answered: [] };
        await show(createElement(MySuggestionsScreen));
        expect(text()).toContain('Nothing here yet. Know something locals should know?');
        await click(q('learn-mine-suggest'));
        expect(router.push).toHaveBeenCalledWith('/learn/new');
    });

    it('when the community can’t be reached it says so, never an empty list', async () => {
        h.mine = null;
        await show(createElement(MySuggestionsScreen));
        expect(q('learn-mine-unreachable')).not.toBeNull();
        expect(text()).not.toContain('Nothing here yet');
    });
});
