// @vitest-environment jsdom
/**
 * A member's copy of an Offer or a Need on the web (slice G1′): the card says where it is from and its price there, in words,
 * and names nobody. The tick is the phone's for now (slice G3): this is what the web shows of a copy.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import { VisitorCard, VisitorPostDetail, visitorCardName } from './VisitorListing';
import type { MarketplacePost } from '../lib/marketplace';

const LINE = "20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.";
const copy = {
    id: 'c1', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Fresh', credits: 0, authorPublicKey: 'hidden', authorCallsign: '', active: true, status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z', photos: [],
    shownCopy: true, shownPrice: '20 fixed',
    shownFrom: { host: 'mullum.example.org', postId: 'h1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' },
} as unknown as MarketplacePost;
const plain = { ...copy, authorPublicKey: 'abc', authorCallsign: 'Robin', shownCopy: undefined, shownFrom: undefined, shownPrice: undefined, credits: 5 } as unknown as MarketplacePost;

afterEach(cleanup);

describe('a copy of a listing on the web', () => {
    it.each(['grid', 'list'] as const)('its %s card has the line and no author', (viewMode) => {
        render(<MarketplaceCard post={copy} viewMode={viewMode} />);
        expect(screen.getByTestId('listing-copy-line').textContent).toBe(LINE);
        expect(document.body.textContent).not.toContain('Anonymous');
        expect(document.body.textContent).not.toContain('hidden');
    });

    it('a plain listing keeps its author (the control)', () => {
        render(<MarketplaceCard post={plain} viewMode="grid" />);
        expect(screen.queryByTestId('listing-copy-line')).toBeNull();
        expect(document.body.textContent).toContain('Robin');
    });

    it('a visitor\'s card has the line where "Free, a swap, or ask" would be, and a screen reader hears it', () => {
        render(<VisitorCard post={copy} beans={false} distanceKm={null} onOpen={() => undefined} />);
        expect(screen.getByTestId('visitor-card-terms').textContent).toBe(LINE);
        expect(visitorCardName(copy, false, null)).toContain(LINE);
    });

    it('the page: the door, the line, and no way to pay or message', () => {
        const onJoin = vi.fn();
        render(<VisitorPostDetail post={copy} beans={false} distanceKm={null} onJoin={onJoin} />);
        expect(screen.getByTestId('visitor-detail-from').textContent).toContain('from Mullumbimby');
        expect(screen.getByTestId('event-copy-door').textContent).toContain(LINE);
        expect(screen.getByTestId('event-copy-ask').getAttribute('href')).toBe('/?ask=mullum.example.org');
        expect(screen.queryByTestId('visitor-join')).toBeNull();
        expect(screen.queryByTestId('visitor-detail-terms')).toBeNull();
    });

    it('with no row of the directory: no name, no door', () => {
        const bare = { ...copy, shownFrom: undefined } as unknown as MarketplacePost;
        render(<VisitorPostDetail post={bare} beans={false} distanceKm={null} onJoin={() => undefined} />);
        expect(screen.getByTestId('event-copy-door').textContent).toContain("20 Beans in another community · You can't buy or take this here.");
        expect(screen.queryByTestId('event-copy-ask')).toBeNull();
    });
});
