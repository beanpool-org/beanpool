/**
 * The profile's one button for an owner or admin, on the web (invites-vouching I4; the phone's twin is
 * apps/native/utils/__tests__/profile-voucher-button-render.test.ts): Add to the names list, Make a voucher, or
 * Voucher · 400 left ›, from the node's `voucherButton`. The web holds no names-list key, so the first two say where it is
 * done; the third opens the voucher's card here. A state this version does not know draws nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./VoucherCardModal', () => ({
    VoucherCardModal: ({ memberPubkey, onClose }: { memberPubkey: string; onClose: () => void }) => (
        <div data-testid="stub-voucher-card" onClick={onClose}>{memberPubkey}</div>
    ),
}));

import { ProfileVoucherButton } from './ProfileVoucherButton';

const PAM = 'c'.repeat(64);
afterEach(() => cleanup());

describe('the web profile’s button follows the person’s state', () => {
    it('not on the list: "Add to the names list", and a tap says it is done in the app', () => {
        render(<ProfileVoucherButton button={{ state: 'add' }} memberPubkey={PAM} />);
        const button = screen.getByTestId('profile-voucher-button');
        expect(button).toHaveTextContent(/^Add to the names list$/);
        expect(screen.queryByTestId('profile-voucher-note')).toBeNull();
        fireEvent.click(button);
        expect(screen.getByTestId('profile-voucher-note')).toHaveTextContent(
            'Adding someone to the names list, and making them a voucher, is done in the BeanPool app on your phone.',
        );
        expect(button).toHaveAttribute('aria-describedby', screen.getByTestId('profile-voucher-note').id);
    });

    it('confirmed: "Make a voucher", and a tap says the same', () => {
        render(<ProfileVoucherButton button={{ state: 'make' }} memberPubkey={PAM} />);
        expect(screen.getByTestId('profile-voucher-button')).toHaveTextContent(/^Make a voucher$/);
        fireEvent.click(screen.getByTestId('profile-voucher-button'));
        expect(screen.getByTestId('profile-voucher-note')).toBeInTheDocument();
    });

    it('a voucher: "Voucher · 400 left ›" opens their card here', () => {
        render(<ProfileVoucherButton button={{ state: 'voucher', left: 40000, noLimit: false }} memberPubkey={PAM} />);
        const button = screen.getByTestId('profile-voucher-button');
        expect(button).toHaveTextContent(/^Voucher · 400 left ›$/);
        expect(screen.queryByTestId('stub-voucher-card')).toBeNull();
        fireEvent.click(button);
        expect(screen.getByTestId('stub-voucher-card')).toHaveTextContent(PAM);
        expect(screen.queryByTestId('profile-voucher-note')).toBeNull();
        fireEvent.click(screen.getByTestId('stub-voucher-card'));
        expect(screen.queryByTestId('stub-voucher-card')).toBeNull();
    });

    it('an owner is "Voucher · No limit ›", with no figure', () => {
        render(<ProfileVoucherButton button={{ state: 'voucher', left: 100000, noLimit: true }} memberPubkey={PAM} />);
        expect(screen.getByTestId('profile-voucher-button')).toHaveTextContent(/^Voucher · No limit ›$/);
    });

    it('nothing, or a state this version does not know: no button', () => {
        for (const unknown of [undefined, null, {}, { state: 'confirm' }, { state: 'voucher' }, 'add']) {
            const { container, unmount } = render(<ProfileVoucherButton button={unknown} memberPubkey={PAM} />);
            expect(container).toBeEmptyDOMElement();
            unmount();
        }
    });

    it('no balance figure anywhere', () => {
        for (const state of [{ state: 'add' }, { state: 'make' }, { state: 'voucher', left: 40000, noLimit: false }]) {
            const { container, unmount } = render(<ProfileVoucherButton button={state} memberPubkey={PAM} />);
            expect(container.textContent).not.toMatch(/balance/i);
            unmount();
        }
    });
});
