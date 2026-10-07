import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProfileGateModal } from './ProfileGateModal';

describe('ProfileGateModal', () => {
    it('renders modal dialog with accessible title and message', () => {
        render(
            <ProfileGateModal
                message="Please add a photo before creating an offer."
                onSetup={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'profile-gate-title');

        const title = screen.getByText('Finish your profile first');
        expect(title).toHaveAttribute('id', 'profile-gate-title');

        expect(screen.getByText('Please add a photo before creating an offer.')).toBeInTheDocument();
    });

    it('triggers onClose when Escape key is pressed or backdrop is clicked', () => {
        const onClose = vi.fn();
        render(
            <ProfileGateModal
                message="Test message"
                onSetup={vi.fn()}
                onClose={onClose}
            />
        );

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        const dialog = screen.getByRole('dialog');
        fireEvent.click(dialog);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('triggers onSetup when Set up profile button is clicked', () => {
        const onSetup = vi.fn();
        render(
            <ProfileGateModal
                message="Test message"
                onSetup={onSetup}
                onClose={vi.fn()}
            />
        );

        const setupBtn = screen.getByRole('button', { name: /set up profile/i });
        fireEvent.click(setupBtn);
        expect(onSetup).toHaveBeenCalledTimes(1);
    });

    it('has minimum 44px touch target height and focus-visible ring classes on buttons', () => {
        render(
            <ProfileGateModal
                message="Test message"
                onSetup={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const closeBtn = screen.getByRole('button', { name: /not now/i });
        const setupBtn = screen.getByRole('button', { name: /set up profile/i });

        expect(closeBtn.className).toContain('min-h-[44px]');
        expect(closeBtn.className).toContain('focus-visible:outline-none');
        expect(closeBtn.className).toContain('focus-visible:ring-2');

        expect(setupBtn.className).toContain('min-h-[44px]');
        expect(setupBtn.className).toContain('focus-visible:outline-none');
        expect(setupBtn.className).toContain('focus-visible:ring-2');
    });
});
