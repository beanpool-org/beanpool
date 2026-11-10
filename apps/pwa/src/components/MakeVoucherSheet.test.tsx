/**
 * "+ Make someone a voucher" on the web (invites-vouching I5; Marty, 10 Nov: admins are vouchers only when an owner makes
 * them one): the node's `candidates` in two sections, Admins and Confirmed on the names list, and nobody else; the stepper
 * starts at the community's default; an admin is made with { memberPubkey }, a confirmed name with its entry id; a refusal
 * in the node's own words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MakeVoucherSheet } from './MakeVoucherSheet';
import * as api from '../lib/api';

vi.mock('../lib/api', () => ({ makeVoucher: vi.fn() }));

const IKE = 'a'.repeat(64);
const LIZ = 'b'.repeat(64);
const LIZ_ENTRY = 'e'.repeat(32);
const CANDIDATES = { admins: [{ memberPubkey: IKE, callsign: 'Ike' }], confirmed: [{ memberPubkey: LIZ, callsign: 'liz', entryId: LIZ_ENTRY }], adminsOffered: true };

describe('MakeVoucherSheet (web, I5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.makeVoucher).mockResolvedValue({} as api.VoucherCardData);
    });

    it('two sections from the node and nobody else; no stepper until someone is picked; no balance', () => {
        render(<MakeVoucherSheet candidates={CANDIDATES} defaultBudget={1000} onClose={() => {}} onMade={() => {}} />);
        const dialog = screen.getByRole('dialog', { name: 'Make someone a voucher' });
        expect(within(dialog).getByTestId('make-voucher-admins')).toHaveTextContent('Admins · no names-list entry needed');
        expect(within(dialog).getByTestId('make-voucher-confirmed')).toHaveTextContent('Confirmed on the names list');
        expect(within(dialog).getAllByTestId('make-voucher-admin-row').map((r) => r.textContent)).toEqual(['@Ike']);
        expect(within(dialog).getAllByTestId('make-voucher-confirmed-row').map((r) => r.textContent)).toEqual(['@liz']);
        expect(screen.queryByTestId('make-voucher-budget')).toBeNull();
        expect(dialog.textContent).not.toMatch(/balance/i);
    });

    it('a committee admin is sent no admins: no Admins heading; nobody at all says so in one sentence', () => {
        const { unmount } = render(<MakeVoucherSheet candidates={{ admins: [], confirmed: CANDIDATES.confirmed, adminsOffered: false }} defaultBudget={1000} onClose={() => {}} onMade={() => {}} />);
        expect(screen.queryByTestId('make-voucher-admins')).toBeNull();
        expect(screen.getAllByTestId('make-voucher-confirmed-row')).toHaveLength(1);
        unmount();
        render(<MakeVoucherSheet candidates={{ admins: [], confirmed: [], adminsOffered: true }} defaultBudget={1000} onClose={() => {}} onMade={() => {}} />);
        expect(screen.getByTestId('make-voucher-nobody')).toHaveTextContent('Nobody to offer: every admin and everyone confirmed on the names list is a voucher already.');
    });

    it('a committee admin with nobody confirmed waiting is not told every admin is a voucher: only an owner makes an admin one (review, 10 Nov)', () => {
        render(<MakeVoucherSheet candidates={{ admins: [], confirmed: [], adminsOffered: false }} defaultBudget={1000} onClose={() => {}} onMade={() => {}} />);
        const line = screen.getByTestId('make-voucher-nobody').textContent ?? '';
        expect(line).toBe('Nobody confirmed on the names list is waiting to be made a voucher. Only an owner makes an admin a voucher.');
        expect(line).not.toMatch(/every admin/i);
    });

    it('an admin picked: the stepper starts at the community default, Make sends { memberPubkey } and the level', async () => {
        const onMade = vi.fn();
        render(<MakeVoucherSheet candidates={CANDIDATES} defaultBudget={800} onClose={() => {}} onMade={onMade} />);
        fireEvent.click(screen.getByTestId('make-voucher-admin-row'));
        expect(screen.getByTestId('make-voucher-amount')).toHaveTextContent('Budget: 800 Beans');
        fireEvent.click(screen.getByRole('button', { name: 'Increase budget' }));
        expect(screen.getByTestId('make-voucher-amount')).toHaveTextContent('Budget: 900 Beans');
        expect(screen.getByTestId('make-voucher-go')).toHaveTextContent('Make @Ike a voucher');
        fireEvent.click(screen.getByTestId('make-voucher-go'));
        await waitFor(() => expect(api.makeVoucher).toHaveBeenCalledWith({ memberPubkey: IKE }, 900));
        await waitFor(() => expect(onMade).toHaveBeenCalled());
        expect(screen.getByRole('status')).toHaveTextContent('@Ike is a voucher now, with a budget of 900 Beans.');
    });

    it('a confirmed name picked: Make sends its entry id', async () => {
        render(<MakeVoucherSheet candidates={CANDIDATES} defaultBudget={1000} onClose={() => {}} onMade={() => {}} />);
        fireEvent.click(screen.getByTestId('make-voucher-confirmed-row'));
        fireEvent.click(screen.getByTestId('make-voucher-go'));
        await waitFor(() => expect(api.makeVoucher).toHaveBeenCalledWith({ entryId: LIZ_ENTRY }, 1000));
    });

    it('the node refuses: its words shown, nothing told as made', async () => {
        vi.mocked(api.makeVoucher).mockRejectedValue(new Error('Only an owner makes an admin a voucher or stops an admin’s budget.'));
        const onMade = vi.fn();
        render(<MakeVoucherSheet candidates={CANDIDATES} defaultBudget={1000} onClose={() => {}} onMade={onMade} />);
        fireEvent.click(screen.getByTestId('make-voucher-admin-row'));
        fireEvent.click(screen.getByTestId('make-voucher-go'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Only an owner makes an admin a voucher or stops an admin’s budget.');
        expect(onMade).not.toHaveBeenCalled();
    });

    it('a default the node never takes starts the stepper at 1,000; it stays within 100 and 2,000', () => {
        render(<MakeVoucherSheet candidates={CANDIDATES} defaultBudget={undefined} onClose={() => {}} onMade={() => {}} />);
        fireEvent.click(screen.getByTestId('make-voucher-admin-row'));
        expect(screen.getByTestId('make-voucher-amount')).toHaveTextContent('Budget: 1,000 Beans');
        const up = screen.getByRole('button', { name: 'Increase budget' });
        for (let i = 0; i < 15; i++) fireEvent.click(up);
        expect(screen.getByTestId('make-voucher-amount')).toHaveTextContent('Budget: 2,000 Beans');
        expect(up).toBeDisabled();
    });
});
