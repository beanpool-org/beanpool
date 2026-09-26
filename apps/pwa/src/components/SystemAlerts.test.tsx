/**
 * SystemAlerts: the node's alerts, live and kept (GET /api/notices), each shown once and each kept copy marked seen.
 * The socket's subscriptions are mocked at lib/sync, the node's reads at lib/api.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { SystemAlerts } from './SystemAlerts';
import * as api from '../lib/api';
import type { KeptNotice } from '../lib/api';

const hooks = vi.hoisted(() => ({
    announce: [] as ((a: any) => void)[],
    socketOpen: [] as (() => void)[],
}));

vi.mock('../lib/sync', () => ({
    onSystemAnnouncement: vi.fn((cb: (a: any) => void) => { hooks.announce.push(cb); return () => { hooks.announce = hooks.announce.filter(c => c !== cb); }; }),
    onSocketOpen: vi.fn((cb: () => void) => { hooks.socketOpen.push(cb); return () => { hooks.socketOpen = hooks.socketOpen.filter(c => c !== cb); }; }),
}));

vi.mock('../lib/api', () => ({
    getUnseenNotices: vi.fn(),
    markNoticesSeen: vi.fn(),
}));

const notice = (id: string, kind = 'post_removed'): KeptNotice =>
    ({ id, title: `Title ${id}`, body: `Body ${id}`, severity: 'info', data: { kind }, createdAt: '2026-09-26T00:00:00.000Z', seenAt: null });
const announce = (a: any) => act(() => { hooks.announce.forEach(cb => cb(a)); });
const reconnect = () => act(() => { hooks.socketOpen.forEach(cb => cb()); });
const acknowledge = async () => fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Acknowledge' }));
const markedIds = () => vi.mocked(api.markNoticesSeen).mock.calls.map(c => c[0]);

describe('SystemAlerts: live and kept alerts, each once', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.announce = [];
        hooks.socketOpen = [];
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        vi.mocked(api.markNoticesSeen).mockResolvedValue({ success: true, marked: 1 });
    });

    it('reads again when the socket reconnects, and shows only what it has not shown', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('a')]);
        render(<SystemAlerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body a');
        await acknowledge();
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

        // The mark didn't reach the node (so `a` is still unseen there), and `b` came while the socket was down.
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('a'), notice('b')]);
        await reconnect();
        const next = await screen.findByRole('alertdialog');
        expect(next).toHaveTextContent('Body b');
        expect(within(next).queryByText(/1 of/)).toBeNull();
        expect(api.getUnseenNotices).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(markedIds()).toEqual([['a'], ['b']]));
    });

    it('opening and the socket connecting a moment later is one read', async () => {
        render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        await reconnect();
        await new Promise(r => setTimeout(r, 20));
        expect(api.getUnseenNotices).toHaveBeenCalledTimes(1);
    });

    it('a live notice carrying its kept copy is marked seen as it is shown, and the same notice read later is not shown again', async () => {
        render(<SystemAlerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        await announce({ type: 'system_announcement', title: 'Title live', body: 'Body live', severity: 'info', noticeId: 'live-1', kind: 'post_hidden' });
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body live');
        await waitFor(() => expect(markedIds()).toEqual([['live-1']]));
        await acknowledge();
        vi.mocked(api.getUnseenNotices).mockResolvedValue([{ ...notice('live-1'), body: 'Body live' }]);
        await reconnect();
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(2));
        await new Promise(r => setTimeout(r, 20));
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('a live alert with no kept copy (a node older than this, or not a moderation notice) still shows, and marks nothing', async () => {
        render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        await announce({ type: 'system_announcement', title: 'Maintenance', body: 'Back soon', severity: 'warning' });
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('⚠️ Maintenance');
        await acknowledge();
        await announce({ type: 'system_announcement', title: 'Maintenance', body: 'Back soon', severity: 'warning' });
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Back soon');
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
    });

    it('a read or a mark that fails shows nothing and breaks nothing', async () => {
        vi.mocked(api.getUnseenNotices).mockRejectedValue(new Error('offline'));
        vi.mocked(api.markNoticesSeen).mockRejectedValue(new Error('offline'));
        render(<SystemAlerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        // The node answers again: shown, and a mark that fails leaves the next one showing all the same.
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('x'), notice('y')]);
        await reconnect();
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body x');
        await acknowledge();
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body y');
    });

    it('"Close all" marks the rest seen in one go and closes them', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('p'), notice('q'), notice('r')]);
        render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText('1 of 3')).toBeInTheDocument();
        await waitFor(() => expect(markedIds()).toEqual([['p']]));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 3' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        await waitFor(() => expect(markedIds()).toEqual([['p'], ['q', 'r']]));
    });

    it('tells the app what each alert was about as it is shown', async () => {
        const onShown = vi.fn();
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('m', 'moderation_muted')]);
        render(<SystemAlerts memberPubkey="me" isGuest={false} onShown={onShown} />);
        await screen.findByRole('alertdialog');
        await waitFor(() => expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ kind: 'moderation_muted', noticeId: 'm' })));
    });

    it('"Close all" tells the app about each alert it closes unread: a pause behind another notice still reaches it', async () => {
        const onShown = vi.fn();
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('gone', 'post_removed'), notice('paused', 'moderation_muted')]);
        render(<SystemAlerts memberPubkey="me" isGuest={false} onShown={onShown} />);
        const dialog = await screen.findByRole('alertdialog');
        await waitFor(() => expect(onShown).toHaveBeenCalledTimes(1));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(onShown.mock.calls.map(c => c[0].noticeId)).toEqual(['gone', 'paused']);
        expect(onShown).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'moderation_muted' }));
    });

    it('reads nothing for a guest, before the membership check answers, or with no identity', async () => {
        const { rerender } = render(<SystemAlerts memberPubkey="me" isGuest={true} />);
        rerender(<SystemAlerts memberPubkey="me" isGuest={null} />);
        rerender(<SystemAlerts memberPubkey={null} isGuest={false} />);
        await new Promise(r => setTimeout(r, 20));
        expect(api.getUnseenNotices).not.toHaveBeenCalled();
        rerender(<SystemAlerts memberPubkey="me" isGuest={false} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
    });

    it('another member on this browser starts from nothing', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('first-member')]);
        const { rerender } = render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body first-member');
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        rerender(<SystemAlerts memberPubkey="someone-else" isGuest={false} />);
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });
});
