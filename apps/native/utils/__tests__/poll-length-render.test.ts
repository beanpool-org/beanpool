// @vitest-environment jsdom
/**
 * How long a poll may run (Damo's ask, Marty's yes, 12 Nov 2026; @beanpool/core poll-length, the node's half is apps/server
 * engine/posts.ts). The phone's poll form, drawn for real (NewPollModal, as poll-week-render.test.ts draws it), in the light and the
 * dark theme:
 *   - a member (no role, a moderator, a role the node could not say) is offered 3, 7 and 14 days; an owner or an admin 30 and 90 too;
 *   - the role is asked when the form opens, not while it is shut, and not for a phone with no account;
 *   - the form starts on 7 days, and Create sends the length that is pressed (90 for an admin who pressed it, 7 when nothing was);
 *   - the buttons wrap, so five hold at 320 dp and 130% text, and a member's three keep one row as before;
 *   - the node's refusal of a long poll (a stale picker) is shown in the node's own words.
 * Nothing here contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setLanguage } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, value, onChangeText, testID, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (testID) attrs['data-testid'] = testID;
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (flat.color) attrs['data-color'] = String(flat.color);
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        if (flat.flexWrap) attrs['data-wrap'] = String(flat.flexWrap);
        if (flat.flexBasis !== undefined) attrs['data-basis'] = String(flat.flexBasis);
        if (flat.flexGrow !== undefined) attrs['data-grow'] = String(flat.flexGrow);
        if (flat.flex !== undefined) attrs['data-flex'] = String(flat.flex);
        if (props.placeholder) attrs.placeholder = props.placeholder;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'poll-1' }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => (theme.dark ? m.darkColors ?? m.default?.darkColors : m.lightColors ?? m.default?.lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
        useStyles: (f: any) => f({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
    };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'me'.repeat(32) } as { publicKey: string } | null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
const node = vi.hoisted(() => ({
    ownerOrAdmin: false as boolean | 'fails', asked: 0, created: [] as Array<Record<string, any>>, refuse: null as string | null,
}));
const alerts = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../db', () => ({
    createPost: async (post: Record<string, any>) => {
        if (node.refuse) throw new Error(node.refuse);
        node.created.push(post);
        return {};
    },
    getPollNextStart: async () => null,
    isOwnerOrAdminHere: async () => {
        node.asked++;
        if (node.ownerOrAdmin === 'fails') throw new Error('offline');
        return node.ownerOrAdmin;
    },
}));
vi.mock('../../utils/keyboard-alert', () => ({ Alert: { alert: (...a: unknown[]) => { alerts.calls.push(a); } } }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: (...a: unknown[]) => { alerts.calls.push(a); } } }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => undefined }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));

import { NewPollModal } from '../../components/NewPollModal';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    node.ownerOrAdmin = false; node.asked = 0; node.created = []; node.refuse = null; alerts.calls = [];
    who.identity = { publicKey: 'me'.repeat(32) }; setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const draw = async (visible = true) => {
    await act(async () => { root.render(createElement(NewPollModal, { visible, onClose: () => {} }) as unknown as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
};
/** The length buttons, in the order they are drawn: their labels read "{n} Days duration" (", selected" on the pressed one). */
const lengthButtons = () => Array.from(host.querySelectorAll('[role=button]')).filter((b) => /^\d+ Days duration/.test(b.getAttribute('aria-label') ?? '')) as HTMLElement[];
const lengths = () => lengthButtons().map((b) => Number((b.getAttribute('aria-label') ?? '').match(/^(\d+)/)![1]));
const pressedLength = () => lengthButtons().filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => Number(b.getAttribute('aria-label')!.match(/^(\d+)/)![1]));
const press = async (days: number) => { await act(async () => { lengthButtons().find((b) => b.getAttribute('aria-label')!.startsWith(`${days} Days`))!.click(); }); };
const type = async (placeholder: string, text: string) => {
    const box = Array.from(host.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === placeholder) as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
    });
};
const fillAndCreate = async () => {
    await type('e.g. Should the market move to Sunday?', 'Which month?');
    await type('Option 1', 'March');
    await type('Option 2', 'June');
    await act(async () => { (host.querySelector('[aria-label="Create poll"]') as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); });
};

for (const dark of [false, true]) {
    describe(`the poll form's lengths (drawn, ${dark ? 'dark' : 'light'})`, () => {
        beforeEach(() => { theme.dark = dark; });

        it('a member is offered 3, 7 and 14 days, starting on 7', async () => {
            node.ownerOrAdmin = false;
            await draw();
            expect(lengths()).toEqual([3, 7, 14]);
            expect(pressedLength()).toEqual([7]);
            expect(host.textContent).not.toContain('30 Days');
            expect(host.textContent).not.toContain('90 Days');
        });

        it('an owner or an admin is offered 30 and 90 days after the short ones', async () => {
            node.ownerOrAdmin = true;
            await draw();
            expect(lengths()).toEqual([3, 7, 14, 30, 90]);
            expect(pressedLength()).toEqual([7]);
        });

        it('a role the node could not say offers the short lengths: the form is never held back', async () => {
            node.ownerOrAdmin = 'fails';
            await draw();
            expect(lengths()).toEqual([3, 7, 14]);
            expect(host.querySelector('input')).toBeTruthy();
        });

        it('pressing 90 presses it alone, and Create sends 90', async () => {
            node.ownerOrAdmin = true;
            await draw();
            await press(90);
            expect(pressedLength()).toEqual([90]);
            await fillAndCreate();
            expect(node.created).toHaveLength(1);
            expect(node.created[0]).toMatchObject({ type: 'poll', durationDays: 90 });
        });

        it('pressing 30 and then 14 sends 14', async () => {
            node.ownerOrAdmin = true;
            await draw();
            await press(30);
            await press(14);
            await fillAndCreate();
            expect(node.created[0]).toMatchObject({ durationDays: 14 });
        });

        it('a member who changes nothing sends 7 days', async () => {
            await draw();
            await fillAndCreate();
            expect(node.created[0]).toMatchObject({ type: 'poll', durationDays: 7 });
        });

        it('shows the node\'s own words when it refuses a long poll (a role lost since the form opened)', async () => {
            const said = 'Polls that run 30 or 90 days are for owners and admins. Choose 3, 7, or 14 days';
            node.ownerOrAdmin = true;
            await draw();
            await press(30);
            node.refuse = said;
            await fillAndCreate();
            expect(node.created).toHaveLength(0);
            expect(alerts.calls.some((c) => c.includes(said))).toBe(true);
        });

        it('wraps, so five lengths hold at 320 dp and 130% text; each keeps room to grow and to shrink to its words', async () => {
            node.ownerOrAdmin = true;
            await draw();
            const row = lengthButtons()[0]!.parentElement!;
            expect(row.getAttribute('data-wrap')).toBe('wrap');
            for (const b of lengthButtons()) {
                expect(b.getAttribute('data-basis')).toBe('28%');
                expect(b.getAttribute('data-grow')).toBe('1');
                // Not `flex: 1`, whose zero basis would crush five buttons into one row at 320 dp.
                expect(b.getAttribute('data-flex')).toBeNull();
            }
            // Three fit a row at 28% (3 x 28% + two gaps), so the fourth and fifth are a second row.
            expect(3 * 28).toBeLessThan(100);
            expect(4 * 28).toBeGreaterThan(100);
        });

        it('is asked each time the form opens, and not while it is shut or for a phone with no account', async () => {
            node.ownerOrAdmin = true;
            await draw(false);
            expect(node.asked).toBe(0);
            await draw(true);
            expect(node.asked).toBe(1);
            expect(lengths()).toEqual([3, 7, 14, 30, 90]);
            await draw(false);
            node.ownerOrAdmin = false;
            await draw(true);
            expect(node.asked).toBe(2);
            expect(lengths()).toEqual([3, 7, 14]);
            who.identity = null;
            await draw(false);
            await draw(true);
            expect(node.asked).toBe(2);
        });

        it('a length the form no longer offers is not sent: an admin who pressed 90, then lost the role, sends 7', async () => {
            node.ownerOrAdmin = true;
            await draw();
            await press(90);
            node.ownerOrAdmin = false;
            await draw(false);
            await draw(true);
            expect(lengths()).toEqual([3, 7, 14]);
            expect(pressedLength()).toEqual([7]);
            await fillAndCreate();
            expect(node.created[0]).toMatchObject({ durationDays: 7 });
        });
    });
}
