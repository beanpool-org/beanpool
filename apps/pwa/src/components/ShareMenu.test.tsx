// @vitest-environment jsdom
/**
 * ONE Share button and its menu on the web (DESIGN-detail-pages-fable.md §2.5, slice DW2), on a listing and on an event: the
 * page shows a single button; the ways this member has here are the items of the menu it opens, each with the sentence that
 * says what it does, read before the tap that shares; nothing is made until an item is tapped; and the keyboard rules the
 * calendar menu always had (the first item takes focus, the arrow keys walk, Escape and Tab close, a tap outside closes).
 * Every sentence core's shareSays can return, for every row of its table, must be reachable in the menu.
 */
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareSays, t } from '@beanpool/core';
import { SharePostButtons } from './SharePost';
import { EventShareAndCalendar } from './EventExtras';
import type { MarketplacePost } from '../lib/api';
import * as features from '../lib/features';
import * as api from '../lib/api';

vi.mock('../lib/features', async () => {
    const actual = await vi.importActual('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual, myNodeRoleOnce: vi.fn(), request: vi.fn(), getBalance: vi.fn(),
        getNodeApiUrl: () => 'https://mullum.beanpool.org',
    };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, loadIdentity: vi.fn(async () => ({ publicKey: 'pk-me', privateKey: 'sk', callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' })) };
});

const listing: MarketplacePost = {
    id: 'post-123', title: 'Ladder for borrowing', type: 'offer', category: 'tools', description: 'A 6m ladder',
    credits: 0, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob', createdAt: new Date().toISOString(),
    status: 'active', active: true, audienceScope: 'public', repeatable: false,
};
const event = {
    ...listing, id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall', eventState: 'scheduled',
    eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventEndAt: new Date(Date.now() + 90_000_000).toISOString(),
    eventPlaceName: 'Hall',
} as unknown as MarketplacePost;

const community = (f: Record<string, unknown> | null) => vi.mocked(features.useCommunityInfo).mockReturnValue(f && { profile: 'local', features: f } as any);
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const trigger = () => screen.getByTestId('share-button');
const openShare = () => fireEvent.click(trigger());
const menu = () => screen.getByRole('menu', { name: 'Share' });
const itemTexts = () => within(menu()).getAllByRole('menuitem').map(i => i.textContent);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.request).mockResolvedValue({ role: null });
    vi.mocked(api.getBalance).mockResolvedValue({ canVouch: false } as any);
    vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
});
afterEach(() => { cleanup(); delete (navigator as any).share; });

describe('one Share button', () => {
    it('is all the page shows before the tap: none of the ways, and none of their sentences', async () => {
        community({ shareOutside: true, door: 'members', knocks: true });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        await settle();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(trigger()).toHaveTextContent('🔗 Share');
        expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('menu')).toBeNull();
        for (const id of ['share-members-button', 'share-outside-button', 'invite-and-share-button', 'share-ask-admin-button', 'share-members-note', 'share-outside-line', 'invite-and-share-line']) {
            expect(screen.queryByTestId(id)).toBeNull();
        }
        expect(document.body.textContent).not.toContain('This link opens for members only.');
        expect(document.body.textContent).not.toContain('Anyone with the link can read');
    });

    it('opens a menu of the ways, each with its sentence under its name, in the order members, outside, invite', async () => {
        community({ shareOutside: true, door: 'members', knocks: true });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        await screen.findByTestId('invite-and-share-button');
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(itemTexts()).toEqual([
            'Share with membersThis link opens for members only.',
            'Share outside the communityAnyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.',
            'Invite and shareOne invite, for one person: a code works once.',
        ]);
        // Each sentence is inside its own item: it is read before the tap that does it.
        expect(screen.getByTestId('share-members-button')).toContainElement(screen.getByTestId('share-members-note'));
        expect(screen.getByTestId('share-outside-button')).toContainElement(screen.getByTestId('share-outside-line'));
        expect(screen.getByTestId('invite-and-share-button')).toContainElement(screen.getByTestId('invite-and-share-line'));
    });

    it('draws no blue outline (the old bp-ink-info share buttons), no violet one, on a listing', async () => {
        community({ shareOutside: true, door: 'members', knocks: true });
        const { container } = render(<SharePostButtons post={listing} isMember />);
        openShare();
        await screen.findByTestId('invite-and-share-button');
        expect(container.innerHTML).not.toMatch(/bp-ink-info|violet-/);
        // The button is the neutral outline of the quiet row.
        expect(trigger().className).toMatch(/border-nature-300/);
    });

    it('draws no blue outline in the event page\'s menu either (the row\'s own violet is the event page slice\'s, DW1)', async () => {
        community({ shareOutside: true, door: 'members', knocks: true });
        render(<EventShareAndCalendar post={event} />);
        fireEvent.click(screen.getByTestId('event-share'));
        await screen.findByTestId('invite-and-share-button');
        expect(menu().outerHTML).not.toMatch(/bp-ink-info|violet-/);
        expect(screen.getByTestId('event-share').outerHTML).not.toMatch(/bp-ink-info/);
    });

    it('is a menu of one where the community says nothing: the same door everywhere, no sentence', async () => {
        community(null);
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        await settle();
        expect(itemTexts()).toEqual(['Share with members']);
        community({ door: 'open', openJoin: true, invites: false, shareOutside: false });
        cleanup();
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        await settle();
        expect(itemTexts()).toEqual(['Share with members']);
    });

    it('makes nothing when it is opened: no link, no invite, nothing handed to the share sheet or the clipboard', async () => {
        const share = vi.fn(async () => {});
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        community({ shareOutside: true, door: 'members', knocks: true });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        await screen.findByTestId('invite-and-share-button');
        await settle();
        expect(share).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
        expect(vi.mocked(api.request).mock.calls.filter(([method]) => method === 'POST')).toEqual([]);
    });
});

describe('what a choice does', () => {
    it('Share with members hands over the title and the community link, closes the menu, and says "Link copied." under the row', async () => {
        delete (navigator as any).share;
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        community({ shareOutside: false, door: 'members' });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        fireEvent.click(screen.getByTestId('share-members-button'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://mullum.beanpool.org/?post=post-123'));
        expect(screen.queryByRole('menu')).toBeNull();
        expect(await screen.findByTestId('share-members-result')).toHaveTextContent('Link copied.');
        expect(document.activeElement).toBe(trigger());
    });

    it('Invite and share opens its panel under the row, not inside the menu, and the menu closes', async () => {
        community({ shareOutside: false, door: 'members' });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        fireEvent.click(await screen.findByTestId('invite-and-share-button'));
        expect(screen.queryByRole('menu')).toBeNull();
        const panel = screen.getByTestId('invite-and-share-panel');
        expect(panel).toBeInTheDocument();
        // Open the menu again: the item says its panel is open.
        openShare();
        expect(screen.getByTestId('invite-and-share-button').getAttribute('aria-expanded')).toBe('true');
        expect(menu()).not.toContainElement(panel);
    });

    it('Ask an admin to invite someone opens the one ask form, which takes the focus (the menu does not take it back)', async () => {
        community({ door: 'admins', shareOutside: false, inviteAsks: true });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        fireEvent.click(await screen.findByTestId('share-ask-admin-button'));
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByTestId('invite-ask-sheet')).toBeInTheDocument();
        await new Promise(r => requestAnimationFrame(() => r(null)));
        expect(document.activeElement).toBe(screen.getByTestId('invite-ask-first-name'));
    });
});

describe('the keyboard and the pointer', () => {
    const openWithTwoItems = async () => {
        community({ shareOutside: true, door: 'members', knocks: true });
        await act(async () => { render(<SharePostButtons post={listing} isMember />); });
        openShare();
        await screen.findByTestId('invite-and-share-button');
    };

    it('the first item takes focus when the menu opens; the arrow keys walk the items and wrap round', async () => {
        await openWithTwoItems();
        const [members, outside, invite] = ['share-members-button', 'share-outside-button', 'invite-and-share-button'].map(id => screen.getByTestId(id));
        // The menu was opened before the later items arrived: the first took the focus then.
        expect(document.activeElement).toBe(members);
        fireEvent.keyDown(members, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(outside);
        fireEvent.keyDown(outside, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(invite);
        fireEvent.keyDown(invite, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(members);
        fireEvent.keyDown(members, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(invite);
    });

    it('Escape closes the menu and hands the focus back to the Share button', async () => {
        await openWithTwoItems();
        fireEvent.keyDown(screen.getByTestId('share-members-button'), { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });

    it('Escape stops at the menu: the page behind it never sees the key (a page that closes on Escape would close with it)', async () => {
        await openWithTwoItems();
        const seenByThePage = vi.fn();
        window.addEventListener('keydown', seenByThePage);
        try {
            fireEvent.keyDown(screen.getByTestId('share-members-button'), { key: 'Escape' });
        } finally {
            window.removeEventListener('keydown', seenByThePage);
        }
        expect(screen.queryByRole('menu')).toBeNull();
        expect(seenByThePage).not.toHaveBeenCalled();
    });

    it('Tab closes the menu, so the member is never held in it', async () => {
        await openWithTwoItems();
        fireEvent.keyDown(screen.getByTestId('share-members-button'), { key: 'Tab' });
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('a press outside closes it; a press on the button toggles it', async () => {
        await openWithTwoItems();
        fireEvent.mouseDown(document.body);
        expect(screen.queryByRole('menu')).toBeNull();
        openShare();
        expect(screen.getByRole('menu')).toBeInTheDocument();
        openShare();
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('the menu sits in the page flow, so nothing can cut it off', async () => {
        await openWithTwoItems();
        expect(menu().className).not.toMatch(/\b(absolute|fixed)\b/);
        expect(menu().className).toContain('w-full');
    });
});

/**
 * Every row of core's share-says table, for a listing and for an event: each sentence shareSays returns is an item's line in
 * the menu, and each way it offers is an item (and only those). A sentence that could not be reached would be a row of the table
 * the member never reads before the tap.
 */
describe('every shareSays row is reachable in the menu', () => {
    const ROWS: Array<[string, Record<string, unknown>, string | null]> = [
        ['sharing outside on, joining open', { shareOutside: true, door: 'members', knocks: true }, null],
        ['sharing outside on, joining paused', { shareOutside: true, door: 'members', knocks: false }, null],
        ['sharing outside on, only admins invite, a member', { shareOutside: true, door: 'admins', knocks: true, inviteAsks: true }, null],
        ['sharing outside off, any member may invite', { shareOutside: false, door: 'members' }, null],
        ['only admins invite, a member', { shareOutside: false, door: 'admins', inviteAsks: true }, null],
        ['only admins invite, an admin', { shareOutside: false, door: 'admins', inviteAsks: true }, 'admin'],
        ['private preview, a member', { privatePreview: true, door: 'admins', shareOutside: false, inviteAsks: true }, null],
        ['private preview, an owner', { privatePreview: true, door: 'admins', shareOutside: false, inviteAsks: true }, 'owner'],
        ['open door (global)', { door: 'open', openJoin: true, invites: false, shareOutside: false }, null],
        ['invites off, a members door', { shareOutside: false, door: 'members', invites: false }, null],
    ];
    const cases = ROWS.flatMap(([name, f, role]) => (['listing', 'event'] as const).map(kind => [`${name} (${kind})`, f, role, kind] as const));

    it.each(cases)('%s', async (_name, f, role, kind) => {
        community(f);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(role);
        vi.mocked(api.request).mockResolvedValue({ role });
        const asked = f.door === 'admins' || f.privatePreview === true;
        const says = shareSays(f as any, asked ? role : undefined, kind);
        const post = kind === 'event' ? event : listing;
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        if (says.showInviteButton) await screen.findByTestId('invite-and-share-button');
        if (says.showAskAdmin) await screen.findByTestId('share-ask-admin-button');
        await settle();

        const open = within(menu());
        // Share with members is always there; its sentence is its line, where there is one.
        expect(open.getByTestId('share-members-button')).toBeInTheDocument();
        if (says.membersLine) expect(open.getByTestId('share-members-note')).toHaveTextContent(t(says.membersLine));
        else expect(open.queryByTestId('share-members-note')).toBeNull();
        // Share outside, with its sentence.
        if (says.showShareOutside) {
            expect(open.getByTestId('share-outside-button')).toBeInTheDocument();
            if (says.outsideLine) expect(open.getByTestId('share-outside-line')).toHaveTextContent(t(says.outsideLine));
        } else {
            expect(open.queryByTestId('share-outside-button')).toBeNull();
        }
        // The invite action, with its sentence; and the ask, never beside it.
        expect(!!open.queryByTestId('invite-and-share-button')).toBe(says.showInviteButton);
        if (says.showInviteButton) expect(open.getByTestId('invite-and-share-line')).toHaveTextContent('One invite, for one person: a code works once.');
        expect(!!open.queryByTestId('share-ask-admin-button')).toBe(says.showAskAdmin);
        expect(!!(open.queryByTestId('invite-and-share-button') && open.queryByTestId('share-ask-admin-button'))).toBe(false);
        // Nothing else is in the menu.
        expect(open.getAllByRole('menuitem')).toHaveLength(1 + Number(says.showShareOutside) + Number(says.showInviteButton) + Number(says.showAskAdmin));
        // An event's sentence says "event", a listing's "listing".
        if (says.showShareOutside) expect(open.getByTestId('share-outside-line').textContent).toMatch(kind === 'event' ? /this event/ : /this listing/);
    });
});
