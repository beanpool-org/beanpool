import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import { MarketplacePage } from './MarketplacePage';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// Mock dependencies
vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));

vi.mock('../lib/peer-prefs', () => ({
    loadEnabledPeers: vi.fn(() => new Set()),
    togglePeer: vi.fn(),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: () => null,
}));

vi.mock('../components/DecideSection', () => ({
    DecideSection: () => null,
}));

vi.mock('../components/ProposeDecisionModal', () => ({
    ProposeDecisionModal: () => null,
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'keeper-alice-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Enterprise Season & Lifecycle (PWA)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('TreasuryDetailPage', () => {
        it('renders paused state banner with plain words, held credit amount, and date', async () => {
            const mockTreasury = {
                publicKey: 'enterprise-garden-pubkey',
                name: 'Garden Crew',
                purpose: 'Community food production',
                avatar: null,
                balance: 150,
                creditLine: 200,
                usableFloor: 200,
                pausedFloorSnapshot: 200,
                paused: true,
                pausedAt: '2026-09-15T00:00:00.000Z',
                pauseExpiresAt: '2026-12-14T00:00:00.000Z',
                pauseDaysRemaining: 90,
                status: 'active',
                liveOffers: 2,
                earnedSurplus: 50,
                keepers: [{ publicKey: 'keeper-alice-pubkey', callsign: 'Alice' }],
                posts: [
                    { id: 'post-1', type: 'offer', title: 'Fresh Kale', credits: 5, category: 'food' },
                ],
                flow: [],
            };

            vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
            vi.spyOn(api, 'getBalance').mockResolvedValue({
                balance: 50,
                keeperOf: ['enterprise-garden-pubkey'],
            } as any);
            vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
                enterprise: {
                    publicKey: 'enterprise-garden-pubkey',
                    name: 'Garden Crew',
                    purpose: null,
                    status: 'active',
                    paused: true,
                    balance: 150,
                },
                period: { since: null, until: null },
                summary: {
                    totalIncome: 120,
                    totalSpend: 40,
                    netChange: 80,
                    startingBalance: 70,
                    endingBalance: 150,
                    transactionCount: 2,
                },
                entries: [
                    {
                        id: 'tx-1',
                        timestamp: '2026-09-10T10:00:00.000Z',
                        direction: 'income',
                        amount: 120,
                        fee: 1.8,
                        netAmount: 118.2,
                        counterparty: 'member-bob',
                        counterpartyName: 'Bob',
                        memo: 'Veggie box delivery',
                        runningBalance: 150,
                        authSigner: null,
                    },
                ],
            });

            render(
                <TreasuryDetailPage
                    identity={mockIdentity}
                    pubkey="enterprise-garden-pubkey"
                    onBack={vi.fn()}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/Paused for the season\. Credit held at 200 beans until 14 December\./i)).toBeInTheDocument();
            });

            // Plain words explanation of non-buyability
            expect(screen.getByText(/Listings are paused and cannot be bought right now\./i)).toBeInTheDocument();

            // Listing badge shows Paused
            expect(screen.getByText(/⏸️ Paused/i)).toBeInTheDocument();

            // P&L Accountability Panel plain words check
            expect(screen.getByText(/Income & Spend \(P&L\)/i)).toBeInTheDocument();
            expect(screen.getAllByText(/Came in/i).length).toBeGreaterThanOrEqual(1);
            expect(screen.getAllByText(/Went out/i).length).toBeGreaterThanOrEqual(1);
            expect(screen.getByText(/Net change/i)).toBeInTheDocument();
            expect(screen.getAllByText(/\+120\.00 🫘/i).length).toBeGreaterThanOrEqual(1);
            expect(screen.getByText(/-40\.00 🫘/i)).toBeInTheDocument();
            expect(screen.getByText(/Veggie box delivery/i)).toBeInTheDocument();
            expect(screen.getByText(/Bob/i)).toBeInTheDocument();
        });

        it('shows winding up banner with remaining days and initiator name', async () => {
            const mockTreasury = {
                publicKey: 'enterprise-garden-pubkey',
                name: 'Garden Crew',
                purpose: 'Community food production',
                avatar: null,
                balance: 41.50,
                status: 'winding_up',
                windUpInitiatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                windUpInitiatedBy: 'keeper-alice-pubkey',
                windUpGraceEndsAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
                keepers: [{ publicKey: 'keeper-alice-pubkey', callsign: 'Alice' }],
                posts: [],
                flow: [],
            };

            vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
            vi.spyOn(api, 'getBalance').mockResolvedValue({
                balance: 50,
                keeperOf: ['enterprise-garden-pubkey'],
            } as any);
            vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
                enterprise: { publicKey: 'enterprise-garden-pubkey', name: 'Garden Crew', purpose: null, status: 'winding_up', paused: false, balance: 41.5 },
                period: { since: null, until: null },
                summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 41.5, endingBalance: 41.5, transactionCount: 0 },
                entries: [],
            });

            render(
                <TreasuryDetailPage
                    identity={mockIdentity}
                    pubkey="enterprise-garden-pubkey"
                    onBack={vi.fn()}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/Winding up \(6 days left · started by Alice\)/i)).toBeInTheDocument();
            });
            expect(screen.getByText(/Listings are inactive and cannot be bought\./i)).toBeInTheDocument();
        });

        it('displays plain words explanation before tapping destructive wind-up button', async () => {
            const mockTreasury = {
                publicKey: 'enterprise-garden-pubkey',
                name: 'Garden Crew',
                purpose: 'Community food production',
                avatar: null,
                balance: 41.50,
                status: 'active',
                keepers: [
                    { publicKey: 'keeper-alice-pubkey', callsign: 'Alice' },
                    { publicKey: 'keeper-bob-pubkey', callsign: 'Bob' },
                    { publicKey: 'keeper-carol-pubkey', callsign: 'Carol' },
                ],
                posts: [],
                flow: [],
            };

            vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
            vi.spyOn(api, 'getBalance').mockResolvedValue({
                balance: 50,
                keeperOf: ['enterprise-garden-pubkey'],
            } as any);
            vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
                enterprise: { publicKey: 'enterprise-garden-pubkey', name: 'Garden Crew', purpose: null, status: 'active', paused: false, balance: 41.5 },
                period: { since: null, until: null },
                summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 41.5, endingBalance: 41.5, transactionCount: 0 },
                entries: [],
            });

            render(
                <TreasuryDetailPage
                    identity={mockIdentity}
                    pubkey="enterprise-garden-pubkey"
                    onBack={vi.fn()}
                />
            );

            await waitFor(() => {
                expect(screen.getByText(/Start Wind-Up/i)).toBeInTheDocument();
            });

            // Tap Start Wind-Up to open confirmation card
            fireEvent.click(screen.getByText(/Start Wind-Up/i));

            // Verify the EXACT plain words explanation before tap
            expect(screen.getByText(/Winding up returns 41\.50 beans to the Commons, releases 3 keepers, and closes Garden Crew for good\. Any keeper can stop this for the next 7 days\./i)).toBeInTheDocument();
        });
    });

    describe('Marketplace Non-Buyability', () => {
        it('filters paused enterprise listings out of marketplace browse feed and search', async () => {
            const mockPosts = [
                {
                    id: 'post-regular',
                    title: 'Bicycle Repair',
                    description: 'Fix gears and flat tires',
                    type: 'offer',
                    category: 'services',
                    credits: 20,
                    status: 'active',
                    authorPublicKey: 'member-david',
                    authorCallsign: 'David',
                    createdAt: '2026-09-15T00:00:00Z',
                },
                {
                    id: 'post-paused-enterprise',
                    title: 'Dozens of Eggs',
                    description: 'Pasture raised chicken eggs',
                    type: 'offer',
                    category: 'food',
                    credits: 6,
                    status: 'active',
                    authorPublicKey: 'enterprise-farm-pubkey',
                    authorCallsign: 'Community Farm',
                    createdAt: '2026-09-15T00:00:00Z',
                },
            ];

            const mockTreasuries: api.Treasury[] = [
                {
                    publicKey: 'enterprise-farm-pubkey',
                    name: 'Community Farm',
                    paused: true,
                    status: 'active',
                    balance: 100,
                    creditLine: 200,
                    liveOffers: 2,
                },
            ];

            vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(mockPosts as any);
            vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: mockTreasuries });
            vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, isBlockedFromTrading: false } as any);
            vi.spyOn(api, 'getMembers').mockResolvedValue([]);
            vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);

            render(<MarketplacePage identity={mockIdentity} />);

            await waitFor(() => {
                expect(screen.getByText('Bicycle Repair')).toBeInTheDocument();
            });

            // The paused enterprise's post must NOT be present in the feed
            expect(screen.queryByText('Dozens of Eggs')).not.toBeInTheDocument();
        });

        it('disables buying and displays warning when viewing a cached or deep-linked post of a paused enterprise', async () => {
            const mockPost: api.MarketplacePost = {
                id: 'post-deep-link',
                title: 'Dozens of Eggs',
                description: 'Pasture raised chicken eggs',
                type: 'offer',
                category: 'food',
                credits: 6,
                priceType: 'fixed',
                status: 'active',
                active: true,
                repeatable: false,
                authorPublicKey: 'enterprise-farm-pubkey',
                authorCallsign: 'Community Farm',
                createdAt: '2026-09-15T00:00:00Z',
            };

            const mockTreasury: api.Treasury = {
                publicKey: 'enterprise-farm-pubkey',
                name: 'Community Farm',
                paused: true,
                status: 'active',
                balance: 100,
                creditLine: 200,
                liveOffers: 2,
            };

            vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([mockPost]);
            vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [mockTreasury] });
            vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
            vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, isBlockedFromTrading: false } as any);
            vi.spyOn(api, 'getMemberProfile').mockResolvedValue({} as any);
            vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ average: 5, count: 10 } as any);
            vi.spyOn(api, 'getMembers').mockResolvedValue([]);
            vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);

            render(<MarketplacePage identity={mockIdentity} openPostId="post-deep-link" />);

            await waitFor(() => {
                expect(screen.getAllByText(/Enterprise Paused for Season/i).length).toBeGreaterThanOrEqual(1);
            });

            expect(screen.getByRole('alert')).toHaveTextContent(/This listing belongs to Community Farm, which is currently paused for the season\. Listings cannot be bought right now\./i);

            // The buy button should be disabled with paused label
            const pausedBtn = screen.getByRole('button', { name: /⏸️ Enterprise Paused for Season/i });
            expect(pausedBtn).toBeDisabled();
        });
    });

    describe('ProjectsPage', () => {
        it('displays status badges on enterprise cards for paused or winding-up enterprises', async () => {
            const mockTreasuries: api.Treasury[] = [
                {
                    publicKey: 'enterprise-farm-pubkey',
                    name: 'Community Farm',
                    paused: true,
                    status: 'active',
                    balance: 100,
                    creditLine: 200,
                    liveOffers: 2,
                },
                {
                    publicKey: 'enterprise-shed-pubkey',
                    name: 'Tool Shed',
                    paused: false,
                    status: 'winding_up',
                    balance: 50,
                    creditLine: 100,
                    liveOffers: 0,
                },
                {
                    publicKey: 'enterprise-bakery-pubkey',
                    name: 'Commons Bakery',
                    paused: false,
                    status: 'completed',
                    balance: 0,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];

            vi.spyOn(api, 'getAllMembers').mockResolvedValue([]);
            vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: mockTreasuries });
            vi.spyOn(api, 'getDecisions').mockResolvedValue({ decisions: [], activeMembers30d: 5 } as any);
            vi.spyOn(api, 'getCommonsBalance').mockResolvedValue({ balance: 1000 } as any);
            vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, earnedCredit: 50 } as any);

            render(<ProjectsPage identity={mockIdentity} />);

            // Switch to Enterprises section
            const enterprisesTab = screen.getByRole('button', { name: /🏛️\s*Enterprises/i });
            fireEvent.click(enterprisesTab);

            await waitFor(() => {
                expect(screen.getByText('Community Farm')).toBeInTheDocument();
            });

            expect(screen.getByText('⏸️ Paused')).toBeInTheDocument();
            expect(screen.getByText('⏳ Winding up')).toBeInTheDocument();
            expect(screen.getByText('Closed')).toBeInTheDocument();
        });
    });
});
