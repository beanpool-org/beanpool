/**
 * The web app hears about moderation on its member's next visit (#1175's deciding pass): the node keeps each moderation
 * notice for its member (GET /api/notices), and the app shell shows the unseen ones when it opens, each once, as the live
 * alert shows them, and marks each seen. A paused member sees that plainly (GET /api/community/me `mute`).
 *
 * The whole App, with the node's reads mocked at lib/api and the socket's subscriptions at lib/sync.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import * as api from './lib/api';
import type { KeptNotice, CommunityStanding } from './lib/api';

const hooks = vi.hoisted(() => ({
    announce: null as null | ((a: any) => void),
    socketOpen: null as null | (() => void),
}));

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./components/NewAccountCard', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/NewAccountCard')>()),
    NewAccountCard: () => null,
}));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn((cb: (a: any) => void) => { hooks.announce = cb; return () => { if (hooks.announce === cb) hooks.announce = null; }; }),
    onSocketOpen: vi.fn((cb: () => void) => { hooks.socketOpen = cb; return () => { if (hooks.socketOpen === cb) hooks.socketOpen = null; }; }),
}));

vi.mock('./lib/api', () => ({
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.26' })),
    getMyActiveRecoveryCollections: vi.fn(async () => []),
    getCommunityMe: vi.fn(),
    getUnseenNotices: vi.fn(),
    markNoticesSeen: vi.fn(),
}));

const notice = (id: string, title: string, body: string, kind: string): KeptNotice =>
    ({ id, title, body, severity: 'info', data: { kind, postId: `post-${id}` }, createdAt: '2026-09-26T01:00:00.000Z', seenAt: null });
const REMOVED = notice('n-removed', '🛡️ Your post was removed', 'Your post "Honey" was removed by the community\'s moderators. Reason: spam or a scam.', 'post_removed');
const HIDDEN = notice('n-hidden', '🛡️ Your post is hidden for review', 'Your post "Jam" is hidden while the community\'s moderators look at reports about it. It has not been removed, and you can still see it.', 'post_hidden');

const standing = (mute: CommunityStanding['mute']): CommunityStanding => ({
    publicKey: 'my-user-pubkey',
    probation: { onProbation: false, exemptBecause: 'off', ageEndsAt: null, keptPosts: 3, keptPostsNeeded: 3,
        limits: { posts: { limit: 3, used: 0, resetsAt: null }, photos: { limit: 5, used: 0, resetsAt: null }, new_dm_recipients: { limit: 10, used: 0, resetsAt: null } } },
    mute,
});
const NOT_PAUSED = standing({ muted: false, until: null });
const PAUSED = standing({ muted: true, until: '9999-12-31T23:59:59.999Z' });

const alertDialog = () => screen.queryByRole('alertdialog');
/** The node's live alert reaching this tab's socket. */
const announce = (a: any) => act(() => { hooks.announce!(a); });

describe('The web app shows moderation notices kept while it was closed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.announce = null;
        hooks.socketOpen = null;
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true } as any);
        vi.mocked(api.getCommunityMe).mockResolvedValue(NOT_PAUSED);
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        vi.mocked(api.markNoticesSeen).mockResolvedValue({ success: true, marked: 1 });
    });

    it('on opening, shows each unseen notice once, as the live alert does, and marks each seen as it is shown', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([REMOVED, HIDDEN]);
        render(<App />);

        const first = await screen.findByRole('alertdialog');
        expect(first).toHaveTextContent(REMOVED.title);
        expect(first).toHaveTextContent(REMOVED.body);
        expect(within(first).getByText('1 of 2')).toBeInTheDocument();
        await waitFor(() => expect(api.markNoticesSeen).toHaveBeenCalledWith([REMOVED.id]));
        expect(api.markNoticesSeen).not.toHaveBeenCalledWith([HIDDEN.id]);

        fireEvent.click(within(first).getByRole('button', { name: 'Acknowledge' }));
        const second = await screen.findByRole('alertdialog');
        expect(second).toHaveTextContent(HIDDEN.title);
        expect(second).toHaveTextContent(HIDDEN.body);
        await waitFor(() => expect(api.markNoticesSeen).toHaveBeenCalledWith([HIDDEN.id]));

        fireEvent.click(within(second).getByRole('button', { name: 'Acknowledge' }));
        await waitFor(() => expect(alertDialog()).toBeNull());
        expect(api.getUnseenNotices).toHaveBeenCalledTimes(1);
        expect(api.markNoticesSeen).toHaveBeenCalledTimes(2);
    });

    it('a live notice the node also kept is shown once, and marked seen, so the next open does not show it again', async () => {
        render(<App />);
        await screen.findByTestId('marketplace-page');
        await waitFor(() => expect(hooks.announce).not.toBeNull());
        await announce({ type: 'system_announcement', title: REMOVED.title, body: REMOVED.body, severity: 'info', kind: 'post_removed', noticeId: REMOVED.id });
        const shown = await screen.findByRole('alertdialog');
        expect(shown).toHaveTextContent(REMOVED.body);
        await waitFor(() => expect(api.markNoticesSeen).toHaveBeenCalledWith([REMOVED.id]));
        // The same notice arriving live a second time (another tab's socket, say) is not queued again.
        await announce({ type: 'system_announcement', title: REMOVED.title, body: REMOVED.body, severity: 'info', kind: 'post_removed', noticeId: REMOVED.id });
        expect(within(shown).queryByText(/1 of/)).toBeNull();
        fireEvent.click(within(shown).getByRole('button', { name: 'Acknowledge' }));
        await waitFor(() => expect(alertDialog()).toBeNull());
    });

    it('a read that fails shows nothing and breaks nothing: the app loads, and a live alert still shows', async () => {
        vi.mocked(api.getUnseenNotices).mockRejectedValue(Object.assign(new Error('Request failed: 404'), { status: 404 }));
        vi.mocked(api.markNoticesSeen).mockRejectedValue(new Error('offline'));
        render(<App />);
        expect(await screen.findByTestId('marketplace-page')).toBeInTheDocument();
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalled());
        expect(alertDialog()).toBeNull();
        await waitFor(() => expect(hooks.announce).not.toBeNull());
        await announce({ type: 'system_announcement', title: 'Node maintenance', body: 'Back in five minutes.', severity: 'warning' });
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Back in five minutes.');
    });

    it('a guest reads no notices and gets no pause card', async () => {
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false } as any);
        render(<App />);
        await screen.findByTestId('marketplace-page');
        await waitFor(() => expect(api.checkMembership).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 50));
        expect(api.getUnseenNotices).not.toHaveBeenCalled();
        expect(screen.queryByTestId('moderation-pause-card')).toBeNull();
    });
});

describe('A paused member sees it plainly', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.announce = null;
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true } as any);
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        vi.mocked(api.markNoticesSeen).mockResolvedValue({ success: true, marked: 1 });
    });

    it('renders /api/community/me\'s mute: posting and messaging are paused, and until when', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(PAUSED);
        render(<App />);
        const card = await screen.findByTestId('moderation-pause-card');
        expect(within(card).getByRole('heading', { name: /Posting paused/ })).toBeInTheDocument();
        expect(card).toHaveTextContent('You can’t post or send messages here until a moderator lifts this.');
        expect(card).toHaveTextContent('You can still read, edit your profile and leave.');
    });

    it('nothing when not paused', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(NOT_PAUSED);
        render(<App />);
        await screen.findByTestId('marketplace-page');
        await waitFor(() => expect(api.getCommunityMe).toHaveBeenCalled());
        expect(screen.queryByTestId('moderation-pause-card')).toBeNull();
    });

    it('a pause shown live puts the card up at once, and its lift takes it down', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(NOT_PAUSED);
        render(<App />);
        await screen.findByTestId('marketplace-page');
        await waitFor(() => expect(hooks.announce).not.toBeNull());
        vi.mocked(api.getCommunityMe).mockResolvedValue(PAUSED);
        await announce({ type: 'system_announcement', title: '🛡️ Posting paused', body: 'You can’t post.', severity: 'info', kind: 'moderation_muted', noticeId: 'n-muted' });
        expect(await screen.findByTestId('moderation-pause-card')).toBeInTheDocument();
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Acknowledge' }));

        vi.mocked(api.getCommunityMe).mockResolvedValue(NOT_PAUSED);
        await announce({ type: 'system_announcement', title: '🛡️ You can post again', body: 'A moderator lifted the pause.', severity: 'info', kind: 'moderation_unmuted', noticeId: 'n-unmuted' });
        await waitFor(() => expect(screen.queryByTestId('moderation-pause-card')).toBeNull());
    });

    it('a lift closed unread by "Close all" still takes the card down', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(PAUSED);
        render(<App />);
        expect(await screen.findByTestId('moderation-pause-card')).toBeInTheDocument();
        await waitFor(() => expect(hooks.announce).not.toBeNull());

        vi.mocked(api.getCommunityMe).mockResolvedValue(NOT_PAUSED);
        await announce({ type: 'system_announcement', title: REMOVED.title, body: REMOVED.body, severity: 'info', kind: 'post_removed', noticeId: 'n-removed-live' });
        await announce({ type: 'system_announcement', title: '🛡️ You can post again', body: 'A moderator lifted the pause.', severity: 'info', kind: 'moderation_unmuted', noticeId: 'n-unmuted-behind' });
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent(REMOVED.title);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByTestId('moderation-pause-card')).toBeNull());
    });
});
