import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddressSearch } from './AddressSearch';

describe('AddressSearch', () => {
    it('renders input with focus-visible ring classes and correct ARIA role', () => {
        const onPick = vi.fn();
        render(<AddressSearch onPick={onPick} />);

        const input = screen.getByRole('combobox');
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute('id', 'event-address');
        expect(input.className).toContain('focus-visible:ring-2');
        expect(input.className).toContain('focus-visible:ring-violet-500');
    });
});
