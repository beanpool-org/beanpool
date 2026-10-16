import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

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

vi.mock('../components/EnterpriseDecisions', () => ({
    EnterpriseDecisions: () => <div data-testid="enterprise-decisions" />,
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'member-charlie-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Charlie',
    createdAt: '2026-01-01T00:00:00.000Z',
};

describe('TreasuryDetailPage in preview mode (Showcase)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(api, 'getTreasury').mockResolvedValue({} as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({} as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({} as any);
    });

    it('renders real enterprise page from sample without calling network', async () => {
        render(
            <TreasuryDetailPage
                identity={mockIdentity}
                isMember={true}
                pubkey="sample-enterprise-bakery"
                onBack={vi.fn()}
            />
        );

        // Header shows bakery name from sample
        await waitFor(() => {
            expect(screen.getAllByText('Example Valley Bakery').length).toBeGreaterThan(0);
        });

        // Did NOT call real API
        expect(api.getTreasury).not.toHaveBeenCalled();
        expect(api.getEnterpriseLedger).not.toHaveBeenCalled();

        // Shows Local Community strip and Example header
        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        expect(screen.getByTestId('sample-header')).toBeInTheDocument();

        // Shows keepers from sample
        expect(screen.getAllByText('a neighbour').length).toBeGreaterThanOrEqual(2);

        // Live offers from sample (Sourdough loaves, baked twice a week)
        expect(screen.getByText('Sourdough loaves, baked twice a week')).toBeInTheDocument();

        // Balance from sample
        expect(screen.getAllByText(/160/i).length).toBeGreaterThan(0);

        // Decisions component is NOT drawn on preview
        expect(screen.queryByTestId('enterprise-decisions')).not.toBeInTheDocument();

        // Report enterprise button is NOT drawn on preview
        expect(screen.queryByRole('button', { name: /Report/i })).not.toBeInTheDocument();
    });

    it('renders all enterprise controls as marker actions that open the local community sheet', async () => {
        render(
            <TreasuryDetailPage
                identity={mockIdentity}
                isMember={true}
                pubkey="sample-enterprise-bakery"
                preview={true}
                onBack={vi.fn()}
            />
        );

        await waitFor(() => {
            expect(screen.getAllByText('Example Valley Bakery').length).toBeGreaterThan(0);
        });

        // 1. Join as keeper
        const joinBtn = screen.getByRole('button', { name: /Join as keeper/i });
        expect(joinBtn).toBeInTheDocument();

        // 2. Pause for season
        const pauseBtn = screen.getByRole('button', { name: /Pause for season/i });
        expect(pauseBtn).toBeInTheDocument();

        // 3. Start wind-up
        const windupBtn = screen.getByRole('button', { name: /Start wind-up/i });
        expect(windupBtn).toBeInTheDocument();

        // 4. Post Offer
        const postOfferBtn = screen.getByRole('button', { name: /Post Offer/i });
        expect(postOfferBtn).toBeInTheDocument();

        // 5. Post Need
        const postNeedBtn = screen.getByRole('button', { name: /Post Need/i });
        expect(postNeedBtn).toBeInTheDocument();

        // 6. To Commons (sweep)
        const toCommonsBtn = screen.getByRole('button', { name: /To Commons/i });
        expect(toCommonsBtn).toBeInTheDocument();

        // Clicking any control opens the Local Community sheet modal
        fireEvent.click(joinBtn);
        expect(screen.getByTestId('local-community-sheet')).toBeInTheDocument();
        expect(screen.getByText('Why this lives in a local community')).toBeInTheDocument();
        expect(screen.getByText(/An enterprise is kept by people its community knows/i)).toBeInTheDocument();
    });

    it('renders sample crowdfund project and pledge marker control', async () => {
        render(
            <TreasuryDetailPage
                identity={mockIdentity}
                isMember={true}
                pubkey="sample-project-compost-bay"
                onBack={vi.fn()}
            />
        );

        await waitFor(() => {
            expect(screen.getAllByText('A compost bay by the community garden').length).toBeGreaterThan(0);
        });

        // Did NOT call real API
        expect(api.getTreasury).not.toHaveBeenCalled();

        // Pledge control is a marker action
        const pledgeBtn = screen.getByRole('button', { name: /Pledge/i });
        expect(pledgeBtn).toBeInTheDocument();

        fireEvent.click(pledgeBtn);
        expect(screen.getByTestId('local-community-sheet')).toBeInTheDocument();
    });
});
