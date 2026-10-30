import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommunityShapeModal } from './CommunityShapeModal';
import type { CommunityShapeFeatures } from '@beanpool/core';

describe('CommunityShapeModal', () => {
    const FULL_FEATURES: CommunityShapeFeatures = {
        door: 'members',
        knocks: true,
        privatePreview: true,
        beans: true,
        knownFloor: 1000,
        dmRequests: true,
        decisions: true,
        probation: true,
        autoHideReports: true,
        autoMute: true,
    };

    it('does not render when isOpen is false', () => {
        render(<CommunityShapeModal isOpen={false} onClose={vi.fn()} features={FULL_FEATURES} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders modal dialog with header, close button, bold lines, and guide button', () => {
        const onClose = vi.fn();
        const onOpenGuide = vi.fn();
        render(<CommunityShapeModal isOpen={true} onClose={onClose} features={FULL_FEATURES} onOpenGuide={onOpenGuide} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();

        // Check bold elements and content
        expect(screen.getByText('Joining:')).toBeInTheDocument();
        expect(screen.getByText('Private preview:')).toBeInTheDocument();
        expect(screen.getByText('Beans:')).toBeInTheDocument();
        expect(screen.getByText('Confirmed members')).toBeInTheDocument();
        expect(screen.getByText('Messages:')).toBeInTheDocument();
        expect(screen.getByText('Decisions:')).toBeInTheDocument();
        expect(screen.getByText('New accounts:')).toBeInTheDocument();
        expect(screen.getByText('Reported posts')).toBeInTheDocument();
        expect(screen.getByText('Repeat offenders')).toBeInTheDocument();

        // Close button touch target
        const closeBtn = screen.getByTestId('community-shape-close');
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');

        // Click Read more in guide
        const readMoreBtn = screen.getByTestId('community-shape-read-more');
        expect(readMoreBtn).toHaveTextContent('Read more in the guide');
        fireEvent.click(readMoreBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onOpenGuide).toHaveBeenCalledTimes(1);
    });

    it('handles Escape key press', () => {
        const onClose = vi.fn();
        render(<CommunityShapeModal isOpen={true} onClose={onClose} features={FULL_FEATURES} />);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('handles old node that says nothing gracefully', () => {
        render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{}} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();
        expect(screen.getByTestId('community-shape-read-more')).toBeInTheDocument();
        expect(screen.queryByText('Joining:')).not.toBeInTheDocument();
    });
});
