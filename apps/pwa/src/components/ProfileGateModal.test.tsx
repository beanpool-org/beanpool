import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { ProfileGateModal } from './ProfileGateModal';

describe('ProfileGateModal', () => {
    it('renders modal heading, message, and action buttons', () => {
        render(
            <ProfileGateModal
                message="Please complete your profile details."
                onSetup={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByRole('dialog', { name: 'Finish your profile first' })).toBeDefined();
        expect(screen.getByText('Please complete your profile details.')).toBeDefined();

        const notNowBtn = screen.getByRole('button', { name: 'Not now' });
        const setupBtn = screen.getByRole('button', { name: 'Set up profile' });

        expect(notNowBtn).toBeDefined();
        expect(setupBtn).toBeDefined();
        expect(notNowBtn.className).toContain('min-h-[44px]');
        expect(setupBtn.className).toContain('min-h-[44px]');
    });

    it('triggers onClose when Escape key is pressed', () => {
        const handleClose = vi.fn();
        render(
            <ProfileGateModal
                message="Please complete your profile details."
                onSetup={vi.fn()}
                onClose={handleClose}
            />
        );

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('triggers onClose when Not now is clicked and onSetup when Set up profile is clicked', () => {
        const handleClose = vi.fn();
        const handleSetup = vi.fn();

        render(
            <ProfileGateModal
                message="Please complete your profile details."
                onSetup={handleSetup}
                onClose={handleClose}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
        expect(handleClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Set up profile' }));
        expect(handleSetup).toHaveBeenCalledTimes(1);
    });
});
