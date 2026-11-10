// @vitest-environment jsdom
/**
 * The profile's one button for an owner or admin (invites-vouching I4; DESIGN-invites-vouching-review-fable.md §3 ask 2): it
 * follows the person's state, as the node says it in the trust profile's `voucherButton` - Add to the names list, Make a
 * voucher, Voucher · 400 left › - and shows nothing for a state it does not know. The node decides who gets a button at all
 * (an owner or admin, never a plain member, never on your own profile); this proves the phone draws exactly what it is told.
 *
 * The add and make buttons open the names list at the right form (names-list.tsx reads `act`, `forMember`, `forCallsign`);
 * the voucher button opens the voucher's card in a modal inside the safe area.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s },
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { nav.pushed.push(to); } } }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children, testID }: { children?: unknown; testID?: string }) => createElement('div', { 'data-testid': testID }, children as any),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../components/VoucherCard', () => ({
    VoucherCard: ({ memberPubkey }: { memberPubkey: string }) => createElement('div', { 'data-testid': 'stub-voucher-card' }, memberPubkey),
}));

import { ProfileVoucherButton } from '../../components/ProfileVoucherButton';

const PAM = 'c'.repeat(64);
const identity = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Owen', createdAt: '2026-11-01' };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.pushed.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const draw = async (button: unknown) => {
    await act(async () => { root.render(createElement(ProfileVoucherButton, { button, memberPubkey: PAM, callsign: 'Pam', anchorUrl: 'https://community.test', identity } as any) as any); });
};
const btn = () => host.querySelector('[data-testid="profile-voucher-button"]') as HTMLElement | null;

describe('the profile’s button follows the person’s state', () => {
    it('not on the list: "Add to the names list" opens the names list at the one-step add-and-confirm form for this member', async () => {
        await draw({ state: 'add' });
        expect(btn()?.textContent).toBe('Add to the names list');
        await act(async () => { btn()!.click(); });
        expect(nav.pushed).toEqual([{ pathname: '/names-list', params: { act: 'add', forMember: PAM, forCallsign: 'Pam' } }]);
    });

    it('confirmed, and the viewer is on the committee: "Make a voucher" opens the names list at Make a voucher', async () => {
        await draw({ state: 'make' });
        expect(btn()?.textContent).toBe('Make a voucher');
        await act(async () => { btn()!.click(); });
        expect(nav.pushed).toEqual([{ pathname: '/names-list', params: { act: 'make', forMember: PAM, forCallsign: 'Pam' } }]);
    });

    it('a voucher: "Voucher · 400 left ›" opens their card here, in a modal inside the safe area', async () => {
        await draw({ state: 'voucher', left: 400, noLimit: false });
        expect(btn()?.textContent).toBe('Voucher · 400 left ›');
        expect(host.querySelector('[data-modal]')).toBeNull();
        await act(async () => { btn()!.click(); });
        const card = host.querySelector('[data-modal] [data-testid="profile-voucher-card-modal"] [data-testid="stub-voucher-card"]');
        expect(card?.textContent, 'the card for this member').toBe(PAM);
        expect(nav.pushed, 'it does not leave the profile').toEqual([]);
    });

    it('an owner is "Voucher · No limit ›", with no figure', async () => {
        await draw({ state: 'voucher', left: 1000, noLimit: true });
        expect(btn()?.textContent).toBe('Voucher · No limit ›');
        expect(btn()?.textContent).not.toMatch(/\d/);
    });

    it('nothing from the node, or a state this version does not know: no button', async () => {
        for (const unknown of [undefined, null, {}, { state: 'confirm' }, { state: 'voucher' }, 'add']) {
            await draw(unknown);
            expect(btn(), JSON.stringify(unknown)).toBeNull();
        }
    });

    it('no balance anywhere', async () => {
        for (const state of [{ state: 'add' }, { state: 'make' }, { state: 'voucher', left: 400, noLimit: false }]) {
            await draw(state);
            expect(host.textContent).not.toMatch(/balance/i);
        }
    });
});
