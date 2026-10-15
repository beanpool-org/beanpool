// A visitor's sheet for an online event (review of #1952, finding 7): the node sends visitors `eventOnline` (GUEST_FIELDS),
// and the card already says "🌐 Online"; the sheet said "Place shown after you join" of an event with no place.
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VisitorPostDetail } from './VisitorListing';

const event: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Vibe coding', description: '', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Host', createdAt: '2026-10-01T00:00:00.000Z', active: true, status: 'active',
    repeatable: false, eventStartAt: '2030-11-27T09:50:00.000Z', eventEndAt: '2030-11-27T11:50:00.000Z', eventState: 'scheduled',
};

describe('VisitorPostDetail: where an event is', () => {
    it('an online event says Online, not that its place is held back', () => {
        render(<VisitorPostDetail post={{ ...event, eventOnline: true }} beans={false} distanceKm={null} onBack={vi.fn()} onJoin={vi.fn()} />);
        expect(screen.getByTestId('visitor-detail-place').textContent).toBe('🌐 Online');
        expect(screen.queryByText(/Place shown after you join/)).not.toBeInTheDocument();
    });

    it('an in-person event keeps its place held back until joining', () => {
        render(<VisitorPostDetail post={{ ...event, lat: -28.55, lng: 153.5 }} beans={false} distanceKm={null} onBack={vi.fn()} onJoin={vi.fn()} />);
        expect(screen.getByTestId('visitor-detail-place').textContent).toBe('📍 Place shown after you join');
    });
});
