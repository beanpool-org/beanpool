// @vitest-environment jsdom
/**
 * "Ask an admin to invite someone" in the share sheet (web), on a listing and on an event. Where only admins invite and the
 * member is no admin, the sheet shows the line and ONE more button, which opens the ask form People → Invites uses
 * (components/InviteAsks.tsx AskSheet). Nothing else in the sheet changes; where the node does not take asks, a guest, an
 * admin or a role not known: no button. The node is a stub behind lib/invite-asks.ts; its rules are test-invite-asks.ts.
 */
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePostButtons } from './SharePost';
import { EventDetail } from './EventCard';
import type { MarketplacePost } from '../lib/api';
import * as features from '../lib/features';
import * as api from '../lib/api';
import * as asks from '../lib/invite-asks';

vi.mock('../lib/features', async () => {
    const actual = await vi.importActual('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual, myNodeRoleOnce: vi.fn(), request: vi.fn(), getBalance: vi.fn(),
        getMyEvents: vi.fn(async () => []), getNotificationPreferences: vi.fn(async () => ({})), getNodeApiUrl: () => 'https://mullum.beanpool.org',
    };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, loadIdentity: vi.fn(async () => ({ publicKey: 'pk-me', privateKey: 'sk', callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' })) };
});
vi.mock('../lib/invite-asks', async () => {
    const actual = await vi.importActual<typeof import('../lib/invite-asks')>('../lib/invite-asks');
    return { ...actual, askAnAdmin: vi.fn(async () => ({ ok: true })), readMyAsks: vi.fn(async () => null) };
});

const post: MarketplacePost = {
    id: 'post-123', title: 'Ladder for borrowing', type: 'offer', category: 'tools', description: 'A 6m ladder',
    credits: 0, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob', createdAt: new Date().toISOString(),
    status: 'active', active: true, audienceScope: 'public', repeatable: false,
};
const CLOSED = { door: 'admins', shareOutside: false, inviteAsks: true };
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
/** The page shows one Share button; the Ask is an item of the menu it opens (DESIGN-detail-pages-fable.md §2.5, slice DW2). */
const openShare = () => fireEvent.click(screen.getByTestId('share-button'));
const community = (f: Record<string, unknown>) => vi.mocked(features.useCommunityInfo).mockReturnValue({ profile: 'local', features: f } as any);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.request).mockResolvedValue({ role: null });
    vi.mocked(api.getBalance).mockResolvedValue({ canVouch: false } as any);
});
afterEach(() => cleanup());

describe('Ask an admin to invite someone, in the share sheet (web)', () => {
    it('only admins invite, a member who is no admin: the line, the Ask, no Invite and share — and the Ask opens the one ask form', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only, and only admins invite here.');
        expect(screen.getByTestId('share-ask-admin-button')).toHaveTextContent('Ask an admin to invite someone');
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
        expect(screen.queryByTestId('share-outside-button')).toBeNull();
        expect(screen.queryByTestId('invite-ask-sheet')).toBeNull();

        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        // The same sheet People → Invites opens: its two lines, and Send waits for both.
        const sheet = screen.getByTestId('invite-ask-sheet');
        expect(sheet).toBeInTheDocument();
        expect(screen.getByTestId('invite-ask-first-name')).toBeInTheDocument();
        expect(screen.getByTestId('invite-ask-how-known')).toBeInTheDocument();
        expect((screen.getByTestId('invite-ask-send') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByTestId('invite-ask-first-name'), { target: { value: ' Sam ' } });
        fireEvent.change(screen.getByTestId('invite-ask-how-known'), { target: { value: ' from the bakery ' } });
        fireEvent.submit(sheet.querySelector('form')!);
        await waitFor(() => expect(screen.queryByTestId('invite-ask-sheet')).toBeNull());
        expect(asks.askAnAdmin).toHaveBeenCalledWith(' Sam ', ' from the bakery ');
        // The member is told it went, in words the ask form already has.
        expect(screen.getByTestId('share-ask-admin-note')).toHaveTextContent('Waiting for an admin');
    });

    // The Ask is an item of the menu, and choosing it closes the menu in the same step that opens the sheet: the item the sheet
    // would hand focus back to is gone. Focus goes to the Share button, never to the page's <body> (review of #2872).
    const openAsk = async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        screen.getByTestId('share-button').focus();
        openShare();
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('invite-ask-first-name')));
    };

    it('Escape on the ask form puts focus back on the Share button, not the page', async () => {
        await openAsk();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('invite-ask-sheet')).toBeNull();
        expect(document.activeElement).toBe(screen.getByTestId('share-button'));
    });

    it('Cancel on the ask form puts focus back on the Share button', async () => {
        await openAsk();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('invite-ask-sheet')).toBeNull();
        expect(document.activeElement).toBe(screen.getByTestId('share-button'));
    });

    it('Send puts focus back on the Share button, where the note that it went is read', async () => {
        await openAsk();
        fireEvent.change(screen.getByTestId('invite-ask-first-name'), { target: { value: 'Sam' } });
        fireEvent.change(screen.getByTestId('invite-ask-how-known'), { target: { value: 'the bakery' } });
        fireEvent.submit(screen.getByTestId('invite-ask-sheet').querySelector('form')!);
        await waitFor(() => expect(screen.queryByTestId('invite-ask-sheet')).toBeNull());
        expect(document.activeElement).toBe(screen.getByTestId('share-button'));
    });

    it('on an event the same: focus goes back to the event\'s Share button', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        const event = {
            ...post, type: 'event', category: 'community', title: 'Working bee at the hall', eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null,
            lat: -28.55, lng: 153.5, eventPlaceName: 'Hall',
            eventStartAt: new Date(Date.now() + 86400000).toISOString(), eventEndAt: new Date(Date.now() + 90000000).toISOString(),
        } as any;
        await act(async () => { render(<EventDetail post={event} identity={{ publicKey: 'pk-me', privateKey: 'sk', callsign: 'Ana' } as any} />); });
        screen.getByTestId('event-share').focus();
        fireEvent.click(screen.getByTestId('event-share'));
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('invite-ask-first-name')));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('invite-ask-sheet')).toBeNull();
        expect(document.activeElement).toBe(screen.getByTestId('event-share'));
    });

    it('a refusal stays in the sheet, in the node\'s words, and nothing is claimed as sent', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        vi.mocked(asks.askAnAdmin).mockResolvedValueOnce({ ok: false, message: 'You have 3 asks waiting. Take one back, or wait for an answer.' });
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        fireEvent.change(screen.getByTestId('invite-ask-first-name'), { target: { value: 'Sam' } });
        fireEvent.change(screen.getByTestId('invite-ask-how-known'), { target: { value: 'the bakery' } });
        fireEvent.submit(screen.getByTestId('invite-ask-sheet').querySelector('form')!);
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You have 3 asks waiting.'));
        expect(screen.getByTestId('invite-ask-sheet')).toBeInTheDocument();
        expect(screen.queryByTestId('share-ask-admin-note')).toBeNull();
    });

    it('with sharing outside on, the Ask shows under the same line and Share outside stays', async () => {
        community({ ...CLOSED, shareOutside: true, knocks: true });
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        expect(screen.getByTestId('share-outside-button')).toBeInTheDocument();
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
    });

    it('an owner or admin sees Invite and share and no Ask', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('admin');
        vi.mocked(api.request).mockResolvedValue({ role: 'admin' });
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('invite-and-share-button')).toBeInTheDocument());
        await tick();
        expect(screen.queryByTestId('share-ask-admin-button')).toBeNull();
    });

    it('asks off (the node does not take them): the line as before, and no button', async () => {
        community({ ...CLOSED, inviteAsks: false });
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('share-members-note')).toHaveTextContent('only admins invite here'));
        await tick();
        expect(screen.queryByTestId('share-ask-admin-button')).toBeNull();
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
    });

    it('a role not known (the node did not answer): no line and no button', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(undefined);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await tick();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
        expect(screen.queryByTestId('share-ask-admin-button')).toBeNull();
    });

    it('a guest is offered none', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember={false} />); });
        openShare();
        await tick();
        // Read open: the menu is there (Share with members), and the Ask is not in it.
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('share-ask-admin-button')).toBeNull();
    });

    it('any member may invite (a members door): Invite and share, no Ask', async () => {
        community({ door: 'members', shareOutside: false, inviteAsks: true });
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        await waitFor(() => expect(screen.getByTestId('invite-and-share-button')).toBeInTheDocument());
        expect(screen.queryByTestId('share-ask-admin-button')).toBeNull();
    });

    it('the one note under Share outside reads as one: 7 days, no names or faces, you can stop it', async () => {
        community({ door: 'members', shareOutside: true, knocks: true, inviteAsks: true });
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        await act(async () => { render(<SharePostButtons post={post} isMember />); });
        openShare();
        const note = screen.getByTestId('share-outside-line');
        expect(note).toHaveTextContent('Anyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.');
        expect(screen.queryByTestId('share-outside-privacy')).toBeNull();
    });

    it('an event: the same Ask, and the same form', async () => {
        community(CLOSED);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);
        const event = {
            ...post, type: 'event', category: 'community', title: 'Working bee at the hall', eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null,
            lat: -28.55, lng: 153.5, eventPlaceName: 'Hall',
            eventStartAt: new Date(Date.now() + 86400000).toISOString(), eventEndAt: new Date(Date.now() + 90000000).toISOString(),
        } as any;
        await act(async () => { render(<EventDetail post={event} identity={{ publicKey: 'pk-me', privateKey: 'sk', callsign: 'Ana' } as any} />); });
        fireEvent.click(screen.getByTestId('event-share'));
        await waitFor(() => expect(screen.getByTestId('share-ask-admin-button')).toBeInTheDocument());
        expect(screen.getByTestId('event-share-members-note')).toHaveTextContent('only admins invite here');
        fireEvent.click(screen.getByTestId('share-ask-admin-button'));
        expect(screen.getByTestId('invite-ask-sheet')).toBeInTheDocument();
    });
});
