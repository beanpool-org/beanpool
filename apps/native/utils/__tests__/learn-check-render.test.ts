// @vitest-environment jsdom
/**
 * Render tests for the phone's To check screen (apps/native/app/learn/check/[id].tsx; #3381 review N2):
 *  - Approve sends only the kept photos (removing a photo drops it from the payload; removing all sends []).
 *  - A fix's 409 `page_changed` stays on screen with the node's own words, never emitting "Approved" or leaving.
 *  - An assistant draft's sources tick gates both Approve and Edit first until ticked.
 *  - "Not this one" waits for a reason before enabling Send, then posts the reason and optional words.
 * Tested in both light and dark themes at 320 dp × 1.3 font.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { KnowledgeDraftWhole } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
    theme: 'light' as 'light' | 'dark',
    draftId: 'draft-1',
    emitted: [] as Array<{ event: string; args: unknown[] }>,
    signedGet: vi.fn(),
    signedRequestWithMethod: vi.fn(),
    forgetHomeForHeader: vi.fn(),
    leaveScreen: vi.fn(),
}));

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn(), canGoBack: vi.fn(() => true) }));

vi.mock('expo-router', () => ({
    useRouter: () => router,
    router,
    useLocalSearchParams: () => ({ id: h.draftId }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: el } = await import('react');
    return {
        KeyboardAwareScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
    };
});
vi.mock('expo-image', async () => {
    const { createElement: el } = await import('react');
    return {
        Image: ({ source, accessibilityLabel }: any) => el('img', { 'data-src': source?.uri ?? '', 'aria-label': accessibilityLabel }),
    };
});
vi.mock('react-native', async () => {
    const { createElement: el } = await import('react');
    const flat = (s: unknown): Record<string, any> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const roles: Record<string, string> = { button: 'button', link: 'link', header: 'heading', checkbox: 'checkbox', radio: 'radio' };
    const host = (tag: string) => function Host(props: Record<string, any>) {
        const {
            children, onPress, accessibilityLabel, accessibilityRole, accessibilityState,
            accessibilityLiveRegion, testID, disabled,
        } = props;
        const attrs: Record<string, unknown> = {
            'data-style': JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style)),
        };
        if (onPress && !disabled) {
            attrs.onClick = () => { onPress(); };
        }
        if (tag === 'button') attrs.disabled = Boolean(disabled);
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState && typeof accessibilityState.checked === 'boolean') attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState && typeof accessibilityState.selected === 'boolean') attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
        if (testID) attrs['data-testid'] = testID;
        return el(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', Version: 26, select: (o: Record<string, unknown>) => o.android ?? o.default },
        useWindowDimensions: () => ({ width: 320, height: 569, fontScale: 1.3, scale: 2 }),
        View: host('div'),
        Text: host('span'),
        Pressable: host('button'),
        ScrollView: host('div'),
        ActivityIndicator: () => el('span', { 'data-testid': 'spinner' }, '…'),
        TextInput: ({ value, onChangeText, testID, placeholder }: any) => el('input', {
            value: value ?? '',
            placeholder,
            'data-testid': testID,
            onChange: (e: any) => onChangeText?.(e.target.value),
        }),
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1, absoluteFill: {} },
        DeviceEventEmitter: {
            addListener: () => ({ remove: () => {} }),
            emit: (event: string, ...args: unknown[]) => { h.emitted.push({ event, args }); },
        },
        Linking: { openURL: vi.fn(async () => {}) },
        Alert: { alert: vi.fn() },
        Keyboard: { dismiss: vi.fn() },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const look = () => ({ theme: h.theme, colors: h.theme === 'dark' ? darkColors : lightColors });
    return { useTheme: () => look(), useStyles: (make: any) => make(look()) };
});
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../leave-screen', () => ({ leaveScreen: (...args: unknown[]) => h.leaveScreen(...args) }));
vi.mock('../home-store', () => ({ forgetHomeForHeader: () => h.forgetHomeForHeader() }));
vi.mock('../post-photo', () => ({ askForPostPhoto: vi.fn() }));
vi.mock('../../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../../components/learn/KnowledgeDetail', () => ({
    hostOf: (url: string) => {
        try { return new URL(url).hostname; } catch { return url; }
    },
    openableSource: (url: string) => /^https?:\/\//i.test(url.trim()),
}));
vi.mock('../db', () => ({
    signedGet: (...args: unknown[]) => h.signedGet(...args),
    signedRequestWithMethod: (...args: unknown[]) => h.signedRequestWithMethod(...args),
}));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({})),
    NativeModulesProxy: {},
}));

import LearnCheckOneScreen from '../../app/learn/check/[id]';
import { LEARN_CHECK_ANSWERED } from '../../components/learn/learn-check';

const PHOTO_A = 'data:image/png;base64,AAAA';
const PHOTO_B = 'data:image/png;base64,BBBB';

function makeDraft(over: Partial<KnowledgeDraftWhole> = {}): KnowledgeDraftWhole {
    return {
        id: 'draft-1',
        kind: 'new',
        title: 'How recycling works at the tip',
        body: 'Bring glass, cans and paper sorted.',
        topic: 'local-services',
        place: 'Manse Road tip',
        sources: [{ url: 'https://council.example/waste', label: 'Council waste page' }],
        lang: 'en',
        about: null,
        note: null,
        from: { pubkey: 'a'.repeat(64), name: 'Mel' },
        assistant: null,
        createdAt: '2026-11-24T00:00:00.000Z',
        photos: [PHOTO_A, PHOTO_B],
        photoCredits: [null, null],
        needsSourcesTicked: false,
        freeTags: [],
        ...over,
    };
}

function okDraft(draft: KnowledgeDraftWhole) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ draft }),
    };
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
    h.theme = 'light';
    h.draftId = 'draft-1';
    h.emitted.length = 0;
    h.signedGet.mockReset();
    h.signedRequestWithMethod.mockReset();
    h.forgetHomeForHeader.mockReset();
    h.leaveScreen.mockReset();
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async () => {
    for (let i = 0; i < 6; i++) {
        await act(async () => { await new Promise((r) => setImmediate(r)); });
    }
};
const renderScreen = async (el: ReactNode = createElement(LearnCheckOneScreen)) => {
    act(() => root.render(el as any));
    await settle();
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: HTMLElement | null) => {
    expect(el).toBeTruthy();
    await act(async () => { el!.click(); });
    await settle();
};
const setInput = async (el: HTMLElement | null, value: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
};

describe.each(['light', 'dark'] as const)('LearnCheckOneScreen (%s, 320 dp × 1.3x)', (theme) => {
    beforeEach(() => { h.theme = theme; });

    it('Approve sends only the kept photos', async () => {
        h.signedGet.mockResolvedValueOnce(okDraft(makeDraft({ photos: [PHOTO_A, PHOTO_B] })));
        h.signedRequestWithMethod.mockResolvedValueOnce({ post: { id: 'p-1' } });

        await renderScreen();
        expect(q('learn-check-one')).toBeTruthy();
        expect(q('learn-check-photo-0')).toBeTruthy();
        expect(q('learn-check-photo-1')).toBeTruthy();

        // Remove the first photo; keep the second.
        await click(q('learn-check-photo-toggle-0'));
        expect(q('learn-check-photo-0')!.textContent).toContain('Left out: Approve won’t add it.');
        expect(q('learn-check-photo-toggle-0')!.textContent).toBe('Keep this photo');

        await click(q('learn-check-approve'));

        expect(h.signedRequestWithMethod).toHaveBeenCalledTimes(1);
        expect(h.signedRequestWithMethod).toHaveBeenCalledWith(
            'POST',
            '/api/knowledge/drafts/draft-1/approve',
            { photos: [PHOTO_B] },
            { withStatus: true },
        );
        expect(h.forgetHomeForHeader).toHaveBeenCalledTimes(1);
        expect(h.emitted).toEqual([{ event: LEARN_CHECK_ANSWERED, args: ['Approved. It is in Learn.'] }]);
        expect(h.leaveScreen).toHaveBeenCalledWith(router, 'learn/check/[id]');
    });

    it("a fix's 409 page_changed stays on screen with the node's own words and never leaves or shows Approved", async () => {
        const nodeWords = 'The page changed since this fix was sent. Edit first to check what it says now.';
        const fixDraft = makeDraft({
            id: 'fix-1',
            kind: 'fix',
            photos: [],
            photoCredits: [],
            note: 'Closed on Mondays now.',
            changed: ['body'],
            pageChanged: ['body'],
            post: {
                id: 'post-9',
                title: 'How recycling works at the tip',
                body: 'Open Tuesday to Sunday.',
                topic: 'local-services',
                place: 'Manse Road tip',
                sources: [],
                lang: 'en',
                freeTags: [],
            },
        });
        h.draftId = 'fix-1';
        h.signedGet.mockResolvedValueOnce(okDraft(fixDraft));
        const err = Object.assign(new Error(nodeWords), { status: 409, code: 'page_changed' });
        h.signedRequestWithMethod.mockRejectedValueOnce(err);

        await renderScreen();
        expect(q('learn-check-moved')).toBeTruthy();

        await click(q('learn-check-approve'));

        expect(h.signedRequestWithMethod).toHaveBeenCalledTimes(1);
        expect(h.signedRequestWithMethod).toHaveBeenCalledWith(
            'POST',
            '/api/knowledge/drafts/fix-1/approve',
            {},
            { withStatus: true },
        );
        // Stays on screen with the node's words; never emits Approved or navigates away.
        expect(q('learn-check-one')).toBeTruthy();
        expect(host.textContent).toContain(nodeWords);
        expect(host.textContent).not.toContain('Approved.');
        expect(h.emitted).toHaveLength(0);
        expect(h.forgetHomeForHeader).not.toHaveBeenCalled();
        expect(h.leaveScreen).not.toHaveBeenCalled();
    });

    it('the sources tick gates Approve and Edit first until ticked', async () => {
        const assistantDraft = makeDraft({
            id: 'asst-1',
            assistant: 'Claude',
            photos: [],
            photoCredits: [],
            needsSourcesTicked: true,
        });
        h.draftId = 'asst-1';
        h.signedGet.mockResolvedValueOnce(okDraft(assistantDraft));
        h.signedRequestWithMethod.mockResolvedValueOnce({ post: { id: 'p-2' } });

        await renderScreen();
        const approveBtn = q('learn-check-approve') as HTMLButtonElement;
        const editBtn = q('learn-check-edit') as HTMLButtonElement;
        const tick = q('learn-check-tick') as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(true);
        expect(editBtn.disabled).toBe(true);
        expect(tick.getAttribute('aria-checked')).toBe('false');

        // Tapping either while unticked does nothing.
        await click(approveBtn);
        await click(editBtn);
        expect(h.signedRequestWithMethod).not.toHaveBeenCalled();
        expect(q('learn-check-edit-form')).toBeNull();

        // Tick the sources checkbox: both Approve and Edit first unlock.
        await click(tick);
        expect(q('learn-check-tick')!.getAttribute('aria-checked')).toBe('true');
        expect((q('learn-check-approve') as HTMLButtonElement).disabled).toBe(false);
        expect((q('learn-check-edit') as HTMLButtonElement).disabled).toBe(false);

        // Edit first now opens the edit form, and Back returns to read mode.
        await click(q('learn-check-edit'));
        expect(q('learn-check-edit-form')).toBeTruthy();
        await click(q('learn-check-one-back'));
        expect(q('learn-check-one')).toBeTruthy();

        // Approving sends checkedSources: true.
        await click(q('learn-check-approve'));
        expect(h.signedRequestWithMethod).toHaveBeenCalledWith(
            'POST',
            '/api/knowledge/drafts/asst-1/approve',
            { checkedSources: true },
            { withStatus: true },
        );
        expect(h.emitted).toEqual([{ event: LEARN_CHECK_ANSWERED, args: ['Approved. It is in Learn.'] }]);
        expect(h.leaveScreen).toHaveBeenCalledWith(router, 'learn/check/[id]');
    });

    it('"Not this one" waits for a reason before sending, then posts reason and words', async () => {
        h.signedGet.mockResolvedValueOnce(okDraft(makeDraft({ photos: [], photoCredits: [] })));
        h.signedRequestWithMethod.mockResolvedValueOnce({ ok: true });

        await renderScreen();
        await click(q('learn-check-not'));
        expect(q('learn-check-no')).toBeTruthy();

        const sendBtn = q('learn-check-no-send') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);

        // Clicking Send before choosing a reason sends nothing.
        await click(sendBtn);
        expect(h.signedRequestWithMethod).not.toHaveBeenCalled();

        // Choosing a reason enables Send; optional words travel with it.
        await click(q('learn-check-reason-person'));
        expect((q('learn-check-no-send') as HTMLButtonElement).disabled).toBe(false);
        await setInput(q('learn-check-no-words'), 'Knowledge is about places, not people.');
        await click(q('learn-check-no-send'));

        expect(h.signedRequestWithMethod).toHaveBeenCalledTimes(1);
        expect(h.signedRequestWithMethod).toHaveBeenCalledWith(
            'POST',
            '/api/knowledge/drafts/draft-1/no',
            { reason: 'person', words: 'Knowledge is about places, not people.' },
            { withStatus: true },
        );
        expect(h.forgetHomeForHeader).toHaveBeenCalledTimes(1);
        expect(h.emitted).toEqual([{ event: LEARN_CHECK_ANSWERED, args: ['Answered. The writer is told.'] }]);
        expect(h.leaveScreen).toHaveBeenCalledWith(router, 'learn/check/[id]');
    });
});
