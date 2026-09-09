import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageLightbox } from './ImageLightbox';

describe('ImageLightbox Component', () => {
    const mockPhotos = [
        '/api/marketplace/posts/post-1/photos/0?v=100',
        '/api/marketplace/posts/post-1/photos/1?v=100',
        '/api/marketplace/posts/post-1/photos/2?v=100',
    ];

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when isOpen is false', () => {
        render(
            <ImageLightbox
                isOpen={false}
                photos={mockPhotos}
                onClose={vi.fn()}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not render when photos array is empty', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={[]}
                onClose={vi.fn()}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders with role="dialog", aria-modal="true", and accessible label', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                title="Fresh Organic Carrots"
                onClose={vi.fn()}
            />
        );
        const dialog = screen.getByRole('dialog', { name: 'Photo viewer: Fresh Organic Carrots' });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('has a prominent close control with accessible label and at least 44x44px touch target', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={vi.fn()}
            />
        );
        const closeBtn = screen.getByRole('button', { name: 'Close photo viewer' });
        expect(closeBtn).toBeInTheDocument();
        // Verifies classes ensure >= 44px min touch target for 320dp viewport
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
    });

    it('calls onClose when clicking the close button', () => {
        const onClose = vi.fn();
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={onClose}
            />
        );
        const closeBtn = screen.getByRole('button', { name: 'Close photo viewer' });
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('dismisses when clicking the backdrop overlay', () => {
        const onClose = vi.fn();
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={onClose}
            />
        );
        const dialog = screen.getByRole('dialog');
        fireEvent.click(dialog);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss when clicking inside the content area', () => {
        const onClose = vi.fn();
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={onClose}
            />
        );
        const img = screen.getByAltText(/Photo 1 of 3/);
        fireEvent.click(img);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('dismisses when pressing Escape key', () => {
        const onClose = vi.fn();
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={onClose}
            />
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders single photo correctly: hides prev/next buttons, counter, and dots', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={['/api/marketplace/posts/post-single/photos/0']}
                title="Single Item"
                onClose={vi.fn()}
            />
        );
        expect(screen.queryByRole('button', { name: 'Previous photo' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
        expect(screen.queryByText(/1 \/ 1/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Go to photo/ })).not.toBeInTheDocument();
    });

    it('renders multiple photos: shows counter, prev/next buttons, and navigates', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                initialIndex={0}
                onClose={vi.fn()}
            />
        );
        // Counter badge
        expect(screen.getByText('1 / 3')).toBeInTheDocument();

        // Next button advances to photo 2
        const nextBtn = screen.getByRole('button', { name: 'Next photo' });
        fireEvent.click(nextBtn);
        expect(screen.getByText('2 / 3')).toBeInTheDocument();

        // Prev button returns to photo 1
        const prevBtn = screen.getByRole('button', { name: 'Previous photo' });
        fireEvent.click(prevBtn);
        expect(screen.getByText('1 / 3')).toBeInTheDocument();
    });

    it('supports keyboard ArrowLeft and ArrowRight navigation for multiple photos', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                initialIndex={0}
                onClose={vi.fn()}
            />
        );
        expect(screen.getByText('1 / 3')).toBeInTheDocument();

        // ArrowRight navigates to next
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(screen.getByText('2 / 3')).toBeInTheDocument();

        // ArrowLeft navigates back
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
        expect(screen.getByText('1 / 3')).toBeInTheDocument();

        // ArrowLeft wraps around to last photo
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
    });

    it('navigates when clicking dot indicators', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                initialIndex={0}
                onClose={vi.fn()}
            />
        );
        const dot3 = screen.getByRole('button', { name: 'Go to photo 3 of 3' });
        fireEvent.click(dot3);
        expect(screen.getByText('3 / 3')).toBeInTheDocument();
    });

    it('shows loading spinner initially and handles failed load with retry option', () => {
        render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={vi.fn()}
            />
        );
        // Loading state
        expect(screen.getByRole('status', { name: 'Loading photo' })).toBeInTheDocument();

        // Simulate image load failure
        const img = screen.getByAltText(/Photo 1 of 3/);
        fireEvent.error(img);

        // Friendly error UI (not an empty black box)
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText('Photo failed to load')).toBeInTheDocument();

        // Retry button
        const retryBtn = screen.getByRole('button', { name: 'Retry' });
        expect(retryBtn).toBeInTheDocument();
        fireEvent.click(retryBtn);

        // Reset to loading state
        expect(screen.getByRole('status', { name: 'Loading photo' })).toBeInTheDocument();
    });

    it('locks body scroll when open and restores it when unmounted', () => {
        document.body.style.overflow = 'auto';
        const { unmount } = render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={vi.fn()}
            />
        );
        expect(document.body.style.overflow).toBe('hidden');

        unmount();
        expect(document.body.style.overflow).toBe('auto');
    });

    it('restores focus to trigger element when closed', () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        expect(document.activeElement).toBe(trigger);

        const { rerender } = render(
            <ImageLightbox
                isOpen={true}
                photos={mockPhotos}
                onClose={vi.fn()}
                triggerElement={trigger}
            />
        );

        // Close
        rerender(
            <ImageLightbox
                isOpen={false}
                photos={mockPhotos}
                onClose={vi.fn()}
                triggerElement={trigger}
            />
        );

        expect(document.activeElement).toBe(trigger);
        document.body.removeChild(trigger);
    });
});
