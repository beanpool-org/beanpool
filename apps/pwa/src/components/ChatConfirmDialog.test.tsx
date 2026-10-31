import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatConfirmDialog } from './ChatConfirmDialog';

describe('ChatConfirmDialog', () => {
    it('renders nothing when isOpen is false', () => {
        const { container } = render(
            <ChatConfirmDialog
                isOpen={false}
                title="Delete Message"
                message="Are you sure you want to delete this message?"
                cancelLabel="Cancel"
                confirmLabel="Delete"
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
            />
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders modal with dialog role, title, message and accessible buttons with touch target styling', () => {
        const onCancel = vi.fn();
        const onConfirm = vi.fn();

        render(
            <ChatConfirmDialog
                isOpen={true}
                title="Delete Message"
                message="Are you sure you want to delete this message?"
                cancelLabel="Cancel"
                confirmLabel="Delete"
                onCancel={onCancel}
                onConfirm={onConfirm}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Delete Message')).toBeInTheDocument();
        expect(screen.getByText('Are you sure you want to delete this message?')).toBeInTheDocument();

        const cancelButton = screen.getByRole('button', { name: 'Cancel' });
        const confirmButton = screen.getByRole('button', { name: 'Delete' });

        expect(cancelButton).toHaveClass('min-h-[44px]');
        expect(confirmButton).toHaveClass('min-h-[44px]');

        fireEvent.click(cancelButton);
        expect(onCancel).toHaveBeenCalledTimes(1);

        fireEvent.click(confirmButton);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });
});
