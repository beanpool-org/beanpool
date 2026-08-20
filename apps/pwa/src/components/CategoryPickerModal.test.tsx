import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CategoryPickerModal } from './CategoryPickerModal';

describe('CategoryPickerModal', () => {
    const defaultProps = {
        visible: true,
        selected: 'all',
        onSelect: vi.fn(),
        onClose: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders nothing when visible is false', () => {
        const { container } = render(
            <CategoryPickerModal {...defaultProps} visible={false} />
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders modal content and categories when visible is true', () => {
        render(<CategoryPickerModal {...defaultProps} />);

        expect(screen.getByText('Category')).toBeInTheDocument();
        expect(screen.getByText('All')).toBeInTheDocument();
        expect(screen.getByText('Food')).toBeInTheDocument();
        expect(screen.getByText('Services')).toBeInTheDocument();
        expect(screen.getByText('Tech')).toBeInTheDocument();
    });

    it('highlights active category based on selected prop', () => {
        render(<CategoryPickerModal {...defaultProps} selected="food" />);

        const foodButton = screen.getByText('Food').closest('button');
        const allButton = screen.getByText('All').closest('button');

        expect(foodButton?.className).toContain('bg-indigo-50');
        expect(allButton?.className).toContain('bg-nature-50');
    });

    it('calls onSelect and onClose when a category button is clicked', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();

        render(
            <CategoryPickerModal
                {...defaultProps}
                onSelect={onSelect}
                onClose={onClose}
            />
        );

        const foodButton = screen.getByText('Food').closest('button');
        if (!foodButton) throw new Error('Food button not found');

        fireEvent.click(foodButton);

        expect(onSelect).toHaveBeenCalledWith('food');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when backdrop backdrop overlay is clicked', () => {
        const onClose = vi.fn();

        const { container } = render(
            <CategoryPickerModal {...defaultProps} onClose={onClose} />
        );

        const backdrop = container.firstChild as HTMLElement;
        fireEvent.click(backdrop);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when modal container content is clicked', () => {
        const onClose = vi.fn();

        render(<CategoryPickerModal {...defaultProps} onClose={onClose} />);

        const heading = screen.getByText('Category');
        fireEvent.click(heading);

        expect(onClose).not.toHaveBeenCalled();
    });
});
