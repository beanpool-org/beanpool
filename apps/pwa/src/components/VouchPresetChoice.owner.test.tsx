/**
 * The vouch presets per role (Marty, 9 Nov): an owner (the node's `noLimit`) sees 25 · 50 · 75 · 100 · 200 · 500, none greyed
 * for budget, and "From your budget: No limit"; an admin or any other voucher sees the four, greyed past what is left, and
 * their budget. Both at 320 px wrap (flex-wrap), each choice 44 px tall.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatNumber } from '@beanpool/core';
import { VouchPresetChoice } from './VouchPresetChoice';

const amounts = () => screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid')?.replace('invite-vouch-', ''));

describe('VouchPresetChoice per role', () => {
    it('shows an owner 200 and 500 too, none greyed for budget, and No limit', () => {
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={0} budgetTotal={0} noLimit />);
        expect(amounts()).toEqual(['none', '25', '50', '75', '100', '200', '500']);
        expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).disabled)).toBe(true);
        expect(screen.getByText('From your budget: No limit')).toBeTruthy();
        expect(screen.queryByText(/No budget left/)).toBeNull();
    });

    it('shows an admin the four, greyed past what is left, with their budget', () => {
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={60} budgetTotal={1000} />);
        expect(amounts()).toEqual(['none', '25', '50', '75', '100']);
        expect((screen.getByTestId('invite-vouch-75') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('invite-vouch-50') as HTMLInputElement).disabled).toBe(false);
        expect(screen.getByText(`From your budget: 60 of ${formatNumber(1000)} left`)).toBeTruthy();
    });

    it("offers an owner's raise as the totals above what they vouched, headed Raise to, with no None and nothing greyed (slice I6)", () => {
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={0} budgetTotal={0} noLimit raiseFrom={100} />);
        expect(amounts()).toEqual(['200', '500']);
        expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).disabled)).toBe(true);
        expect(screen.getByText('Raise to')).toBeTruthy();
        expect(screen.queryByText('Vouch for them')).toBeNull();
        expect(screen.queryByText('None')).toBeNull();
        expect(screen.getByText('From your budget: No limit')).toBeTruthy();
    });

    it('offers an owner at 200 only 500, and at 500 nothing to raise to', () => {
        const { unmount } = render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={0} budgetTotal={0} noLimit raiseFrom={200} />);
        expect(amounts()).toEqual(['500']);
        unmount();
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={0} budgetTotal={0} noLimit raiseFrom={500} />);
        expect(screen.queryAllByRole('radio')).toEqual([]);
    });

    it('offers a voucher the totals up to 100, greyed only where the difference is more than the budget has left', () => {
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={30} budgetTotal={1000} raiseFrom={25} />);
        expect(amounts()).toEqual(['50', '75', '100']);
        // 50 draws 25 (30 left): open. 75 draws 50 and 100 draws 75: greyed on the difference, not on their totals.
        expect((screen.getByTestId('invite-vouch-50') as HTMLInputElement).disabled).toBe(false);
        expect((screen.getByTestId('invite-vouch-75') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('invite-vouch-100') as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByText(`From your budget: 30 of ${formatNumber(1000)} left`)).toBeTruthy();
    });

    it("never offers a voucher an owner's 200 or 500 when raising, and a first vouch still has None", () => {
        const { unmount } = render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={1000} budgetTotal={1000} raiseFrom={75} />);
        expect(amounts()).toEqual(['100']);
        unmount();
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={1000} budgetTotal={1000} />);
        expect(amounts()).toEqual(['none', '25', '50', '75', '100']);
        expect(screen.getByText('Vouch for them')).toBeTruthy();
    });
});
