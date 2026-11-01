// @vitest-environment jsdom
/**
 * A member's copy of an Offer or a Need on the web (slice G1′): the card says where it is from and its price there, in words,
 * and names nobody. The tick is the phone's for now (slice G3): this is what the web shows of a copy.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import { VisitorCard, VisitorPostDetail, visitorCardName } from './VisitorListing';

const LINE = "20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.";
const copy = {
    id: 'c1', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Fresh', credits: 0, authorPublicKey: 'hidden', authorCallsign: '', active: true, status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z', photos: [],
    shownCopy: true, shownPrice: '20 fixed',
    shownFrom: { host: 'mullum.example.org', postId: 'h1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' },
} as any;
const plain = { ...copy, authorPublicKey: 'abc', authorCallsign: 'Robin', shownCopy: undefined, shownFrom: undefined, shownPrice: undefined, credits: 5 };

afterEach(cleanup);

describe('a copy of a listing on the web', () => {
    it.each(['grid', 'list', 'compact'] as const)('its %s card has the line and no author', (viewMode) => {
        render(<MarketplaceCard post={copy} viewMode={viewMode} />);
        expect(screen.getByTestId('listing-copy-line').textContent).toBe(LINE);
        expect(document.body.textContent).not.toContain('Anonymous');
        expect(document.body.textContent).not.toContain('hidden');
        expect(document.body.textContent).not.toMatch(/\bby\b/);
    });

    it.each(['grid', 'list', 'compact'] as const)('where Beans are on, its %s card draws no 0 beside the line, and a plain listing keeps its price (the control)', (viewMode) => {
        const { unmount } = render(<MarketplaceCard post={copy} viewMode={viewMode} beansMarked={false} />);
        expect(screen.getByTestId('listing-copy-line').textContent).toBe(LINE);
        expect(document.querySelector('img[alt="B"]')).toBeNull();
        unmount();
        render(<MarketplaceCard post={plain} viewMode={viewMode} beansMarked={false} />);
        expect(document.querySelector('img[alt="B"]')).not.toBeNull();
    });

    it.each(['grid', 'list', 'compact'] as const)('a Need\'s %s card says it can\'t be answered, not bought', (viewMode) => {
        render(<MarketplaceCard post={{ ...copy, type: 'need' }} viewMode={viewMode} />);
        expect(screen.getByTestId('listing-copy-line').textContent).toBe("20 Beans in Mullumbimby · You can't answer this until Mullumbimby welcomes you.");
    });

    it('a Need on a visitor\'s card and page says the same, its screen-reader name too', () => {
        const need = { ...copy, type: 'need' };
        const line = "20 Beans in Mullumbimby · You can't answer this until Mullumbimby welcomes you.";
        render(<VisitorCard post={need} beans={false} distanceKm={null} onOpen={() => undefined} />);
        expect(screen.getByTestId('visitor-card-terms').textContent).toBe(line);
        expect(visitorCardName(need, false, null)).toContain(line);
        cleanup();
        render(<VisitorPostDetail post={need} beans={false} distanceKm={null} onJoin={() => undefined} />);
        expect(screen.getByTestId('event-copy-door').textContent).toContain(line);
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
        const bare = { ...copy, shownFrom: undefined };
        render(<VisitorPostDetail post={bare} beans={false} distanceKm={null} onJoin={() => undefined} />);
        expect(screen.getByTestId('event-copy-door').textContent).toContain("20 Beans in another community · You can't buy or take this here.");
        expect(screen.queryByTestId('event-copy-ask')).toBeNull();
    });
});
