import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AvatarPresetPicker } from './AvatarPresetPicker';

describe('AvatarPresetPicker accessibility and interactions', () => {
    it('renders scrollable preset region with accessible attributes and focus ring styling', () => {
        render(<AvatarPresetPicker onSelect={vi.fn()} />);

        const region = screen.getByRole('region', { name: 'Or choose an avatar:' });
        expect(region).toBeInTheDocument();
        expect(region).toHaveAttribute('tabIndex', '0');
        expect(region).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-emerald-500');
    });

    it('renders avatar preset buttons with aria-pressed and handles selection', () => {
        const handleSelect = vi.fn();
        render(<AvatarPresetPicker selected="bundled://bean-green" onSelect={handleSelect} />);

        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);

        const firstButton = buttons[0];
        expect(firstButton).toHaveAttribute('aria-pressed', 'true');

        const secondButton = buttons[1];
        expect(secondButton).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(secondButton);
        expect(handleSelect).toHaveBeenCalledWith('bundled://bean-purple');
    });
});
