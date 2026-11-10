// @vitest-environment jsdom
/**
 * "+ Make someone a voucher" on the phone (invites-vouching I5; DESIGN-invites-vouching-review-fable.md §3 ask 1; Marty,
 * 10 Nov: admins are vouchers only when an owner makes them one). The sheet draws the node's `candidates` in two sections,
 * Admins and Confirmed on the names list, and nobody else; the budget stepper starts at the community's default; an admin
 * is made with { memberPubkey } and a confirmed name with its entry id; the node's refusal is shown in its own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (disabled) attrs['data-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const calls = vi.hoisted(() => ({ made: [] as unknown[][], answer: { ok: true, value: {} } as unknown }));
vi.mock('../names-list', () => ({
    makeNamesVoucher: async (...a: unknown[]) => { calls.made.push(['entry', ...a.slice(2)]); return calls.answer; },
    makeAdminVoucher: async (...a: unknown[]) => { calls.made.push(['admin', ...a.slice(2)]); return calls.answer; },
}));

import { MakeVoucherSheet } from '../../components/MakeVoucherSheet';

const IKE = 'a'.repeat(64);
const LIZ = 'b'.repeat(64);
const LIZ_ENTRY = 'e'.repeat(32);
const identity = { publicKey: 'f'.repeat(64), privateKey: '0'.repeat(64), callsign: 'Owen', createdAt: '2026-11-01' };
const CANDIDATES = { admins: [{ memberPubkey: IKE, callsign: 'Ike' }], confirmed: [{ memberPubkey: LIZ, callsign: 'liz', entryId: LIZ_ENTRY }], adminsOffered: true };

let host: HTMLDivElement;
let root: Root;
let made = 0;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.made.length = 0;
    calls.answer = { ok: true, value: {} };
    made = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const draw = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
        root.render(createElement(MakeVoucherSheet, {
            anchorUrl: 'https://community.test', identity, candidates: CANDIDATES, defaultBudget: 1000,
            names: new Map([[LIZ_ENTRY, 'Liz Moreau']]), onClose: () => {}, onMade: () => { made++; }, ...props,
        } as any) as any);
    });
};
const all = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const one = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };

describe('+ Make someone a voucher (phone)', () => {
    it('two sections from the node, and nobody else: Admins, then Confirmed on the names list with the name this phone opened', async () => {
        await draw();
        expect(one('make-voucher-admins')?.textContent).toBe('Admins · no names-list entry needed');
        expect(one('make-voucher-confirmed')?.textContent).toBe('Confirmed on the names list');
        expect(all('make-voucher-admin-row').map((r) => r.textContent)).toEqual(['@Ike']);
        expect(all('make-voucher-confirmed-row').map((r) => r.textContent)).toEqual(['Liz Moreau · @liz']);
        expect(one('make-voucher-budget'), 'no stepper until someone is picked').toBeNull();
        expect(host.textContent).not.toMatch(/balance/i);
    });

    it('a committee admin is sent no admins: no Admins heading, the confirmed names still offered', async () => {
        await draw({ candidates: { admins: [], confirmed: CANDIDATES.confirmed, adminsOffered: false } });
        expect(one('make-voucher-admins')).toBeNull();
        expect(all('make-voucher-confirmed-row')).toHaveLength(1);
    });

    it('nobody to offer says so in one sentence', async () => {
        await draw({ candidates: { admins: [], confirmed: [], adminsOffered: true } });
        expect(one('make-voucher-nobody')?.textContent).toBe('Nobody to offer: every admin and everyone confirmed on the names list is a voucher already.');
        expect(one('make-voucher-admins')).toBeNull();
        expect(one('make-voucher-confirmed')).toBeNull();
    });

    it('a committee admin with nobody confirmed waiting is not told every admin is a voucher: only an owner makes an admin one (review, 10 Nov)', async () => {
        await draw({ candidates: { admins: [], confirmed: [], adminsOffered: false } });
        const line = one('make-voucher-nobody')?.textContent ?? '';
        expect(line).toBe('Nobody confirmed on the names list is waiting to be made a voucher. Only an owner makes an admin a voucher.');
        expect(line).not.toMatch(/every admin/i);
    });

    it('an admin picked: the stepper starts at the community default; Make sends { memberPubkey } with the level', async () => {
        await draw({ defaultBudget: 800 });
        await click(all('make-voucher-admin-row')[0]);
        expect(one('make-voucher-budget')?.textContent).toContain('Budget: 800 Beans');
        await click(host.querySelector('[aria-label="Increase budget"]'));
        expect(one('make-voucher-budget')?.textContent).toContain('Budget: 900 Beans');
        expect(one('make-voucher-go')?.textContent).toBe('Make @Ike a voucher');
        await click(one('make-voucher-go'));
        expect(calls.made).toEqual([['admin', IKE, 900]]);
        expect(made).toBe(1);
        expect(host.textContent).toContain('@Ike is a voucher now, with a budget of 900 Beans.');
    });

    it('a confirmed name picked: Make sends its entry id', async () => {
        await draw();
        await click(all('make-voucher-confirmed-row')[0]);
        await click(one('make-voucher-go'));
        expect(calls.made).toEqual([['entry', LIZ_ENTRY, 1000]]);
    });

    it('the node refuses: its words shown, nothing told as made', async () => {
        calls.answer = { ok: false, status: 403, code: 'owner_only', message: 'Only an owner makes an admin a voucher or stops an admin’s budget.' };
        await draw();
        await click(all('make-voucher-admin-row')[0]);
        await click(one('make-voucher-go'));
        expect(host.textContent).toContain('Only an owner makes an admin a voucher or stops an admin’s budget.');
        expect(made).toBe(0);
    });

    it('the stepper stays on the node’s levels: never below 100, never above 2,000', async () => {
        await draw({ defaultBudget: 100 });
        await click(all('make-voucher-admin-row')[0]);
        expect(host.querySelector('[aria-label="Decrease budget"]')?.getAttribute('data-disabled')).toBe('true');
        act(() => root.unmount());
        root = createRoot(host);
        await draw({ defaultBudget: 2000 });
        await click(all('make-voucher-admin-row')[0]);
        expect(host.querySelector('[aria-label="Increase budget"]')?.getAttribute('data-disabled')).toBe('true');
    });
});
