import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PulseFeedCard } from './PulseFeedCard';
import { type PulseFeedItem, reportAbuse } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    reportAbuse: vi.fn().mockResolvedValue({ success: true }),
}));

const mockItem: PulseFeedItem = {
    id: 'pulse-123',
    ownerPubkey: 'pubkey-owner',
    url: 'https://youtube.com/watch?v=12345',
    platform: 'youtube',
    category: 'skillsharing',
    title: 'Community Gardening Workshop',
    thumbnailUrl: 'https://img.youtube.com/vi/12345/hqdefault.jpg',
    callsign: 'GreenThumb',
    avatarUrl: null,
    source: 'user',
    isVerified: false,
    publishedAt: new Date().toISOString(),
};

describe('PulseFeedCard Accessibility', () => {
    it('renders author profile trigger button with focus ring styling', () => {
        const onOpenProfile = vi.fn();
        render(<PulseFeedCard item={mockItem} onOpenProfile={onOpenProfile} />);

        const authorBtn = screen.getByRole('button', { name: "View GreenThumb's public profile" });
        expect(authorBtn.className).toContain('focus-visible:ring-2');
        expect(authorBtn.className).toContain('focus-visible:ring-terra-500');

        fireEvent.click(authorBtn);
        expect(onOpenProfile).toHaveBeenCalledWith('pubkey-owner');
    });

    it('renders owner action buttons with touch target sizing and focus rings', () => {
        const onMute = vi.fn();
        const onDelete = vi.fn();

        render(
            <PulseFeedCard
                item={mockItem}
                currentPubkey="pubkey-owner"
                onMute={onMute}
                onDelete={onDelete}
            />
        );

        const hideBtn = screen.getByRole('button', { name: 'Hide this item from feed' });
        expect(hideBtn.className).toContain('min-h-[44px]');
        expect(hideBtn.className).toContain('focus-visible:ring-2');

        const deleteBtn = screen.getByRole('button', { name: 'Delete this post' });
        expect(deleteBtn.className).toContain('min-h-[44px]');
        expect(deleteBtn.className).toContain('focus-visible:ring-2');
    });
});

describe('PulseFeedCard Report', () => {
    it('does not offer Report on your own item, or when signed out', () => {
        const { unmount } = render(<PulseFeedCard item={mockItem} currentPubkey="pubkey-owner" onMute={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Report this post' })).not.toBeInTheDocument();
        unmount();

        render(<PulseFeedCard item={mockItem} />);
        expect(screen.queryByRole('button', { name: 'Report this post' })).not.toBeInTheDocument();
    });

    it("reports someone else's item with its Pulse item id through the existing report dialog", async () => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        render(<PulseFeedCard item={mockItem} currentPubkey="pubkey-viewer" />);

        const reportBtn = screen.getByRole('button', { name: 'Report this post' });
        expect(reportBtn.className).toContain('min-h-[48px]');
        expect(reportBtn.className).toContain('min-w-[48px]');

        fireEvent.click(reportBtn);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/Report GreenThumb's post/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Submit Report' }));
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledTimes(1));
        expect(reportAbuse).toHaveBeenCalledWith('pubkey-viewer', 'pubkey-owner', 'Spam or scam', undefined, 'pulse-123');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
});
