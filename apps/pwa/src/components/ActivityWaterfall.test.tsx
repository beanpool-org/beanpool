import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityWaterfall } from './ActivityWaterfall';
import * as api from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof api>();
    return {
        ...actual,
        getActivityFeedApi: vi.fn(),
    };
});

describe('ActivityWaterfall', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('handles API error gracefully and updates loading state', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(api.getActivityFeedApi).mockRejectedValueOnce(new Error('Network error'));

        render(<ActivityWaterfall isFullView={true} />);

        // Initially shows loading state in full view
        expect(screen.getByText('Tuning into community pulse...')).toBeInTheDocument();

        // Wait for fetchFeed async function to catch the rejection and finish loading
        await waitFor(() => {
            expect(screen.queryByText('Tuning into community pulse...')).not.toBeInTheDocument();
        });

        // Verify fallback/empty state is rendered when feed is empty after error
        expect(screen.getByText('Welcome to the Community')).toBeInTheDocument();
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            '[ActivityWaterfall] Could not fetch activity feed:',
            expect.any(Error)
        );

        consoleWarnSpy.mockRestore();
    });

    it('renders feed items on successful API fetch in full view', async () => {
        vi.mocked(api.getActivityFeedApi).mockResolvedValueOnce({
            feed: [
                {
                    id: 1,
                    eventType: 'member_joined',
                    actorPubkey: '0x123',
                    actorCallsign: 'Alice',
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        render(<ActivityWaterfall isFullView={true} />);

        await waitFor(() => {
            expect(screen.getByText('Alice')).toBeInTheDocument();
        });

        expect(screen.getByText('joined the community')).toBeInTheDocument();
    });

    it('returns null in compact mode when loading fails and feed is empty', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(api.getActivityFeedApi).mockRejectedValueOnce(new Error('Fetch failed'));

        const { container } = render(<ActivityWaterfall isFullView={false} />);

        await waitFor(() => {
            expect(api.getActivityFeedApi).toHaveBeenCalled();
        });

        expect(container.firstChild).toBeNull();
    });
});
