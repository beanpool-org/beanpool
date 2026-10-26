import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PulseFeedCard } from './PulseFeedCard';
import { type PulseFeedItem, reportAbuse, getDailyPulse } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    reportAbuse: vi.fn().mockResolvedValue({ success: true }),
    getDailyPulse: vi.fn(),
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

        // No reason is picked until the member chooses one (review of #1912), so Submit is off until then.
        expect(screen.getByRole('button', { name: 'Submit Report' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Spam or scam' }));
        fireEvent.click(screen.getByRole('button', { name: 'Submit Report' }));
        await waitFor(() => expect(reportAbuse).toHaveBeenCalledTimes(1));
        expect(reportAbuse).toHaveBeenCalledWith('pubkey-viewer', 'pubkey-owner', 'Spam or scam', undefined, 'pulse-123');
        // Sent is said in the dialog (rehearsal 14 Oct N3, was an alert()); Done closes it.
        fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
});

const instagramNoThumb: PulseFeedItem = {
    id: 'pulse-ig-1',
    ownerPubkey: 'pubkey-kofi',
    url: 'https://www.instagram.com/p/abc123xyz/',
    platform: 'instagram',
    category: 'art',
    title: 'Kiln firing at dawn\nSecond line of caption that should not be in title',
    thumbnailUrl: null,
    callsign: 'Kofi',
    avatarUrl: null,
    source: 'user',
    isVerified: false,
    publishedAt: new Date().toISOString(),
};

const instagramWithThumb: PulseFeedItem = {
    id: 'pulse-ig-2',
    ownerPubkey: 'pubkey-kofi',
    url: 'https://www.instagram.com/p/abc123xyz/',
    platform: 'instagram',
    category: 'art',
    title: 'Kiln firing at dawn',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    callsign: 'Kofi',
    avatarUrl: null,
    source: 'user',
    isVerified: false,
    publishedAt: new Date().toISOString(),
};

describe('PulseFeedCard Instagram link card (web)', () => {
    it('an Instagram item with no thumbnail renders the card title/author and one Open on Instagram button, no empty block, and only one link', () => {
        const { container } = render(<PulseFeedCard item={instagramNoThumb} />);

        // Title first line
        expect(screen.getByText('Kiln firing at dawn')).toBeInTheDocument();
        expect(screen.queryByText(/Second line of caption/)).not.toBeInTheDocument();

        // Author
        expect(screen.getAllByText('Kofi').length).toBeGreaterThanOrEqual(1);

        // ONE clear button "Open on Instagram" (button >= 44px)
        const igBtn = screen.getByRole('link', { name: 'Open on Instagram' });
        expect(igBtn).toBeInTheDocument();
        expect(igBtn.className).toContain('min-h-[44px]');

        // No empty aspect-video block
        expect(container.querySelector('.aspect-video')).not.toBeInTheDocument();

        // Exactly one link to the post
        const links = screen.getAllByRole('link');
        expect(links).toHaveLength(1);
    });

    it('a failed image falls back to the same card', () => {
        const { container } = render(<PulseFeedCard item={instagramWithThumb} />);

        const img = container.querySelector('img');
        expect(img).not.toBeNull();
        fireEvent.error(img!);

        // Falls back to designed card
        expect(screen.getByText('Kiln firing at dawn')).toBeInTheDocument();
        expect(screen.getAllByText('Kofi').length).toBeGreaterThanOrEqual(1);

        const igBtn = screen.getByRole('link', { name: 'Open on Instagram' });
        expect(igBtn).toBeInTheDocument();
        expect(igBtn.className).toContain('min-h-[44px]');

        expect(container.querySelector('.aspect-video')).not.toBeInTheDocument();
        expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('an Instagram item with a valid thumbnail shows the thumbnail with platform badge and drops duplicate second link', () => {
        const { container } = render(<PulseFeedCard item={instagramWithThumb} />);

        // Shows thumbnail with badge
        expect(container.querySelector('img')).toBeInTheDocument();
        expect(screen.getByText('Instagram ↗')).toBeInTheDocument();

        // Does NOT render duplicate second link in footer
        expect(screen.queryByText(/Open on Instagram/)).not.toBeInTheDocument();
    });

    it('handles caption with leading newlines and whitespace safely', () => {
        const itemWithLeadingNewlines = {
            ...instagramNoThumb,
            id: 'pulse-ig-leading-newlines',
            title: '\n\n   \nActual caption first line\nSecond line',
        };
        const { unmount } = render(<PulseFeedCard item={itemWithLeadingNewlines} />);

        expect(screen.getByText('Actual caption first line')).toBeInTheDocument();
        expect(screen.queryByText(/Second line/)).not.toBeInTheDocument();
        unmount();

        const itemWhitespaceOnly = {
            ...instagramNoThumb,
            id: 'pulse-ig-whitespace',
            title: '   \n\n   ',
        };
        render(<PulseFeedCard item={itemWhitespaceOnly} />);

        // Falls back to localized platform title rather than empty string
        expect(screen.getByText('View post on Instagram')).toBeInTheDocument();
    });

    it('a YouTube item is unchanged', () => {
        const { container } = render(<PulseFeedCard item={mockItem} />);

        // YouTube retains aspect-video and Open on YouTube link
        expect(container.querySelector('.aspect-video')).toBeInTheDocument();
        expect(screen.getByText(/Open on YouTube/)).toBeInTheDocument();
    });

    describe('Daily Pulse card (web)', () => {
        const dailyPulseItem: PulseFeedItem = {
            id: 'item_pulse_2026-10-26',
            ownerPubkey: 'pubkey-pulse-treasury',
            url: null,
            platform: 'website',
            category: 'learn',
            title: 'Plant seeds of kindness',
            thumbnailUrl: null,
            callsign: 'Daily Pulse',
            avatarUrl: null,
            source: 'curated',
            isVerified: true,
            publishedAt: '2026-10-26T05:00:00.000Z',
        };

        it('renders as button/link with accessible name, and click opens reflection dialog labelled by headline', async () => {
            vi.mocked(getDailyPulse).mockResolvedValueOnce({
                date: '2026-10-26',
                headline: 'Plant seeds of kindness',
                body: 'Kindness is the soil in which trust grows.',
            });

            render(<PulseFeedCard item={dailyPulseItem} />);

            const trigger = screen.getByRole('button', { name: /Daily Reflection/i });
            expect(trigger).toBeInTheDocument();

            fireEvent.click(trigger);

            const dialog = await screen.findByRole('dialog');
            expect(dialog).toBeInTheDocument();

            const labelledById = dialog.getAttribute('aria-labelledby');
            expect(labelledById).toBeTruthy();
            const headlineEl = document.getElementById(labelledById!);
            expect(headlineEl).toHaveTextContent('Plant seeds of kindness');

            expect(screen.getByText('Kindness is the soil in which trust grows.')).toBeInTheDocument();
            expect(screen.getByText('2026-10-26')).toBeInTheDocument();

            // Close button works and focus returns to the card
            const closeBtn = screen.getByRole('button', { name: 'Close' });
            fireEvent.click(closeBtn);
            await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
            expect(document.activeElement).toBe(trigger);
        });

        it('Escape closes the reflection dialog and returns focus to the card', async () => {
            vi.mocked(getDailyPulse).mockResolvedValueOnce({
                date: '2026-10-26',
                headline: 'Plant seeds of kindness',
                body: 'Kindness is the soil in which trust grows.',
            });

            render(<PulseFeedCard item={dailyPulseItem} />);

            const trigger = screen.getByRole('button', { name: /Daily Reflection/i });
            fireEvent.click(trigger);

            const dialog = await screen.findByRole('dialog');
            expect(dialog).toBeInTheDocument();

            fireEvent.keyDown(window, { key: 'Escape' });
            await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
            expect(document.activeElement).toBe(trigger);
        });

        it('shows a line in the app words with Retry on failed read, and Retry re-fetches', async () => {
            vi.mocked(getDailyPulse).mockRejectedValueOnce(new Error('Network error'));

            render(<PulseFeedCard item={dailyPulseItem} />);

            const trigger = screen.getByRole('button', { name: /Daily Reflection/i });
            fireEvent.click(trigger);

            const dialog = await screen.findByRole('dialog');
            expect(dialog).toBeInTheDocument();

            // Shows error message and Retry button
            expect(screen.getByText('Failed to load')).toBeInTheDocument();
            const retryBtn = screen.getByRole('button', { name: 'Retry' });
            expect(retryBtn).toBeInTheDocument();

            // Clicking Retry re-fetches
            vi.mocked(getDailyPulse).mockResolvedValueOnce({
                date: '2026-10-26',
                headline: 'Plant seeds of kindness',
                body: 'Kindness is the soil in which trust grows.',
            });

            fireEvent.click(retryBtn);
            await waitFor(() => expect(screen.getByText('Kindness is the soil in which trust grows.')).toBeInTheDocument());
        });

        it('normal Pulse item still opens its URL in a new window', () => {
            const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

            render(<PulseFeedCard item={mockItem} />);

            const cardLink = screen.getByRole('link', { name: /Open post on YouTube/i });
            fireEvent.click(cardLink);

            expect(windowOpenSpy).toHaveBeenCalledWith(mockItem.url, '_blank', 'noopener,noreferrer');
            windowOpenSpy.mockRestore();
        });
    });
});

