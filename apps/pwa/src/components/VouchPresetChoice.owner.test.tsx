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

    it("greys an owner's raise past 500 for one person, never past 100", () => {
        render(<VouchPresetChoice value={null} onChange={() => {}} budgetLeft={0} budgetTotal={0} noLimit priorVouch={200} personName="sam" />);
        expect((screen.getByTestId('invite-vouch-200') as HTMLInputElement).disabled).toBe(false);
        expect((screen.getByTestId('invite-vouch-500') as HTMLInputElement).disabled).toBe(true);
    });
});
