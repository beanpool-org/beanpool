import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { CategoryPickerModal } from './CategoryPickerModal';

describe('CategoryPickerModal Component', () => {
    it('renders with modal dialog ARIA attributes when visible', () => {
        const handleClose = vi.fn();
        const handleSelect = vi.fn();

        render(
            <CategoryPickerModal
                visible={true}
                selected="food"
                onSelect={handleSelect}
                onClose={handleClose}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'category-picker-title');

        const title = screen.getByText('Category');
        expect(title).toHaveAttribute('id', 'category-picker-title');

        const closeBtn = screen.getByRole('button', { name: /Close category picker/i });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
    });

    it('renders category buttons with correct aria-pressed states and hidden emojis', () => {
        const handleClose = vi.fn();
        const handleSelect = vi.fn();

        const { container } = render(
            <CategoryPickerModal
                visible={true}
                selected="food"
                onSelect={handleSelect}
                onClose={handleClose}
            />
        );

        const foodBtn = screen.getByRole('button', { name: /Food/i });
        const servicesBtn = screen.getByRole('button', { name: /Services/i });

        expect(foodBtn).toHaveAttribute('aria-pressed', 'true');
        expect(servicesBtn).toHaveAttribute('aria-pressed', 'false');

        const hiddenEmojis = container.querySelectorAll('span[aria-hidden="true"]');
        expect(hiddenEmojis.length).toBeGreaterThan(0);
    });

    it('triggers onSelect and onClose when a category button is clicked', () => {
        const handleClose = vi.fn();
        const handleSelect = vi.fn();

        render(
            <CategoryPickerModal
                visible={true}
                selected="all"
                onSelect={handleSelect}
                onClose={handleClose}
            />
        );

        const toolsBtn = screen.getByRole('button', { name: /Tools/i });
        fireEvent.click(toolsBtn);

        expect(handleSelect).toHaveBeenCalledWith('tools');
        expect(handleClose).toHaveBeenCalledTimes(1);
    });
});
