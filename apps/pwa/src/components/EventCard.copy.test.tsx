/**
 * What the web app shows of a member's copy of an event on the global community (slice G2′; the web's own tick is G3). A
 * member and a visitor read the same thing: when, the words, where it is from and the door. No host, no Going, no chat,
 * no count of nobody. Without a row of the directory: no line and no door, and the page says so. An ordinary event is
 * as it was.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EventCard, EventDetail } from './EventCard';
import { VisitorPostDetail } from './VisitorListing';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []) };
});

const start = new Date(2030, 8, 28, 9, 0).getTime();
const event: any = {
    id: 'copy-1', type: 'event', category: 'community', title: 'Street party', description: 'Bring a plate', credits: 0, priceType: 'fixed',
    authorPublicKey: 'hidden', authorCallsign: '', createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false,
    lat: -28.7, lng: 153.5, eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 7_200_000).toISOString(), eventState: 'scheduled',
    goingCount: 0, interestedCount: 0,
};
const from = { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };
const copy = { ...event, shownCopy: true, shownFrom: from };
const member: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

describe('a copy on a card', () => {
    it('says where it is from and the door, and offers no Going', () => {
        render(<EventCard post={copy} identity={member} />);
        expect(screen.getByTestId('event-copy-line').textContent).toBe('from Mullumbimby · Ask to join');
        expect(screen.queryByTestId('event-rsvp-row')).toBeNull();
        expect(document.body.textContent).not.toMatch(/0 going/);
    });

    it('a plain event keeps its Going', () => {
        render(<EventCard post={event} identity={member} />);
        expect(screen.getByTestId('event-rsvp-row')).toBeTruthy();
        expect(screen.queryByTestId('event-copy-line')).toBeNull();
    });
});

describe('a copy on its page', () => {
    it('a member reads the door in the place of Going, with no host, chat or note line', () => {
        render(<EventDetail post={copy} identity={member} onOpenChat={() => {}} onOpenProfile={() => {}} />);
        expect(screen.getByTestId('event-copy-door').textContent).toContain('To go, ask to join Mullumbimby');
        expect(screen.getByTestId('event-copy-from').textContent).toBe('from Mullumbimby');
        const ask = screen.getByTestId('event-copy-ask') as HTMLAnchorElement;
        expect(ask.textContent).toBe('Ask to join Mullumbimby');
        expect(ask.getAttribute('href')).toBe('/?ask=mullum.example.org');
        expect(ask.className).toContain('min-h-[48px]');
        expect(screen.queryByTestId('event-rsvp-row')).toBeNull();
        expect(screen.queryByTestId('event-open-chat')).toBeNull();
        expect(screen.queryByTestId('rough-place-line')).toBeNull();
        expect(document.body.textContent).not.toMatch(/Hosted by|hidden|tap Going/);
    });

    it('by invite: the words, and no button that goes nowhere', () => {
        render(<EventDetail post={{ ...copy, shownFrom: { ...from, door: 'invite' } }} identity={member} />);
        expect(screen.getByTestId('event-copy-door').textContent).toContain('It takes new members by invite');
        expect(screen.queryByTestId('event-copy-ask')).toBeNull();
    });

    it('with no row of the directory: no line, no door, and no Going', () => {
        render(<EventDetail post={{ ...event, shownCopy: true }} identity={member} />);
        expect(screen.queryByTestId('event-copy-from')).toBeNull();
        expect(screen.queryByTestId('event-copy-ask')).toBeNull();
        expect(screen.getByTestId('event-copy-door').textContent).toContain('run by another community');
        expect(screen.queryByTestId('event-rsvp-row')).toBeNull();
    });
});

describe('a copy on the visitor\'s sheet', () => {
    it('the door, not "Join to see who\'s hosting", and no promise of a place after joining', () => {
        render(<VisitorPostDetail post={copy} beans={false} distanceKm={null} onJoin={() => {}} />);
        expect(screen.getByTestId('event-copy-ask').getAttribute('href')).toBe('/?ask=mullum.example.org');
        expect(screen.queryByTestId('visitor-join')).toBeNull();
        expect(screen.getByTestId('visitor-detail-place').textContent).toBe('from Mullumbimby');
        expect(document.body.textContent).not.toMatch(/Place shown after you join|who's hosting/);
    });

    it('an ordinary event keeps its Join', () => {
        render(<VisitorPostDetail post={event} beans={false} distanceKm={null} onJoin={() => {}} />);
        expect(screen.getByTestId('visitor-join')).toBeTruthy();
        expect(screen.queryByTestId('event-copy-door')).toBeNull();
    });
});
