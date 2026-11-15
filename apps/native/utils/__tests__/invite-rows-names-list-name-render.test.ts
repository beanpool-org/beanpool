// @vitest-environment jsdom
/**
 * The names-list name beside an invite on the phone (Marty's 12 Nov idea, yes 15 Nov: "Show the names-list name beside an
 * invite, so you can see who an invite is for"). People → Invites draws what it is handed: the names this phone opened from
 * the names list, by entry id (only an owner's or admin's phone opens it, and only one holding the list's key). Given a name,
 * an invite bound to that entry says it in its Pending row, in the opened invite, and beside the joiner in Joined; never in
 * the link its QR holds. Not given one (the list not open yet, or no key for that entry), the row reads as before. An invite
 * the node sent without its entry (its maker no longer reads the names list: server test-invite-names-entry-readers) never
 * shows a name, and Pending then asks for no open of the list (a logged read) on its account. Drawn at 320 dp with 1.3x text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityRole, testID, disabled, maxFontSizeMultiplier } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (maxFontSizeMultiplier) attrs['data-max-font'] = String(maxFontSizeMultiplier);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: () => {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: ({ value }: { value: string }) => createElement('i', { 'data-testid': 'qr', 'data-value': value }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

import { PendingInvites } from '../../components/InviteRows';
import { inviteFolds, type InviteRowSource } from '@beanpool/core';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const made = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const E_DEE = 'a'.repeat(32);
const E_ROB = 'b'.repeat(32);

// Two open invites bound to entries, one plain with a note, one the node sent without its entry, and one used.
const forDee: InviteRowSource = { code: 'INV-DEED-0001', createdAt: made(3), namesEntryId: E_DEE, vouchAmount: 20000 };
const forRob: InviteRowSource = { code: 'INV-ROBB-0002', createdAt: made(5), namesEntryId: E_ROB };
const forKim: InviteRowSource = { code: 'INV-KIMM-0003', createdAt: made(1), intendedFor: 'Kim', namesEntryId: null };
const withheld: InviteRowSource = { code: 'INV-WTHH-0004', createdAt: made(2), namesEntryId: null, voucherLevel: 100000 };
const joinedDee: InviteRowSource = { code: 'INV-JOIN-0005', createdAt: made(9), usedBy: 'c'.repeat(64), usedAt: made(8), usedByCallsign: 'Denden', namesEntryId: E_DEE };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    inviteFolds.clear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const click = async (elm: Element | null) => { await act(async () => { (elm as HTMLElement).click(); }); };
const whoOf = (row: HTMLElement) => row.querySelector('[data-testid="invite-who"]')?.textContent ?? '';

function render(invites: InviteRowSource[], names: ReadonlyMap<string, string>, onNeedNames?: (need: boolean) => void) {
    act(() => root.render(createElement(PendingInvites, {
        invites, now: NOW, names, onNeedNames,
        qrValue: (c: string) => `https://riverside.example/?invite=${c}`, shareSlot: () => createElement('span', null, 'share'),
    }) as any));
}

const NAMES = new Map([[E_DEE, 'Dee Dee'], [E_ROB, 'Robin Ash']]);

describe('the names-list name beside an invite, on the phone', () => {
    it('Pending: each bound invite says the name it was made for, so two open invites are told apart', async () => {
        render([forDee, forRob, forKim, withheld], NAMES);
        await click(q('invites-pending-fold'));
        const who = all('invite-pending-row').map(whoOf);
        expect(who).toContain('Dee Dee');
        expect(who).toContain('Robin Ash');
        // An invite with no entry reads as before: its note.
        expect(who).toContain('For: Kim');
        // Neither bound row falls back to its code.
        expect(who).not.toContain(forDee.code);
        expect(who).not.toContain(forRob.code);
        // Holds 1.3x text, at 320 dp.
        for (const row of all('invite-pending-row')) expect(row.querySelector('[data-testid="invite-who"]')?.getAttribute('data-max-font')).toBe('1.3');
    });

    it('the opened invite says the name; its QR holds the link with the code, never the name', async () => {
        render([forDee], NAMES);
        await click(q('invites-pending-fold'));
        await click(all('invite-pending-row')[0]);
        const sheet = q('invite-sheet')!;
        expect(sheet.querySelector('[data-testid="invite-who"]')?.textContent).toBe('Dee Dee');
        const qr = sheet.querySelector('[data-testid="qr"]')!.getAttribute('data-value')!;
        expect(qr).toBe(`https://riverside.example/?invite=${forDee.code}`);
        expect(qr).not.toMatch(/Dee/);
    });

    it('Joined: the name beside the member who joined with it', async () => {
        render([joinedDee], NAMES);
        await click(q('invites-joined-fold'));
        const rows = all('invite-joined-row');
        expect(rows).toHaveLength(1);
        expect(rows[0].querySelector('span')?.textContent).toBe('Dee Dee · @Denden');
    });

    it('not given a name (the list not open yet, or no key for that entry): the row reads as before', async () => {
        render([forDee, forKim], new Map());
        await click(q('invites-pending-fold'));
        const rows = all('invite-pending-row');
        expect(rows.map(whoOf)).toEqual(expect.arrayContaining([forDee.code, 'For: Kim']));
        expect(rows.find((r) => whoOf(r) === forDee.code)?.querySelector('[data-testid="invite-carries"]')?.textContent).toContain('confirms them as known');
    });

    it('Pending open with a bound invite asks the caller to open the list; with only an entry the node withheld, it never does', async () => {
        const asked: boolean[] = [];
        render([forDee, withheld], NAMES, (need) => asked.push(need));
        await click(q('invites-pending-fold'));
        expect(asked.at(-1)).toBe(true);

        act(() => root.unmount());
        root = createRoot(host);
        inviteFolds.clear();
        const askedWithheld: boolean[] = [];
        render([withheld, forKim], NAMES, (need) => askedWithheld.push(need));
        await click(q('invites-pending-fold'));
        expect(askedWithheld.every((n) => n === false)).toBe(true);
    });

    it('an invite the node sent without its entry shows no name, and no longer says it confirms them as known', async () => {
        render([withheld], NAMES);
        await click(q('invites-pending-fold'));
        const row = all('invite-pending-row')[0];
        expect(whoOf(row)).toBe(withheld.code);
        expect(row.textContent).not.toMatch(/Dee Dee|Robin Ash/);
        expect(row.querySelector('[data-testid="invite-carries"]')?.textContent).toBe('voucher budget 1,000');
    });
});
