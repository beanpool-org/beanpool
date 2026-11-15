import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { inviteFolds, type InviteRowSource } from '@beanpool/core';

/**
 * The names-list name beside an invite, on the web (Marty's 12 Nov idea, yes 15 Nov). The names are sealed on the admins'
 * phones and this browser holds no names-list key (the names list on the web is parked, Marty 6 Nov), so a bound invite
 * says "Name on the phone" where the phone says the name: in its Pending row, in the opened invite and beside the joiner in
 * Joined, and never in the link its QR holds. An invite the node sent without its entry (its maker no longer reads the
 * names list: server test-invite-names-entry-readers) reads as an invite with no entry: its note or its code, and it no
 * longer says it confirms them as known. The phone's twin is apps/native/utils/__tests__/invite-rows-names-list-name-render.test.ts.
 */
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} /> }));

import { PendingInvites } from './PendingInvites';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const made = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const bound: InviteRowSource = { code: 'INV-DEED-0001', createdAt: made(3), namesEntryId: 'a'.repeat(32), vouchAmount: 20000 };
const note: InviteRowSource = { code: 'INV-KIMM-0003', createdAt: made(1), intendedFor: 'Kim', namesEntryId: null };
const withheld: InviteRowSource = { code: 'INV-WTHH-0004', createdAt: made(2), namesEntryId: null, voucherLevel: 100000 };
const joined: InviteRowSource = { code: 'INV-JOIN-0005', createdAt: made(9), usedBy: 'c'.repeat(64), usedAt: made(8), usedByCallsign: 'Denden', namesEntryId: 'a'.repeat(32) };

beforeEach(() => inviteFolds.clear());
afterEach(cleanup);

const draw = (invites: InviteRowSource[]) => render(
    <PendingInvites invites={invites} now={NOW} linkFor={(c) => `https://riverside.example/?invite=${c}`} shareFor={() => <span>share</span>} />,
);
const pendingRows = () => screen.queryAllByTestId('invite-pending-row');
const who = (row: HTMLElement) => within(row).getByTestId('invite-who').textContent;

describe('the names-list name beside an invite, on the web', () => {
    it('a bound invite says the name is on the phone, an invite with a note says the note, in Pending', () => {
        draw([bound, note]);
        fireEvent.click(screen.getByTestId('invites-pending-fold'));
        expect(pendingRows().map(who)).toEqual(expect.arrayContaining(['Name on the phone', 'For: Kim']));
        expect(pendingRows().map(who)).not.toContain(bound.code);
    });

    it('the opened bound invite says so too, and its QR holds the link with the code alone', () => {
        draw([bound]);
        fireEvent.click(screen.getByTestId('invites-pending-fold'));
        fireEvent.click(pendingRows()[0]);
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByTestId('invite-who')).toHaveTextContent('Name on the phone');
        expect(within(dialog).getByTestId('qr').getAttribute('data-value')).toBe(`https://riverside.example/?invite=${bound.code}`);
    });

    it('Joined: "Name on the phone" beside the member who joined with it', () => {
        draw([joined]);
        fireEvent.click(screen.getByTestId('invites-joined-fold'));
        expect(screen.getByTestId('invite-joined-row')).toHaveTextContent(/^Name on the phone · @Denden/);
    });

    it('an invite the node sent without its entry reads as one with no entry: its code, and no "confirms them as known"', () => {
        draw([withheld]);
        fireEvent.click(screen.getByTestId('invites-pending-fold'));
        const row = pendingRows()[0];
        expect(who(row)).toBe(withheld.code);
        expect(row).not.toHaveTextContent('Name on the phone');
        expect(within(row).getByTestId('invite-carries')).toHaveTextContent(/^voucher budget 1,000$/);
    });
});
