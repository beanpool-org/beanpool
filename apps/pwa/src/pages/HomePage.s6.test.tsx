import { fireEvent, render, screen } from '@testing-library/react';
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
                    { id: 'm1', type: 'offer', title: 'Own Photo Item', category: 'food', photoUrl: '/api/marketplace/posts/m1/photos/0?v=1&k=K1', bannerUrl: '/api/shops/s1/photo?v=1', distanceKm: null },
                    { id: 'm2', type: 'offer', title: 'Enterprise Banner Item', category: 'services', photoUrl: null, bannerUrl: '/api/shops/s2/photo?v=2', distanceKm: null },
                    { id: 'm3', type: 'offer', title: 'Category Tile Item', category: 'tools', photoUrl: null, bannerUrl: null, distanceKm: null },
                    { id: 'm4', type: 'offer', title: 'Elsewhere Photo Item', category: 'food', photoUrl: 'https://example.com/photo.jpg', bannerUrl: null, distanceKm: null },
                ],
                total14d: 4,
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
        expect(m1Img?.getAttribute('src')).toBe('/api/marketplace/posts/m1/photos/0?v=1&k=K1&size=thumb2');

        const m2 = screen.getByRole('button', { name: /Enterprise Banner Item/ });
        const m2Img = m2.querySelector('img');
        expect(m2Img?.getAttribute('src')).toContain('/api/shops/s2/photo?v=2');

        const m3 = screen.getByRole('button', { name: /Category Tile Item/ });
        expect(m3.querySelector('img')).toBeNull();
        expect(m3.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();

        // A banner has no small copy, so one that will not load gives way to the tile, never an empty box (review of #2565,
        // finding 8). A listing's own photo steps down: its small copy, once more past every cache (card-photo-blank), then the
        // photo's own URL, then the tile (card-photo-retry); the tile holds the slot while each step loads (card-photo-blank).
        fireEvent.error(m2Img!);
        const m2After = screen.getByRole('button', { name: /Enterprise Banner Item/ });
        expect(m2After.querySelector('img')).toBeNull();
        expect(m2After.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();
        fireEvent.error(m1Img!);
        const m1Again = screen.getByRole('button', { name: /Own Photo Item/ });
        expect(m1Again.querySelector('img')?.getAttribute('src')).toBe('/api/marketplace/posts/m1/photos/0?v=1&k=K1&size=thumb2&retry=1');
        fireEvent.error(m1Again.querySelector('img')!);
        const m1After = screen.getByRole('button', { name: /Own Photo Item/ });
        expect(m1After.querySelector('img')?.getAttribute('src')).toBe('/api/marketplace/posts/m1/photos/0?v=1&k=K1');
        expect(m1After.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();
        fireEvent.error(m1After.querySelector('img')!);
        const m1Last = screen.getByRole('button', { name: /Own Photo Item/ });
        expect(m1Last.querySelector('img')).toBeNull();
        expect(m1Last.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();

        // A photo on another address has no small copy to step down from: the tile on its first failure, never a broken image.
        const m4 = screen.getByRole('button', { name: /Elsewhere Photo Item/ });
        expect(m4.querySelector('img')?.getAttribute('src')).toContain('https://example.com/photo.jpg');
        fireEvent.error(m4.querySelector('img')!);
        const m4After = screen.getByRole('button', { name: /Elsewhere Photo Item/ });
        expect(m4After.querySelector('img')).toBeNull();
        expect(m4After.querySelector('[data-testid="category-tile"]')).toBeInTheDocument();
    });
});
