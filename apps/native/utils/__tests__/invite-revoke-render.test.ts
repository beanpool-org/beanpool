// @vitest-environment jsdom
/**
 * Revoke on the phone (invites-vouching slice I2; DESIGN-invites-vouching-review-fable.md §3 ask 3, §5 I2): an open Pending
 * invite and the made card each offer Revoke, asked first with the design's words (the name stays on the names list for a bound
 * invite); confirmed, the caller's revoke runs and, once it says gone, the sheet closes. No Revoke on an offline ticket, nor
 * where the caller gives none (a preview). Drawn at 320 dp with 1.3x text, light and dark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Button = { text: string; style?: string; onPress?: () => unknown };
const alerts = vi.hoisted(() => ({ said: [] as Array<{ title: string; text?: string; buttons: Button[] }> }));
const theme = vi.hoisted(() => ({ name: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityRole, testID, disabled, maxFontSizeMultiplier, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (maxFontSizeMultiplier) attrs['data-max-font'] = String(maxFontSizeMultiplier);
        if (disabled) attrs.disabled = true;
        const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
        if (flat?.minHeight) attrs['data-min-height'] = String(flat.minHeight);
        if (flat?.color) attrs['data-color'] = String(flat.color);
        if (flat?.borderColor) attrs['data-border'] = String(flat.borderColor);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, text?: string, buttons?: Button[]) => { alerts.said.push({ title, text, buttons: buttons ?? [] }); } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.name === 'dark' ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.name, colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.name, colors: colors() }),
    };
});

import { InviteMadeCard, PendingInvites } from '../../components/InviteRows';
import { inviteFolds, type InviteRowSource } from '@beanpool/core';
import { lightColors, darkColors } from '../../constants/colors';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const made = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
// The node kept the names `vouchAmount` and `voucherLevel` and sends them in whole hundredths of a Bean (10000 is a vouch of 100).
const plain: InviteRowSource = { code: 'INV-AAAA-1111', createdAt: made(2), vouchAmount: 10000, expiresAt: new Date(NOW + 28 * DAY).toISOString() };
const bound: InviteRowSource = { code: 'INV-BBBB-2222', createdAt: made(7), namesEntryId: 'e1', vouchAmount: 20000, voucherLevel: 100000 };
const ticket: InviteRowSource = { code: 'BP-eyJ0aWNrZXQiOiJ0aGlzIn0', createdAt: made(1) };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    inviteFolds.clear();
    theme.name = 'light';
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (elm: Element | null) => { await act(async () => { (elm as HTMLElement).click(); }); };
const pressAlert = async (text: string) => {
    const b = alerts.said[alerts.said.length - 1].buttons.find((x) => x.text === text);
    await act(async () => { await b?.onPress?.(); });
};

function renderPending(onRevoke?: (inv: InviteRowSource) => Promise<boolean>) {
    act(() => root.render(createElement(PendingInvites, {
        invites: [plain, bound, ticket], now: NOW, names: new Map([['e1', 'Dee Dee']]),
        qrValue: (c: string) => `https://x/?invite=${c}`, shareSlot: () => createElement('span', null, 'share'), onRevoke,
    }) as any));
}
const openRow = async (n: number) => {
    await click(q('invites-pending-fold'));
    await click(host.querySelectorAll('[data-testid="invite-pending-row"]')[n]);
};

describe('Revoke on an open Pending invite', () => {
    it('asks with the design’s words for a bound invite, naming the person, and revokes on yes', async () => {
        const revoked: string[] = [];
        renderPending(async (inv) => { revoked.push(inv.code); return true; });
        // Pending lists newest first by the node's order: find the bound row by its words.
        await click(q('invites-pending-fold'));
        const rows = Array.from(host.querySelectorAll('[data-testid="invite-pending-row"]'));
        await click(rows.find((r) => r.textContent?.includes('Dee Dee')) ?? null);
        expect(q('invite-sheet')).not.toBeNull();
        await click(q('invite-revoke'));
        const asked = alerts.said[0];
        expect(asked.title).toBe('Revoke this invite?');
        expect(asked.text).toBe('Whoever has the link can’t use it. Dee Dee’s name stays on the names list, not confirmed.');
        expect(asked.buttons.map((b) => b.text)).toEqual(['Cancel', 'Revoke']);
        expect(asked.buttons[1].style).toBe('destructive');
        await pressAlert('Revoke');
        expect(revoked).toEqual([bound.code]);
        expect(q('invite-sheet')).toBeNull();
    });

    it('a plain invite’s words say nothing of the names list; Cancel revokes nothing', async () => {
        const revoked: string[] = [];
        renderPending(async (inv) => { revoked.push(inv.code); return true; });
        await click(q('invites-pending-fold'));
        const rows = Array.from(host.querySelectorAll('[data-testid="invite-pending-row"]'));
        await click(rows.find((r) => r.textContent?.includes('100 vouch')) ?? null);
        await click(q('invite-revoke'));
        expect(alerts.said[0].text).toBe('Whoever has the link can’t use it.');
        await pressAlert('Cancel');
        expect(revoked).toEqual([]);
        expect(q('invite-sheet')).not.toBeNull();
    });

    it('a revoke the community refused keeps the sheet open', async () => {
        renderPending(async () => false);
        await click(q('invites-pending-fold'));
        const rows = Array.from(host.querySelectorAll('[data-testid="invite-pending-row"]'));
        await click(rows.find((r) => r.textContent?.includes('100 vouch')) ?? null);
        await click(q('invite-revoke'));
        await pressAlert('Revoke');
        expect(q('invite-sheet')).not.toBeNull();
    });

    it('an offline ticket offers no Revoke (the community has never seen it), nor does any invite without onRevoke', async () => {
        renderPending(async () => true);
        await click(q('invites-pending-fold'));
        const rows = Array.from(host.querySelectorAll('[data-testid="invite-pending-row"]'));
        await click(rows.find((r) => r.textContent?.includes(ticket.code)) ?? null);
        expect(q('invite-sheet')).not.toBeNull();
        expect(q('invite-revoke')).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        inviteFolds.clear();
        renderPending(undefined);
        await openRow(0);
        expect(q('invite-sheet')).not.toBeNull();
        expect(q('invite-revoke')).toBeNull();
    });
});

describe('Revoke on the made card', () => {
    const card = (invite: InviteRowSource, who: string | null, onRevoke?: (inv: InviteRowSource) => Promise<boolean>) =>
        act(() => root.render(createElement(InviteMadeCard, { who, invite, now: NOW, qrValue: 'x', shareSlot: createElement('span', null, 'share'), onRevoke }) as any));

    it('names the person for a bound invite and revokes that invite', async () => {
        const revoked: string[] = [];
        card(bound, 'Dee Dee', async (inv) => { revoked.push(inv.code); return true; });
        await click(q('invite-made-revoke'));
        expect(alerts.said[0].text).toBe('Whoever has the link can’t use it. Dee Dee’s name stays on the names list, not confirmed.');
        await pressAlert('Revoke');
        expect(revoked).toEqual([bound.code]);
    });

    it('a plain invite with a note: the note is no name on the list, so the plain words', async () => {
        card({ ...plain, intendedFor: 'Sam' }, 'Sam', async () => true);
        await click(q('invite-made-revoke'));
        expect(alerts.said[0].text).toBe('Whoever has the link can’t use it.');
    });

    it('no Revoke on a ticket or without onRevoke', () => {
        card(ticket, null, async () => true);
        expect(q('invite-made-revoke')).toBeNull();
        card(plain, null, undefined);
        expect(q('invite-made-revoke')).toBeNull();
    });

    it('is 48 dp tall, holds 1.3x text, and draws in the danger colour in light and dark', () => {
        for (const name of ['light', 'dark'] as const) {
            theme.name = name;
            card(plain, null, async () => true);
            const b = q('invite-made-revoke')!;
            const colors = name === 'dark' ? darkColors : lightColors;
            expect(b.getAttribute('data-min-height')).toBe('48');
            expect(b.getAttribute('data-border')).toBe(colors.feedback.danger.fg);
            const label = b.querySelector('span')!;
            expect(label.getAttribute('data-max-font')).toBe('1.3');
            expect(label.getAttribute('data-color')).toBe(colors.feedback.danger.fg);
            expect(label.textContent).toBe('Revoke');
        }
    });
});

describe('People’s revoke is a signed DELETE (source pin)', () => {
    it('signs it itself: the phone’s fetch signs only GETs (utils/node-request-signing.ts), and the node refuses an unsigned revoke', () => {
        const people = readFileSync(join(__dirname, '..', '..', 'app', '(tabs)', 'people.tsx'), 'utf8');
        const signing = readFileSync(join(__dirname, '..', 'node-request-signing.ts'), 'utf8');
        expect(signing).toMatch(/if \(method === 'GET' && toAnchor/);
        expect(people).toMatch(/const headers = await buildSignedHeaders\('DELETE', url, '', identity\.privateKey, identity\.publicKey\);\s*const res = await fetch\(url, \{ method: 'DELETE', headers \}\);/);
    });
});

describe('the names-list entry line while an invite is out (source pins; the line’s words are core inviteOutLine’s, tested in core)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'app', 'names-list.tsx'), 'utf8');

    it('says who made it and the days left, instead of "Invite made, not used yet"', () => {
        expect(src).toMatch(/const out = invite \? inviteOutLine\(invite, callsignOf\(invite\.createdBy\), Date\.now\(\)\) : null;/);
        expect(src).toMatch(/\{out \? \(\s*<Text style=\{styles\.entryMeta\} testID="names-entry-invite-out">\{out\}<\/Text>/);
    });

    it('offers Share again to its maker only, from the maker’s own codes, and Revoke to its maker or an owner', () => {
        expect(src).toMatch(/const mineOut = !!out && invite\?\.createdBy === identity\?\.publicKey;/);
        expect(src).toMatch(/const shareAgainCode = mineOut \? myEntryCodes\.get\(e\.id\) : undefined;/);
        expect(src).toMatch(/const mayRevokeOut = !!out && \(mineOut \|\| amOwner\);/);
        expect(src).toMatch(/a\.pubkey === identity\?\.publicKey && a\.role === 'owner'/);
        expect(src).toMatch(/revokeEntryInvite\(anchor, identity, entry\.id\)/);
    });

    it('offers no second Invite this person while one is out (the node refuses it: invite_out)', () => {
        expect(src).toMatch(/!e\.confirmation && e\.text && !open && !out \? btn\(t\('Invite this person'\)/);
    });
});
