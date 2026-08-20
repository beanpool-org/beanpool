import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const samplePost: MarketplacePost = {
    id: 'post-1',
    type: 'offer',
    category: 'food',
    title: 'Fresh Organic Apples',
    description: 'Crisp and sweet organic apples harvested this morning.',
    credits: 15,
    priceType: 'fixed',
    authorCallsign: 'FarmerAlice',
    authorPublicKey: 'pubkey-123',
    location: { lat: 0, lng: 0 },
    createdAt: new Date().toISOString(),
};

describe('MarketplaceCard', () => {
    it('renders basic offer post details in grid view by default', () => {
        render(<MarketplaceCard post={samplePost} />);

        expect(screen.getByText('Fresh Organic Apples')).toBeInTheDocument();
        expect(screen.getByText('FarmerAlice')).toBeInTheDocument();
        expect(screen.getByText('Crisp and sweet organic apples harvested this morning.')).toBeInTheDocument();
        expect(screen.getByText('15')).toBeInTheDocument();
        expect(screen.getByText('VIEW')).toBeInTheDocument();
    });

    it('renders compact view correctly', () => {
        render(<MarketplaceCard post={samplePost} viewMode="compact" />);

        expect(screen.getByText('Fresh Organic Apples')).toBeInTheDocument();
        expect(screen.getByText(/by FarmerAlice/)).toBeInTheDocument();
        expect(screen.getByText('offer')).toBeInTheDocument();
    });

    it('renders list view correctly', () => {
        render(<MarketplaceCard post={samplePost} viewMode="list" />);

        expect(screen.getByText('Fresh Organic Apples')).toBeInTheDocument();
        expect(screen.getByText('Food & Produce')).toBeInTheDocument();
        expect(screen.getByText('offer')).toBeInTheDocument();
    });

    it('renders Daily Pulse treatment when author callsign is Daily Pulse', () => {
        const pulsePost: MarketplacePost = {
            ...samplePost,
            authorCallsign: 'Daily Pulse',
            title: 'Community News Roundup',
        };

        render(<MarketplaceCard post={pulsePost} viewMode="grid" />);

        expect(screen.getByText('🗞️ Daily Pulse')).toBeInTheDocument();
    });

    it('renders overlays for badges (paused, you, remote node, cash, founding, repeatable)', () => {
        const customPost: MarketplacePost = {
            ...samplePost,
            status: 'paused',
            repeatable: true,
            cashAlsoNeeded: true,
            authorFoundingNeeded: true,
        };

        render(
            <MarketplaceCard
                post={customPost}
                viewMode="list"
                isOwnPost={true}
                remoteNode="https://node2.beanpool.org"
            />
        );

        expect(screen.getByText('⏸ Paused')).toBeInTheDocument();
        expect(screen.getByText('👤 You')).toBeInTheDocument();
        expect(screen.getByText('🌐 node2')).toBeInTheDocument();
        expect(screen.getByText('↻ RECURRING')).toBeInTheDocument();
        expect(screen.getByText('💸 CASH TOO')).toBeInTheDocument();
        expect(screen.getByText('🌱 FOUNDING TRADE')).toBeInTheDocument();
    });

    it('calls onOpenProfile when clicking author chip', () => {
        const onOpenProfile = vi.fn();
        render(<MarketplaceCard post={samplePost} onOpenProfile={onOpenProfile} />);

        const profileChip = screen.getByLabelText("View FarmerAlice's profile");
        fireEvent.click(profileChip);

        expect(onOpenProfile).toHaveBeenCalledWith('pubkey-123');
    });
});
