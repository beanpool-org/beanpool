import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommonsInfoModal } from './CommonsInfoModal';

describe('CommonsInfoModal', () => {
    it('does not render when isOpen is false', () => {
        render(<CommonsInfoModal isOpen={false} onClose={vi.fn()} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders modal dialog with accessible tabs, touch targets, and focus ring classes', () => {
        const onClose = vi.fn();
        render(<CommonsInfoModal isOpen={true} onClose={onClose} commonsBalance={123.45} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Community Commons')).toBeInTheDocument();
        expect(screen.getByText('123.45 🫘')).toBeInTheDocument();

        // Close button touch target & aria label
        const closeBtn = screen.getByRole('button', { name: /close information modal/i });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
        expect(closeBtn.className).toContain('focus-visible:ring-emerald-500');

        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('switches tabs and handles Escape key press', () => {
        const onClose = vi.fn();
        render(<CommonsInfoModal isOpen={true} onClose={onClose} />);

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3);

        const flowTab = screen.getByRole('tab', { name: /how it works/i });
        const bracketsTab = screen.getByRole('tab', { name: /circulation fees/i });
        const qvTab = screen.getByRole('tab', { name: /voting/i });

        expect(flowTab).toHaveAttribute('aria-selected', 'true');
        expect(bracketsTab).toHaveClass('min-h-[44px]');
        expect(bracketsTab).toHaveClass('focus-visible:ring-emerald-500');

        // Switch to Circulation Fees
        fireEvent.click(bracketsTab);
        expect(bracketsTab).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText(/progressive monthly contribution/i)).toBeInTheDocument();

        // Switch to Voting
        fireEvent.click(qvTab);
        expect(qvTab).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText(/quadratic voting/i)).toBeInTheDocument();

        // Escape key closes modal
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
