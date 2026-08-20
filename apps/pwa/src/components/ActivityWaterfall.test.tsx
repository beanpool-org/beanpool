import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { ActivityWaterfall } from './ActivityWaterfall';
import { getActivityFeedApi, type ActivityFeedItem } from '../lib/api';

vi.mock('../lib/api', () => ({
    getActivityFeedApi: vi.fn(),
}));

const mockGetActivityFeedApi = vi.mocked(getActivityFeedApi);

describe('ActivityWaterfall', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Loading state', () => {
        it('renders loading spinner in full view mode', async () => {
            mockGetActivityFeedApi.mockImplementation(() => new Promise(() => {})); // Never resolves

            render(<ActivityWaterfall isFullView={true} />);

            expect(screen.getByText('Tuning into community pulse...')).toBeInTheDocument();
            expect(screen.getByText('⏳')).toBeInTheDocument();
        });

        it('renders null in compact mode while loading', async () => {
            mockGetActivityFeedApi.mockImplementation(() => new Promise(() => {}));

            const { container } = render(<ActivityWaterfall isFullView={false} />);

            expect(container.firstChild).toBeNull();
        });
    });

    describe('Empty feed state', () => {
        it('renders empty welcome card in full view mode', async () => {
            mockGetActivityFeedApi.mockResolvedValue({ feed: [] });

            render(<ActivityWaterfall isFullView={true} />);

            await waitFor(() => {
                expect(screen.getByText('Welcome to the Community')).toBeInTheDocument();
            });

            expect(screen.getByText(/You're among the first here!/i)).toBeInTheDocument();
        });

        it('renders null in compact mode when feed is empty', async () => {
            mockGetActivityFeedApi.mockResolvedValue({ feed: [] });

            const { container } = render(<ActivityWaterfall isFullView={false} />);

            await waitFor(() => {
                expect(mockGetActivityFeedApi).toHaveBeenCalled();
            });

            expect(container.firstChild).toBeNull();
        });
    });

    describe('Full view mode with items', () => {
        it('renders all event types with metadata and fallback callsigns correctly', async () => {
            const mockFeed: ActivityFeedItem[] = [
                {
                    id: 1,
                    eventType: 'member_joined',
                    actorPubkey: 'pub1',
                    actorCallsign: 'Alice',
                    createdAt: new Date().toISOString(), // "just now"
                },
                {
                    id: 2,
                    eventType: 'trade_completed',
                    actorPubkey: 'pub1',
                    actorCallsign: 'Alice',
                    targetPubkey: 'pub2',
                    targetCallsign: 'Bob',
                    metadata: { credits: 25 },
                    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // "5m ago"
                },
                {
                    id: 3,
                    eventType: 'rating_given',
                    actorPubkey: 'pub2',
                    actorCallsign: 'Bob',
                    targetPubkey: 'pub1',
                    targetCallsign: 'Alice',
                    metadata: { stars: 4, comment: 'Awesome service!' },
                    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), // "3h ago"
                },
                {
                    id: 4,
                    eventType: 'post_created',
                    actorPubkey: 'pub1',
                    actorCallsign: 'Alice',
                    metadata: { title: 'Fresh Veggies', credits: 10 },
                    createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(), // "2d ago"
                },
                {
                    id: 5,
                    eventType: 'member_joined',
                    actorPubkey: 'pub3', // Missing actorCallsign -> defaults to "Member"
                    createdAt: new Date().toISOString(),
                },
            ];

            mockGetActivityFeedApi.mockResolvedValue({ feed: mockFeed });

            render(<ActivityWaterfall isFullView={true} />);

            await waitFor(() => {
                expect(screen.getByText('Recent Community Life')).toBeInTheDocument();
            });

            // Headers
            expect(screen.getByText('Community Pulse')).toBeInTheDocument();
            expect(screen.getByText('Live activity across members and trades')).toBeInTheDocument();

            // Item 1: member_joined
            expect(screen.getByText((content, element) => {
                return element?.tagName.toLowerCase() === 'p' && element?.textContent === 'Alice joined the community';
            })).toBeInTheDocument();

            // Item 2: trade_completed
            expect(screen.getByText((content, element) => {
                return element?.tagName.toLowerCase() === 'p' && (element?.textContent?.includes('Alice completed a trade with Bob') ?? false);
            })).toBeInTheDocument();
            expect(screen.getByText('(🫘 25)')).toBeInTheDocument();

            // Item 3: rating_given
            expect(screen.getByText((content, element) => {
                return element?.tagName.toLowerCase() === 'p' && (element?.textContent?.includes('Bob rated Alice') ?? false);
            })).toBeInTheDocument();
            expect(screen.getByLabelText('4 out of 5 stars')).toHaveTextContent('★★★★');
            expect(screen.getByText('"Awesome service!"')).toBeInTheDocument();

            // Item 4: post_created
            expect(screen.getByText((content, element) => {
                return element?.tagName.toLowerCase() === 'p' && (element?.textContent?.includes('Alice posted "Fresh Veggies" for 🫘 10') ?? false);
            })).toBeInTheDocument();

            // Item 5: fallback callsign
            expect(screen.getByText((content, element) => {
                return element?.tagName.toLowerCase() === 'p' && element?.textContent === 'Member joined the community';
            })).toBeInTheDocument();

            // Time strings
            expect(screen.getByText('5m ago')).toBeInTheDocument();
            expect(screen.getByText('3h ago')).toBeInTheDocument();
            expect(screen.getByText('2d ago')).toBeInTheDocument();
        });
    });

    describe('Compact strip mode with items', () => {
        it('renders live pulse header and limits ticker items to 5', async () => {
            const mockFeed: ActivityFeedItem[] = Array.from({ length: 7 }, (_, i) => ({
                id: i + 1,
                eventType: i % 4 === 0 ? 'member_joined' : i % 4 === 1 ? 'trade_completed' : i % 4 === 2 ? 'rating_given' : 'post_created',
                actorPubkey: `pub${i}`,
                actorCallsign: `User${i}`,
                createdAt: new Date().toISOString(),
            }));

            mockGetActivityFeedApi.mockResolvedValue({ feed: mockFeed });

            render(<ActivityWaterfall isFullView={false} />);

            await waitFor(() => {
                expect(screen.getByText('Live Pulse')).toBeInTheDocument();
            });

            // Check that only 5 items are displayed in compact ticker
            expect(screen.getByText('User0 joined')).toBeInTheDocument();
            expect(screen.getByText('User1 traded')).toBeInTheDocument();
            expect(screen.getByText('User2 rated ★')).toBeInTheDocument();
            expect(screen.getByText('User3 posted')).toBeInTheDocument();
            expect(screen.getByText('User4 joined')).toBeInTheDocument();
            expect(screen.queryByText('User5 traded')).not.toBeInTheDocument();
        });
    });

    describe('Error handling', () => {
        it('handles API rejection gracefully without breaking UI', async () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockGetActivityFeedApi.mockRejectedValue(new Error('API failure'));

            render(<ActivityWaterfall isFullView={true} />);

            await waitFor(() => {
                expect(consoleSpy).toHaveBeenCalledWith('[ActivityWaterfall] Could not fetch activity feed:', expect.any(Error));
            });

            // After error in full view mode, loading becomes false and empty state is rendered
            expect(screen.getByText('Welcome to the Community')).toBeInTheDocument();

            consoleSpy.mockRestore();
        });
    });

    describe('Polling and cleanup', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('fetches feed on interval and stops on unmount', async () => {
            mockGetActivityFeedApi.mockResolvedValue({ feed: [] });

            const { unmount } = render(<ActivityWaterfall isFullView={true} />);

            // Initial call
            expect(mockGetActivityFeedApi).toHaveBeenCalledTimes(1);
            expect(mockGetActivityFeedApi).toHaveBeenCalledWith(30, 0);

            // Fast forward 30 seconds
            await act(async () => {
                vi.advanceTimersByTime(30000);
            });

            expect(mockGetActivityFeedApi).toHaveBeenCalledTimes(2);

            // Unmount
            unmount();

            // Fast forward another 30 seconds
            await act(async () => {
                vi.advanceTimersByTime(30000);
            });

            // No additional calls after unmount
            expect(mockGetActivityFeedApi).toHaveBeenCalledTimes(2);
        });
    });
});
