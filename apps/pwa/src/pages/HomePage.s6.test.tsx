import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HomePage } from './HomePage';
import * as api from '../lib/api';
import type { HomeRead } from '../lib/api';
import type { HomeAnswer } from '../lib/home-cards';

vi.mock('../lib/api');

const ME = { publicKey: 'a'.repeat(64), callsign: 'Alice', name: 'Alice' } as any;

const fresh = (a: HomeAnswer): HomeRead => ({ notModified: false, answer: a, etag: 'W/"1"' });

const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };
const LAYOUT = { v: 2, cards: [{ id: 'market', type: 'market' }], dismissed: {}, updatedAt: null };

describe('Web Home Market card picture ladder (Pictures S6)', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('renders own photo, enterprise banner fallback, or CategoryTile', async () => {
        const cards: HomeAnswer['cards'] = {
            market: {
                items: [
                    { id: 'm1', type: 'offer', title: 'Own Photo Item', category: 'food', photoUrl: 'https://example.com/photo.jpg', bannerUrl: '/api/shops/s1/photo?v=1', distanceKm: null },
                    { id: 'm2', type: 'offer', title: 'Enterprise Banner Item', category: 'services', photoUrl: null, bannerUrl: '/api/shops/s2/photo?v=2', distanceKm: null },
                    { id: 'm3', type: 'offer', title: 'Category Tile Item', category: 'tools', photoUrl: null, bannerUrl: null, distanceKm: null },
                ],
                total14d: 3,
                more: false,
            },
        };
        const homeData: HomeAnswer = {
            generatedAt: new Date().toISOString(),
            profile: 'local',
            cards,
            features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false } as any,
            me: { standing: 'member', tour: TOUR_ENDED, joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false },
            layout: LAYOUT as any,
        };
        vi.mocked(api.getHome).mockResolvedValue(fresh(homeData));

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-card-market');

        const m1 = screen.getByRole('button', { name: /Own Photo Item/ });
        const m1Img = m1.querySelector('img');
        expect(m1Img?.getAttribute('src')).toContain('https://example.com/photo.jpg');

        const m2 = screen.getByRole('button', { name: /Enterprise Banner Item/ });
        const m2Img = m2.querySelector('img');
        expect(m2Img?.getAttribute('src')).toContain('/api/shops/s2/photo?v=2');

        const m3 = screen.getByRole('button', { name: /Category Tile Item/ });
        expect(m3.querySelector('img')).toBeNull();
        expect(m3.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();
    });
});
