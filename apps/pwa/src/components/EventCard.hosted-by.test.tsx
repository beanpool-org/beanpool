/**
 * The host on an event's page is the box a listing's "Posted by" is (Marty, 4 Nov 2026, on the phone's event page: "hosted by is so
 * small and in plain text - consider looking at the offer card and styling it like that one"; the web's must match the phone's):
 * a rounded card, "Hosted by" in small capitals, the host's face, their name with the handshake and their ratings, after the
 * description where the listing puts its box; clicking the face and name opens the host's profile. Both pages draw
 * components/AuthorCard.tsx, so the two cannot drift.
 *
 * jsdom does no layout, so the 320 px / 130% text contract is held the way EventCard.test.tsx holds it: by the classes. Light and
 * dark are the same classes' `dark:` pairs (the web's colour tokens are Tailwind's).
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetail } from './EventCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []), getMemberRatings: vi.fn() };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime();
const event: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall', description: 'Bring gloves and a shovel', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hazel', authorAvatarUrl: '/uploads/hazel.webp', createdAt: new Date().toISOString(), active: true, status: 'active',
    repeatable: false, lat: -28.55, lng: 153.5, eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const ratings = (answer: unknown) => vi.mocked(api.getMemberRatings).mockResolvedValue(answer as any);

beforeEach(() => { vi.mocked(api.getMemberRatings).mockReset(); ratings({ ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } }); });
afterEach(() => { document.documentElement.style.fontSize = ''; });

const hostButton = () => screen.getByTestId('event-host-open');
/** The box: the label above the button that opens the host, and what the box holds under it. */
const hostBox = () => hostButton().parentElement as HTMLElement;

describe("an event's page: the host is a box like a listing's \"Posted by\"", () => {
    it('"Hosted by", the face, the name with the handshake and the ratings, in one rounded card', async () => {
        render(<EventDetail post={event} identity={identity} />);
        const box = hostBox();
        expect(within(box).getByText('Hosted by')).toBeInTheDocument();
        const face = within(hostButton()).getByRole('img', { name: 'Hazel' }) as HTMLImageElement;
        expect(face.getAttribute('src')).toContain('/uploads/hazel.webp');
        expect(within(hostButton()).getByText('Hazel').textContent).toContain('Hazel');
        expect(hostButton().textContent).toContain('🤝');
        expect(hostButton().textContent).toContain('☆☆☆☆☆');
        expect(hostButton().textContent).toContain('No ratings yet');
        // Nothing is left of the small plain line.
        expect(screen.queryByText(/^Hosted by Hazel/)).toBeNull();
        await waitFor(() => expect(api.getMemberRatings).toHaveBeenCalledWith('host-pk'));
    });

    it('is the listing\'s card to the class: rounded, bordered, padded, the label in small capitals, light and dark pairs', () => {
        render(<EventDetail post={event} identity={identity} />);
        const box = hostBox();
        for (const c of ['bg-white', 'dark:bg-nature-950', 'rounded-2xl', 'border', 'border-nature-200', 'dark:border-nature-800', 'p-4', 'shadow-sm']) {
            expect(box.className.split(/\s+/), c).toContain(c);
        }
        const label = within(box).getByText('Hosted by');
        for (const c of ['uppercase', 'tracking-widest', 'font-bold', 'text-nature-400', 'dark:text-nature-400']) {
            expect(label.className.split(/\s+/), c).toContain(c);
        }
        const name = within(hostButton()).getByText('Hazel');
        expect(name.className.split(/\s+/)).toEqual(expect.arrayContaining(['font-bold', 'text-nature-950', 'dark:text-white']));
    });

    it('holds at 320 px with 130% text: the name truncates in a shrinking column, the button spans the card, the face is bigger than a 48 px target', () => {
        Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
        document.documentElement.style.fontSize = '130%';
        render(<div style={{ width: 320 }}><EventDetail post={{ ...event, authorCallsign: 'The Mullumbimby Community Gardens and Seed Library Collective' }} identity={identity} /></div>);
        const button = hostButton();
        expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'text-left']));
        const name = within(button).getByText(/Mullumbimby Community Gardens/);
        expect(name.className.split(/\s+/)).toContain('truncate');
        expect(name.parentElement!.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
        const face = within(button).getByRole('img') as HTMLImageElement;
        expect(Number(face.getAttribute('width'))).toBeGreaterThanOrEqual(48);
    });

    it('sits after the description, where the listing puts its box, and before the going counts', () => {
        render(<EventDetail post={event} identity={identity} />);
        const text = screen.getByTestId('event-detail').textContent!;
        expect(text.indexOf('Hosted by')).toBeGreaterThan(text.indexOf('Bring gloves and a shovel'));
        expect(text.indexOf('7 going')).toBeGreaterThan(text.indexOf('Hosted by'));
    });

    it("clicking the face and name opens the host's profile", async () => {
        const onOpenProfile = vi.fn();
        render(<EventDetail post={event} identity={identity} onOpenProfile={onOpenProfile} />);
        await userEvent.click(hostButton());
        expect(onOpenProfile).toHaveBeenCalledTimes(1);
        expect(onOpenProfile).toHaveBeenCalledWith('host-pk');
    });

    it("shows the host's ratings as the listing shows a poster's: stars, the average and how many, and the two roles", async () => {
        ratings({ ratings: [], average: 4.8, count: 6, asProvider: { average: 5, count: 3 }, asReceiver: { average: 4.5, count: 3 } });
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(hostButton().textContent).toContain('4.8 (6)'));
        expect(hostButton().textContent).toContain('★★★★★');
        expect(hostButton().textContent).toContain('📤 5.0');
        expect(hostButton().textContent).toContain('📥 4.5');
        expect(hostButton().textContent).not.toContain('No ratings yet');
    });

    it('a rating the node cannot give leaves "No ratings yet", never a broken page', async () => {
        vi.mocked(api.getMemberRatings).mockReset();
        vi.mocked(api.getMemberRatings).mockRejectedValue(new Error('offline'));
        render(<EventDetail post={event} identity={identity} />);
        await waitFor(() => expect(api.getMemberRatings).toHaveBeenCalled());
        expect(hostButton().textContent).toContain('No ratings yet');
    });

    it('an enterprise that hosts is the same box with its name, and clicking it hands its key to the profile page', async () => {
        const onOpenProfile = vi.fn();
        render(<EventDetail post={{ ...event, authorPublicKey: 'shop-pk', authorCallsign: 'Brunswick Seed Co-op', authorAvatarUrl: null }} identity={identity} onOpenProfile={onOpenProfile} />);
        expect(within(hostBox()).getByText('Hosted by')).toBeInTheDocument();
        expect(within(hostButton()).getByText('Brunswick Seed Co-op')).toBeInTheDocument();
        await userEvent.click(hostButton());
        expect(onOpenProfile).toHaveBeenCalledWith('shop-pk');
        await waitFor(() => expect(api.getMemberRatings).toHaveBeenCalledWith('shop-pk'));
    });

    it('a group-only event says who can see it, under the box', () => {
        render(<EventDetail post={{ ...event, audienceScope: 'group', targetGroupName: 'Garden Club' }} identity={identity} />);
        const line = screen.getByTestId('event-host-audience');
        expect(line.textContent).toBe('🔒 Only Garden Club can see this');
        expect(hostBox().compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('an event for everyone has no such line', () => {
        render(<EventDetail post={event} identity={identity} />);
        expect(screen.queryByTestId('event-host-audience')).toBeNull();
    });

    it("a member's copy of an event has no host to show: no box, and the node is never asked about a host", () => {
        const copy = { ...event, authorPublicKey: 'hidden', authorCallsign: '', shownCopy: true, shownFrom: { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' } };
        render(<EventDetail post={copy} identity={identity} />);
        expect(screen.queryByTestId('event-host-open')).toBeNull();
        expect(document.body.textContent).not.toContain('Hosted by');
        expect(screen.getByTestId('event-copy-from').textContent).toBe('from Mullumbimby');
        expect(api.getMemberRatings).not.toHaveBeenCalled();
    });
});

describe('one box for a listing and an event', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it('the listing\'s "Posted by" and the event\'s "Hosted by" both draw components/AuthorCard.tsx', () => {
        const listing = read('../pages/MarketplacePage.tsx');
        const events = read('./EventCard.tsx');
        expect(listing).toMatch(/import \{ AuthorCard \} from '\.\.\/components\/AuthorCard'/);
        expect(listing).toMatch(/<AuthorCard\s+label=\{t\('Posted by'\)\}/);
        expect(events).toMatch(/import \{ AuthorCard, useMemberRatings \} from '\.\/AuthorCard'/);
        expect(events).toMatch(/<AuthorCard\s+label=\{t\('Hosted by'\)\}/);
        // Neither page keeps a box of its own: the card's markup lives in the one component.
        expect(listing).not.toMatch(/tracking-widest mb-3/);
        expect(events).not.toMatch(/tracking-widest mb-3/);
    });
});
