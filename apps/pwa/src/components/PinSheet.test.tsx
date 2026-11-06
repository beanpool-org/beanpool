import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinSheet } from './PinSheet';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        pinMarketplacePost: vi.fn(),
    };
});

describe('PinSheet', () => {
    const samplePost: any = {
        id: 'post-123',
        title: 'Fresh sourdough',
        type: 'offer',
        category: 'food',
        credits: 5,
        priceType: 'fixed',
        status: 'active',
        authorCallsign: 'Baker',
        authorPublicKey: 'baker-key',
        createdAt: '2026-11-01T00:00:00Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders the 3 duration options and cancel when open', () => {
        render(<PinSheet post={samplePost} isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

        expect(screen.getByRole('dialog', { name: 'Pin to the top…' })).toBeInTheDocument();
        const closeBtn = screen.getByRole('button', { name: 'Close' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn).toHaveClass('min-w-[44px]', 'min-h-[44px]', 'w-11', 'h-11');
        expect(screen.getByRole('button', { name: /For 1 day/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /For 3 days/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /For 1 week/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('does not render when closed', () => {
        render(<PinSheet post={samplePost} isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('initializes focus on heading when transitioned from closed to open', () => {
        const { rerender } = render(<PinSheet post={samplePost} isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        rerender(<PinSheet post={samplePost} isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />);
        const heading = screen.getByRole('heading', { name: 'Pin to the top…' });
        expect(heading).toBeInTheDocument();
        expect(document.activeElement).toBe(heading);
    });

    it('pins the post for 3 days and notifies on success', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onSuccess = vi.fn();

        vi.mocked(api.pinMarketplacePost).mockResolvedValueOnce({
            success: true,
            postId: 'post-123',
            pinnedUntil: '2026-11-04T00:00:00Z',
            pinnedAt: '2026-11-01T00:00:00Z',
        });

        render(<PinSheet post={samplePost} isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

        await user.click(screen.getByRole('button', { name: /For 3 days/i }));

        expect(api.pinMarketplacePost).toHaveBeenCalledWith('post-123', 3);
        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
                id: 'post-123',
                pinnedUntil: '2026-11-04T00:00:00Z',
                pinnedAt: '2026-11-01T00:00:00Z',
            }));
            expect(onClose).toHaveBeenCalled();
        });
    });

    it('displays the node refusal message when pinning is refused', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onSuccess = vi.fn();

        vi.mocked(api.pinMarketplacePost).mockRejectedValueOnce(
            new Error('Three posts are pinned already. Take one off first.')
        );

        render(<PinSheet post={samplePost} isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

        await user.click(screen.getByRole('button', { name: /For 1 day/i }));

        expect(api.pinMarketplacePost).toHaveBeenCalledWith('post-123', 1);
        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Three posts are pinned already. Take one off first.');
        });
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes on Escape key', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<PinSheet post={samplePost} isOpen={true} onClose={onClose} onSuccess={vi.fn()} />);

        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });

    it('closes on Cancel button click', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<PinSheet post={samplePost} isOpen={true} onClose={onClose} onSuccess={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
    });
});
