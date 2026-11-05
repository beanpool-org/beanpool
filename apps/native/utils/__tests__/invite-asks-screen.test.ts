// @vitest-environment jsdom
/**
 * A member asks an admin to invite someone, on the phone: components/InviteAsks.tsx rendered for real over a fake node, the
 * real utils/invite-asks.ts and core's rules between them. Its rules are apps/server test-invite-asks.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, onChangeText, value, maxLength, accessibilityRole, accessibilityLabel, accessibilityState, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value; attrs.maxLength = maxLength; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio') attrs.role = 'radio';
        if (accessibilityState?.disabled) attrs.disabled = true;
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: any }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return { useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]) };
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: () => 0 }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const node = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body?: unknown }>, get: {} as Record<string, unknown>, post: { ok: true, json: async () => ({}) } as any }));
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_url: string, path: string) => {
        node.calls.push({ path });
        const answer = node.get[path];
        return answer === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => answer };
    }),
    signedPost: vi.fn(async (_url: string, path: string, body: unknown) => { node.calls.push({ path, body }); return node.post; }),
}));

import { AskAnAdmin, InviteAsksToAnswer } from '../../components/InviteAsks';

const IDENTITY = { publicKey: 'k'.repeat(64), privateKey: 'aa', callsign: 'Mel' } as any;
const SAM = { id: 'a1', firstName: 'Sam', howKnown: 'the <b>bakery</b>', askedAt: '2026-11-03T00:00:00.000Z' };
let host: HTMLDivElement;
let root: Root;
const by = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const type = async (el: HTMLElement | null, text: string) => {
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(el, text);
        el!.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const mount = async (el: unknown) => { await act(async () => { root.render(el as any); }); await flush(); };
const member = (onShare = vi.fn()) => mount(createElement(AskAnAdmin, { anchorUrl: 'https://node.example', identity: IDENTITY, onShare }));
const admin = () => mount(createElement(InviteAsksToAnswer, { anchorUrl: 'https://node.example', identity: IDENTITY }));
const posted = () => node.calls.filter((c) => c.body !== undefined);

beforeEach(() => {
    node.calls.length = 0;
    node.get = { '/api/invite/asks/mine': { waiting: [], answers: [] }, '/api/invite/asks': { asks: [], total: 0 } };
    node.post = { ok: true, json: async () => ({}) };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('asking on the phone', () => {
    it('a small button opens a short sheet of two lines, and Send waits for both', async () => {
        await member();
        expect(host.textContent).toContain('Ask an admin to invite someone');
        expect(host.textContent).not.toContain('What you’ve asked');
        await click(by('invite-ask-open'));
        expect(host.querySelectorAll('input').length).toBe(2);
        expect((by('invite-ask-first-name') as HTMLInputElement).maxLength).toBe(30);
        expect((by('invite-ask-how-known') as HTMLInputElement).maxLength).toBe(140);
        expect((by('invite-ask-send') as HTMLButtonElement).disabled).toBe(true);
        await type(by('invite-ask-first-name'), ' Sam ');
        expect((by('invite-ask-send') as HTMLButtonElement).disabled).toBe(true);
        await type(by('invite-ask-how-known'), ' the bakery ');
        await click(by('invite-ask-send'));
        expect(posted()).toEqual([{ path: '/api/invite/asks', body: { firstName: 'Sam', howKnown: 'the bakery' } }]);
        expect(by('invite-ask-sheet')).toBeNull();
    });

    it('a refusal stays in the sheet, in the node\'s words', async () => {
        node.post = { ok: false, json: async () => ({ error: 'You have 3 asks waiting. Take one back, or wait for an answer.' }) };
        await member();
        await click(by('invite-ask-open'));
        await type(by('invite-ask-first-name'), 'Sam');
        await type(by('invite-ask-how-known'), 'bakery');
        await click(by('invite-ask-send'));
        expect(by('invite-ask-sheet')?.textContent).toContain('You have 3 asks waiting.');
    });

    it('shows what waits and takes it back; what was typed is in its fence, whole', async () => {
        node.get['/api/invite/asks/mine'] = { waiting: [SAM], answers: [] };
        await member();
        expect(host.textContent).toContain('What you’ve asked');
        expect(by('invite-ask-fence')?.textContent).toBe('Samthe <b>bakery</b>');
        expect(by('invite-ask-fence')?.querySelector('b')).toBeNull();
        await click(by('invite-ask-take-back-a1'));
        expect(posted()[0].path).toBe('/api/invite/asks/a1/withdraw');
    });

    it('shows the code to pass on, and shares it', async () => {
        node.get['/api/invite/asks/mine'] = { waiting: [], answers: [{ id: 'n1', outcome: 'invited', state: 'ready', code: 'INV-ABCD-EFGH', askedAt: SAM.askedAt, answeredAt: SAM.askedAt }] };
        const onShare = vi.fn();
        await member(onShare);
        const row = by('invite-ask-answer-n1')!;
        expect(row.textContent).toContain('It works once, for 30 days.');
        expect(row.textContent).toContain('INV-ABCD-EFGH');
        const share = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.includes("Share"))!;
        await click(share);
        expect(onShare).toHaveBeenCalledWith('INV-ABCD-EFGH');
    });

    it('shows a No, and its reason in a fence', async () => {
        node.get['/api/invite/asks/mine'] = { waiting: [], answers: [{ id: 'n2', outcome: 'no', reason: 'Not this year', askedAt: SAM.askedAt, answeredAt: SAM.askedAt }] };
        await member();
        expect(by('invite-ask-answer-n2')?.textContent).toContain('An admin said no.');
        expect(by('invite-ask-fence')?.textContent).toBe('Not this year');
    });
});

describe('answering on the phone', () => {
    const ASK = { ...SAM, askerPubkey: 'm'.repeat(64), askerCallsign: 'Mel' };
    it('shows no section to someone the node refuses, or with nothing waiting', async () => {
        delete node.get['/api/invite/asks'];
        await admin();
        expect(host.textContent).toBe('');
        node.get['/api/invite/asks'] = { asks: [], total: 0 };
        await admin();
        expect(host.textContent).toBe('');
    });

    // The vouching reset (R0): an invite sent for an ask carries no vouch, and the card says no vouch word.
    it('names who asked, and sends an invite that carries nothing but itself', async () => {
        node.get['/api/invite/asks'] = { asks: [ASK], total: 1 };
        await admin();
        expect(by('invite-ask-a1')?.textContent).toContain('Asked by Mel');
        expect(host.textContent).not.toMatch(/vouch/i);
        node.get['/api/invite/asks'] = { asks: [], total: 0 };
        await click(by('invite-ask-invite-a1'));
        expect(posted()).toEqual([{ path: '/api/invite/asks/a1/send', body: {} }]);
        expect(host.textContent).toContain('Sent. The code is with the member now.');
    });

    it('No opens a short reason, and sends it', async () => {
        node.get['/api/invite/asks'] = { asks: [ASK], total: 1 };
        await admin();
        await click(by('invite-ask-no-a1'));
        expect((by('invite-ask-reason-a1') as HTMLInputElement).maxLength).toBe(100);
        await type(by('invite-ask-reason-a1'), ' Not this year ');
        await click(by('invite-ask-send-no-a1'));
        expect(posted()).toEqual([{ path: '/api/invite/asks/a1/no', body: { reason: 'Not this year' } }]);
    });
});
