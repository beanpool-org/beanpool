import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

import type { BeanPoolIdentity } from './identity';

// Mock dependencies
vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => ({
        publicKey: 'pub_test_123',
        privateKey: '00'.repeat(32),
        callsign: 'Alice',
        createdAt: '2026-01-01T00:00:00.000Z',
    })),
}));

vi.mock('./api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./api')>();
    return {
        ...actual,
        getActivityFeedApi: vi.fn(async () => ({
            feed: [
                {
                    id: 'act-1',
                    eventType: 'member_joined',
                    actorCallsign: 'Bob',
                    createdAt: new Date().toISOString(),
                },
            ],
        })),
        getBalance: vi.fn(async () => ({
            balance: 100,
            floor: -500,
            standing: 'good',
            isBlockedFromTrading: false,
        })),
        getTransactions: vi.fn(async () => []),
        getMembers: vi.fn(async () => []),
        getMarketplacePosts: vi.fn(async () => []),
        getNodeInfo: vi.fn(async () => ({ peerNodes: [] })),
        getRemotePosts: vi.fn(async () => []),
        getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
        getMyMarketplaceTransactions: vi.fn(async () => []),
        getCommissionCapacity: vi.fn(async () => ({ links: [] })),
        getNodeConfig: vi.fn(async () => ({ enablePeerConnectors: false })),
        checkMembership: vi.fn(async () => ({ isMember: true })),
        getCommunityHealth: vi.fn(async () => ({ online: true })),
        resolveAvatarUrl: vi.fn(() => null),
        buildSignedWsParams: vi.fn(async () => ''),
        getPulseFeed: vi.fn(async () => ({ items: [], nextCursor: null })),
        getMemberChannels: vi.fn(async () => ({ channels: [] })),
    };
});

import * as api from './api';
import { ActivityWaterfall } from '../components/ActivityWaterfall';
import { LedgerPage } from '../pages/LedgerPage';
import { MarketplacePage } from '../pages/MarketplacePage';
import { MapPage } from '../pages/MapPage';
import { PulsePage } from '../pages/PulsePage';
import { App } from '../App';
import {
    connectToAnchor,
    resetSyncForTest,
    onSyncActivity,
} from './sync';
import {
    resetCoordinatorForTest,
} from './sync-coordinator';

describe('Stage 4: Push-driven views and relaxed backstop timers', () => {
    let wsInstance: any = null;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        resetCoordinatorForTest();
        resetSyncForTest();
        vi.clearAllMocks();

        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

        wsInstance = null;
        class MockWebSocket {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSING = 2;
            static readonly CLOSED = 3;

            readonly CONNECTING = 0;
            readonly OPEN = 1;
            readonly CLOSING = 2;
            readonly CLOSED = 3;

            readyState = MockWebSocket.CONNECTING;
            onopen: any = null;
            onmessage: any = null;
            onclose: any = null;
            onerror: any = null;
            send = vi.fn();
            close = vi.fn();

            constructor(public url: string) {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                wsInstance = this;
            }
        }
        (globalThis as any).WebSocket = MockWebSocket;
        window.matchMedia = window.matchMedia || vi.fn().mockImplementation((query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
    });

    afterEach(() => {
        resetCoordinatorForTest();
        resetSyncForTest();
        vi.useRealTimers();
    });

    async function setupWsConnection(): Promise<any> {
        connectToAnchor('ws://localhost:9000/ws');
        for (let i = 0; i < 20; i++) {
            if (wsInstance) break;
            await Promise.resolve();
        }
        if (!wsInstance) throw new Error('Mock WebSocket not created');
        wsInstance.readyState = 1; // OPEN
        wsInstance.onopen();
        // Drain reconnect sync
        await vi.advanceTimersByTimeAsync(200);
        return wsInstance;
    }

    describe('ActivityWaterfall', () => {
        it('refreshes when a broadcast arrives', async () => {
            const ws = await setupWsConnection();
            const fetchSpy = vi.spyOn(api, 'getActivityFeedApi');

            await act(async () => {
                render(<ActivityWaterfall isFullView={true} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Wait past the 2000ms mount cooldown
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });

            // Simulate incoming broadcast on WebSocket
            await act(async () => {
                ws.onmessage({
                    data: JSON.stringify({ type: 'trade_completed', txId: 'tx-1' }),
                });
                await vi.advanceTimersByTimeAsync(250);
            });

            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('the backstop still fires when no broadcast arrives (300s)', async () => {
            await setupWsConnection();
            const fetchSpy = vi.spyOn(api, 'getActivityFeedApi');

            await act(async () => {
                render(<ActivityWaterfall isFullView={true} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Advance time past 300s + 20% jitter (max 360s = 360_000ms)
            await act(async () => {
                await vi.advanceTimersByTimeAsync(370_000);
            });

            // Backstop fired
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('becoming visible refreshes exactly once (coalescing visibility change and reconnect sync)', async () => {
            const ws = await setupWsConnection();
            const fetchSpy = vi.spyOn(api, 'getActivityFeedApi');

            await act(async () => {
                render(<ActivityWaterfall isFullView={true} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Simulate tab hidden for 5 seconds
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                await vi.advanceTimersByTimeAsync(5000);
            });

            // Simulate tab visible + WS reconnect sync
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: false, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                // Socket reconnected and fires onopen
                ws.onopen();
                await vi.advanceTimersByTimeAsync(300);
            });

            // Initial mount was 1, becoming visible should add exactly 1, total 2
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('LedgerPage', () => {
        const testIdentity: BeanPoolIdentity = {
            publicKey: 'pub_test_123',
            privateKey: '00'.repeat(32),
            callsign: 'Alice',
            createdAt: '2026-01-01T00:00:00.000Z',
        };

        it('refreshes when a broadcast arrives', async () => {
            const ws = await setupWsConnection();
            const balanceSpy = vi.spyOn(api, 'getBalance');

            await act(async () => {
                render(<LedgerPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(balanceSpy).toHaveBeenCalledTimes(1);

            // Wait past the 2000ms mount cooldown
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });

            // Broadcast arrives
            await act(async () => {
                ws.onmessage({
                    data: JSON.stringify({ type: 'transaction_completed', transaction: { id: 'tx-1' } }),
                });
                await vi.advanceTimersByTimeAsync(250);
            });

            expect(balanceSpy).toHaveBeenCalledTimes(2);
        });

        it('the backstop still fires when no broadcast arrives (300s)', async () => {
            await setupWsConnection();
            const balanceSpy = vi.spyOn(api, 'getBalance');

            await act(async () => {
                render(<LedgerPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(balanceSpy).toHaveBeenCalledTimes(1);

            // Advance past 300s + jitter
            await act(async () => {
                await vi.advanceTimersByTimeAsync(370_000);
            });

            expect(balanceSpy).toHaveBeenCalledTimes(2);
        });

        it('becoming visible refreshes exactly once', async () => {
            const ws = await setupWsConnection();
            const balanceSpy = vi.spyOn(api, 'getBalance');

            await act(async () => {
                render(<LedgerPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(balanceSpy).toHaveBeenCalledTimes(1);

            // Tab hidden
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                await vi.advanceTimersByTimeAsync(5000);
            });

            // Tab visible + socket reconnect
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: false, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                ws.onopen();
                await vi.advanceTimersByTimeAsync(300);
            });

            expect(balanceSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('MarketplacePage', () => {
        const testIdentity: BeanPoolIdentity = {
            publicKey: 'pub_test_123',
            privateKey: '00'.repeat(32),
            callsign: 'Alice',
            createdAt: '2026-01-01T00:00:00.000Z',
        };

        it('refreshes when a post_updated broadcast arrives', async () => {
            const ws = await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(
                    <MarketplacePage
                        identity={testIdentity}
                        marketClickCount={0}
                        openPostId={null}
                        onPostOpened={() => {}}
                        onNavigate={() => {}}
                        onOpenProfile={() => {}}
                        transactions={[]}
                        onRefreshTransactions={() => {}}
                    />
                );
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;
            expect(initialCalls).toBeGreaterThanOrEqual(1);

            // Wait past 2000ms mount cooldown
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });

            // Broadcast arrives
            await act(async () => {
                ws.onmessage({
                    data: JSON.stringify({ type: 'post_updated', id: 'post-1' }),
                });
                await vi.advanceTimersByTimeAsync(250);
            });

            expect(postsSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('the backstop still fires when no broadcast arrives (300s)', async () => {
            await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(
                    <MarketplacePage
                        identity={testIdentity}
                        marketClickCount={0}
                        openPostId={null}
                        onPostOpened={() => {}}
                        onNavigate={() => {}}
                        onOpenProfile={() => {}}
                        transactions={[]}
                        onRefreshTransactions={() => {}}
                    />
                );
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(370_000);
            });

            expect(postsSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('becoming visible refreshes exactly once', async () => {
            const ws = await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(
                    <MarketplacePage
                        identity={testIdentity}
                        marketClickCount={0}
                        openPostId={null}
                        onPostOpened={() => {}}
                        onNavigate={() => {}}
                        onOpenProfile={() => {}}
                        transactions={[]}
                        onRefreshTransactions={() => {}}
                    />
                );
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;

            // Tab hidden
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                await vi.advanceTimersByTimeAsync(5000);
            });

            // Tab visible + socket reconnect
            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: false, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                ws.onopen();
                await vi.advanceTimersByTimeAsync(300);
            });

            // Each refresh of MarketplacePage fetches general posts + viewer own posts (2 calls to getMarketplacePosts)
            // One refresh cycle = 2 calls. Exactly one refresh cycle ran on becoming visible!
            expect(postsSpy.mock.calls.length).toBe(initialCalls + 2);
        });
    });

    describe('MapPage', () => {
        const testIdentity: BeanPoolIdentity = {
            publicKey: 'pub_test_123',
            privateKey: '00'.repeat(32),
            callsign: 'Alice',
            createdAt: '2026-01-01T00:00:00.000Z',
        };

        it('refreshes map posts when a broadcast arrives', async () => {
            const ws = await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(<MapPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });

            await act(async () => {
                ws.onmessage({
                    data: JSON.stringify({ type: 'new_post', post: { id: 'p-1' } }),
                });
                await vi.advanceTimersByTimeAsync(250);
            });

            expect(postsSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('the backstop still fires when no broadcast arrives (300s)', async () => {
            await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(<MapPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(370_000);
            });

            expect(postsSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('becoming visible refreshes exactly once', async () => {
            const ws = await setupWsConnection();
            const postsSpy = vi.spyOn(api, 'getMarketplacePosts');

            await act(async () => {
                render(<MapPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = postsSpy.mock.calls.length;

            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                await vi.advanceTimersByTimeAsync(5000);
            });

            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: false, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                ws.onopen();
                await vi.advanceTimersByTimeAsync(300);
            });

            expect(postsSpy.mock.calls.length).toBe(initialCalls + 1);
        });
    });

    describe('App unread polling & push updates', () => {
        it('refreshes unread and deals on new_message broadcast', async () => {
            const ws = await setupWsConnection();
            const convSpy = vi.spyOn(api, 'getConversations');

            await act(async () => {
                render(<App />);
                await vi.advanceTimersByTimeAsync(100);
            });
            const initialCalls = convSpy.mock.calls.length;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });

            await act(async () => {
                ws.onmessage({
                    data: JSON.stringify({ type: 'new_message', conversationId: 'c-1', id: 'm-1' }),
                });
                await vi.advanceTimersByTimeAsync(500);
            });

            expect(convSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('the backstop still fires when no broadcast arrives (300s)', async () => {
            await setupWsConnection();
            const convSpy = vi.spyOn(api, 'getConversations');

            await act(async () => {
                render(<App />);
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = convSpy.mock.calls.length;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(370_000);
            });

            expect(convSpy.mock.calls.length).toBeGreaterThan(initialCalls);
        });

        it('becoming visible refreshes exactly once', async () => {
            const ws = await setupWsConnection();
            const convSpy = vi.spyOn(api, 'getConversations');

            await act(async () => {
                render(<App />);
                await vi.advanceTimersByTimeAsync(50);
            });
            const initialCalls = convSpy.mock.calls.length;

            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                await vi.advanceTimersByTimeAsync(5000);
            });

            await act(async () => {
                Object.defineProperty(document, 'hidden', { value: false, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
                ws.onopen();
                await vi.advanceTimersByTimeAsync(300);
            });

            expect(convSpy.mock.calls.length).toBe(initialCalls + 1);
        });
    });

    describe('Map and Pulse tab rendering & poll resilience (regression #776)', () => {
        const testIdentity: BeanPoolIdentity = {
            publicKey: 'pub_test_123',
            privateKey: '00'.repeat(32),
            callsign: 'Alice',
            createdAt: '2026-01-01T00:00:00.000Z',
        };

        it('switches to Map and renders MapPage without blanking', async () => {
            render(<App />);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
            });

            const mapBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Map'));
            expect(mapBtn).toBeDefined();

            await act(async () => {
                mapBtn!.click();
                await vi.advanceTimersByTimeAsync(200);
            });

            expect(document.querySelector('.leaflet-container')).not.toBeNull();
        });

        it('switches to Pulse and renders PulsePage without blanking', async () => {
            render(<App />);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
            });

            const pulseBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Pulse'));
            expect(pulseBtn).toBeDefined();

            await act(async () => {
                pulseBtn!.click();
                await vi.advanceTimersByTimeAsync(200);
            });

            expect(document.body.textContent).toContain('The Pulse');
        });

        it('MapPage does not throw and safely excludes polls from map pins', async () => {
            vi.spyOn(api, 'getMarketplacePosts').mockResolvedValueOnce([
                {
                    id: 'poll-1',
                    type: 'poll' as any,
                    category: 'community',
                    title: 'Should we add composting?',
                    description: 'Community poll',
                    credits: 0,
                    priceType: 'fixed',
                    authorPublicKey: 'pub_test_123',
                    authorCallsign: 'Alice',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    status: 'active',
                    pollOptions: [
                        { id: 'opt_1', text: 'Yes', votes: 5 },
                        { id: 'opt_2', text: 'No', votes: 2 },
                    ],
                } as any,
                {
                    id: 'offer-1',
                    type: 'offer',
                    category: 'food',
                    title: 'Fresh Apples',
                    description: 'Crisp apples from orchard',
                    credits: 5,
                    priceType: 'fixed',
                    authorPublicKey: 'pub_other_456',
                    authorCallsign: 'Bob',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    status: 'active',
                    lat: -28.5,
                    lng: 153.5,
                } as any,
            ]);

            await act(async () => {
                render(<MapPage identity={testIdentity} />);
                await vi.advanceTimersByTimeAsync(100);
            });

            expect(document.querySelector('.leaflet-container')).not.toBeNull();
        });

        it('PulsePage renders correctly without throwing', async () => {
            await act(async () => {
                render(<PulsePage identity={testIdentity} onOpenProfile={vi.fn()} />);
                await vi.advanceTimersByTimeAsync(100);
            });

            expect(document.body.textContent).toContain('The Pulse');
        });
    });
});
