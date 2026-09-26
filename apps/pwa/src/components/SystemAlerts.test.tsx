/**
 * SystemAlerts: the node's alerts, live and kept (GET /api/notices), each shown once and each kept copy marked seen
 * when the member puts it away (Acknowledge, Close all), never as it is shown.
 * The socket's subscriptions are mocked at lib/sync, the node's reads at lib/api.
 *
 * The tests that are not about the press guard (a second after an alert appears, or a letter is typed, in which its
 * buttons ignore a press) render it with no guard, so they can press at once; the guard's own tests, at the end, use
 * the real second.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { SystemAlerts, PRESS_GUARD_MS, type SystemAlertsProps } from './SystemAlerts';
import * as api from '../lib/api';
import type { KeptNotice } from '../lib/api';

const Alerts = (props: SystemAlertsProps) => <SystemAlerts pressGuardMs={0} {...props} />;

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
        render(<Alerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
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
        await new Promise(r => setTimeout(r, 20));
        expect(markedIds()).toEqual([['a']]);
        await acknowledge();
        await waitFor(() => expect(markedIds()).toEqual([['a'], ['b']]));
    });

    it('opening and the socket connecting a moment later is one read', async () => {
        render(<Alerts memberPubkey="me" isGuest={false} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        await reconnect();
        await new Promise(r => setTimeout(r, 20));
        expect(api.getUnseenNotices).toHaveBeenCalledTimes(1);
    });

    it('a live notice carrying its kept copy is marked seen when acknowledged, and the same notice read later is not shown again', async () => {
        render(<Alerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        await announce({ type: 'system_announcement', title: 'Title live', body: 'Body live', severity: 'info', noticeId: 'live-1', kind: 'post_hidden' });
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body live');
        await new Promise(r => setTimeout(r, 20));
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        await acknowledge();
        await waitFor(() => expect(markedIds()).toEqual([['live-1']]));
        vi.mocked(api.getUnseenNotices).mockResolvedValue([{ ...notice('live-1'), body: 'Body live' }]);
        await reconnect();
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(2));
        await new Promise(r => setTimeout(r, 20));
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('a tab nobody is looking at marks nothing: a notice is marked seen when the member acknowledges it, once', async () => {
        // A background tab (Chrome's Memory Saver, or Android on a low-memory phone, may close it before the member looks).
        let hidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
        try {
            render(<Alerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
            await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
            // A live notice on the hidden tab's open socket; then the socket drops and reconnects while still hidden.
            await announce({ type: 'system_announcement', title: 'Title live', body: 'Body live', severity: 'info', noticeId: 'live-1', kind: 'post_hidden' });
            vi.mocked(api.getUnseenNotices).mockResolvedValue([{ ...notice('live-1'), body: 'Body live' }, notice('k1')]);
            await reconnect();
            await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(2));
            const dialog = await screen.findByRole('alertdialog');
            expect(dialog).toHaveTextContent('Body live');
            await waitFor(() => expect(within(dialog).getByText('1 of 2')).toBeInTheDocument());
            await new Promise(r => setTimeout(r, 20));
            expect(api.markNoticesSeen).not.toHaveBeenCalled();

            // The member comes back to the tab: still nothing, until they tap Acknowledge. Then that one, once.
            hidden = false;
            act(() => { document.dispatchEvent(new Event('visibilitychange')); });
            await new Promise(r => setTimeout(r, 20));
            expect(api.markNoticesSeen).not.toHaveBeenCalled();
            await acknowledge();
            await waitFor(() => expect(markedIds()).toEqual([['live-1']]));
            expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body k1');
            await new Promise(r => setTimeout(r, 20));
            expect(markedIds()).toEqual([['live-1']]);
        } finally {
            delete (document as any).hidden;
            delete (document as any).visibilityState;
        }
    });

    it('a live alert with no kept copy (a node older than this, or not a moderation notice) still shows, and marks nothing', async () => {
        render(<Alerts memberPubkey="me" isGuest={false} />);
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
        render(<Alerts memberPubkey="me" isGuest={false} rereadGapMs={0} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        // The node answers again: shown, and a mark that fails leaves the next one showing all the same.
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('x'), notice('y')]);
        await reconnect();
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body x');
        await acknowledge();
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body y');
    });

    it('"Close all" marks the one showing and the rest seen in one go and closes them', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('p'), notice('q'), notice('r')]);
        render(<Alerts memberPubkey="me" isGuest={false} />);
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText('1 of 3')).toBeInTheDocument();
        await new Promise(r => setTimeout(r, 20));
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 3' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        await waitFor(() => expect(markedIds()).toEqual([['p', 'q', 'r']]));
    });

    it('"Close all" after an Acknowledge marks only what is left, and nothing twice', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('p'), notice('q'), notice('r')]);
        render(<Alerts memberPubkey="me" isGuest={false} />);
        await acknowledge();
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText('1 of 2')).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        await waitFor(() => expect(markedIds()).toEqual([['p'], ['q', 'r']]));
    });

    it('tells the app what each alert was about as it is shown', async () => {
        const onShown = vi.fn();
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('m', 'moderation_muted')]);
        render(<Alerts memberPubkey="me" isGuest={false} onShown={onShown} />);
        await screen.findByRole('alertdialog');
        await waitFor(() => expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ kind: 'moderation_muted', noticeId: 'm' })));
    });

    it('"Close all" tells the app about each alert it closes unread: a pause behind another notice still reaches it', async () => {
        const onShown = vi.fn();
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('gone', 'post_removed'), notice('paused', 'moderation_muted')]);
        render(<Alerts memberPubkey="me" isGuest={false} onShown={onShown} />);
        const dialog = await screen.findByRole('alertdialog');
        await waitFor(() => expect(onShown).toHaveBeenCalledTimes(1));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(onShown.mock.calls.map(c => c[0].noticeId)).toEqual(['gone', 'paused']);
        expect(onShown).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'moderation_muted' }));
    });

    it('a title with its own icon reads as the node wrote it (no ℹ️ before it), and a screen reader hears only the words', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([{ ...notice('own'), title: '🛡️ Your post was removed' }, notice('plain')]);
        render(<Alerts memberPubkey="me" isGuest={false} />);
        const first = await screen.findByRole('alertdialog', { name: 'Your post was removed' });
        const title = within(first).getByRole('heading');
        expect(title.textContent).toBe('🛡️ Your post was removed');
        expect(title.querySelector('[aria-hidden="true"]')?.textContent).toBe('🛡️ ');
        await acknowledge();
        // A title with no icon of its own still gets ℹ️, hidden from a screen reader all the same.
        const second = await screen.findByRole('alertdialog', { name: 'Title plain' });
        expect(within(second).getByRole('heading').textContent).toBe('ℹ️ Title plain');
        expect(within(second).getByRole('heading').querySelector('[aria-hidden="true"]')?.textContent).toBe('ℹ️ ');
    });

    it('a warning keeps its own icon, hidden from a screen reader', async () => {
        render(<Alerts memberPubkey="me" isGuest={false} />);
        await announce({ type: 'system_announcement', title: 'Maintenance', body: 'Back soon', severity: 'warning' });
        const dialog = await screen.findByRole('alertdialog', { name: 'Maintenance' });
        expect(within(dialog).getByRole('heading').textContent).toBe('⚠️ Maintenance');
    });

    it('focus goes to the alert itself when it appears, and again when the next one in the queue does', async () => {
        render(
            <>
                <input aria-label="Message" />
                <Alerts memberPubkey="me" isGuest={false} />
            </>,
        );
        screen.getByRole('textbox', { name: 'Message' }).focus();
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'f1' });
        await announce({ type: 'system_announcement', title: 'Second', body: 'Body second', severity: 'info', noticeId: 'f2' });
        const first = await screen.findByRole('alertdialog', { name: 'First' });
        expect(first).toHaveFocus();
        fireEvent.click(within(first).getByRole('button', { name: 'Acknowledge' }));
        const second = await screen.findByRole('alertdialog', { name: 'Second' });
        // A new dialog for the next alert (keyed on it), so a screen reader announces it as a new one.
        expect(second).not.toBe(first);
        expect(second).toHaveFocus();
    });

    it.each([
        ['arrive live', async () => {
            await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
            await announce({ type: 'system_announcement', title: 'Second', body: 'Body second', severity: 'info', noticeId: 'k2' });
        }],
        ['come from the open\'s read', async (answer: (n: KeptNotice[]) => void) => {
            await act(async () => answer([{ ...notice('k1'), title: 'First' }, { ...notice('k2'), title: 'Second' }]));
        }],
    ] as const)('a member typing when alerts %s: Space and Enter put nothing away, and Acknowledge is one Tab away', async (_, arrive) => {
        let answer: (n: KeptNotice[]) => void = () => {};
        vi.mocked(api.getUnseenNotices).mockReturnValue(new Promise(r => { answer = r; }));
        const user = userEvent.setup();
        render(
            <>
                <textarea aria-label="Message" />
                <Alerts memberPubkey="me" isGuest={false} />
            </>,
        );
        const box = screen.getByRole('textbox', { name: 'Message' });
        await user.click(box);
        await user.keyboard('hello');
        await arrive(answer);
        const first = await screen.findByRole('alertdialog', { name: 'First' });

        // Still typing: a Space, an Enter (which sends in the event chat), and the rest of the sentence.
        await user.keyboard(' ');
        await user.keyboard('{Enter}');
        await user.keyboard('see you soon');
        await new Promise(r => setTimeout(r, 20));
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog', { name: 'First' })).toBe(first);
        expect(within(first).getByTestId('system-alert-count')).toHaveTextContent('1 of 2');

        // Acknowledge is one Tab away, and pressing it there puts the first away, once.
        await user.tab();
        expect(within(first).getByRole('button', { name: 'Acknowledge' })).toHaveFocus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(markedIds()).toEqual([['k1']]));
        expect(await screen.findByRole('alertdialog', { name: 'Second' })).toHaveFocus();
    });

    it('reads nothing for a guest, before the membership check answers, or with no identity', async () => {
        const { rerender } = render(<Alerts memberPubkey="me" isGuest={true} />);
        rerender(<Alerts memberPubkey="me" isGuest={null} />);
        rerender(<Alerts memberPubkey={null} isGuest={false} />);
        await new Promise(r => setTimeout(r, 20));
        expect(api.getUnseenNotices).not.toHaveBeenCalled();
        rerender(<Alerts memberPubkey="me" isGuest={false} />);
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
    });

    it('another member on this browser starts from nothing', async () => {
        vi.mocked(api.getUnseenNotices).mockResolvedValue([notice('first-member')]);
        const { rerender } = render(<Alerts memberPubkey="me" isGuest={false} />);
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Body first-member');
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        rerender(<Alerts memberPubkey="someone-else" isGuest={false} />);
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });

    it('each severity has its own heading and button colours (index.css), and one the app does not know is drawn as info', async () => {
        render(<Alerts memberPubkey="me" isGuest={false} />);
        for (const [severity, drawn] of [['critical', 'critical'], ['warning', 'warning'], ['info', 'info'], ['urgent', 'info']]) {
            await announce({ type: 'system_announcement', title: `A ${severity}`, body: 'Body', severity });
            const dialog = await screen.findByRole('alertdialog', { name: `A ${severity}` });
            expect(within(dialog).getByRole('heading').style.color).toBe(`var(--alert-${drawn}-ink)`);
            expect(within(dialog).getByRole('button', { name: 'Acknowledge' }).style.background).toBe(`var(--alert-${drawn}-fill)`);
            await acknowledge();
            await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        }
    });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const afterTheGuard = () => sleep(PRESS_GUARD_MS + 50);

describe('SystemAlerts: put away on purpose, and modal while it shows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.announce = [];
        hooks.socketOpen = [];
        vi.mocked(api.getUnseenNotices).mockResolvedValue([]);
        vi.mocked(api.markNoticesSeen).mockResolvedValue({ success: true, marked: 1 });
    });

    it('a Tab while typing lands on Acknowledge: the rest of the sentence puts nothing away, and after a second Tab and Enter mark it once', async () => {
        const user = userEvent.setup();
        render(
            <>
                <input aria-label="Title" />
                <input aria-label="Price" />
                <SystemAlerts memberPubkey="me" isGuest={false} />
            </>,
        );
        await waitFor(() => expect(api.getUnseenNotices).toHaveBeenCalledTimes(1));
        await user.click(screen.getByRole('textbox', { name: 'Title' }));
        await user.keyboard('Honey');
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
        const dialog = await screen.findByRole('alertdialog', { name: 'First' });

        // The member meant to go on to Price. The Tab lands on Acknowledge, and they type on, Space and all.
        await user.tab();
        const ack = within(dialog).getByRole('button', { name: 'Acknowledge' });
        expect(ack).toHaveFocus();
        await user.keyboard('Fresh eggs');
        await sleep(20);
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog', { name: 'First' })).toBe(dialog);
        expect(screen.getByRole('textbox', { name: 'Price' })).toHaveValue('');

        // A second later, on purpose: Tab stays on the alert's one button, and Enter puts it away, once.
        await afterTheGuard();
        await user.tab();
        expect(ack).toHaveFocus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(markedIds()).toEqual([['k1']]));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        await sleep(20);
        expect(markedIds()).toEqual([['k1']]);
    });

    it('still typing a second later: a Space right after a letter puts nothing away; after a pause it does', async () => {
        const user = userEvent.setup();
        render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
        const dialog = await screen.findByRole('alertdialog', { name: 'First' });
        await afterTheGuard();
        await user.tab();
        expect(within(dialog).getByRole('button', { name: 'Acknowledge' })).toHaveFocus();
        await user.keyboard('ok ');
        await sleep(20);
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog', { name: 'First' })).toBe(dialog);

        await afterTheGuard();
        await user.keyboard(' ');
        await waitFor(() => expect(markedIds()).toEqual([['k1']]));
    });

    it('a tap in an alert\'s first second does nothing, so a double tap puts one alert away, not the next one too; Close all waits its second', async () => {
        render(<SystemAlerts memberPubkey="me" isGuest={false} />);
        for (const id of ['k1', 'k2', 'k3']) {
            await announce({ type: 'system_announcement', title: `Title ${id}`, body: `Body ${id}`, severity: 'info', noticeId: id });
        }
        const first = await screen.findByRole('alertdialog', { name: 'Title k1' });
        fireEvent.click(within(first).getByRole('button', { name: 'Acknowledge' }));
        await sleep(20);
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog', { name: 'Title k1' })).toBe(first);

        await afterTheGuard();
        fireEvent.click(within(first).getByRole('button', { name: 'Acknowledge' }));
        const second = await screen.findByRole('alertdialog', { name: 'Title k2' });
        // The double tap's second tap, on the next alert's buttons.
        fireEvent.click(within(second).getByRole('button', { name: 'Acknowledge' }));
        fireEvent.click(within(second).getByRole('button', { name: 'Close all 2' }));
        await sleep(20);
        expect(markedIds()).toEqual([['k1']]);
        expect(screen.getByRole('alertdialog', { name: 'Title k2' })).toBe(second);
        expect(within(second).getByText('1 of 2')).toBeInTheDocument();

        await afterTheGuard();
        fireEvent.click(within(second).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        await waitFor(() => expect(markedIds()).toEqual([['k1'], ['k2', 'k3']]));
    });

    it('Tab and Shift+Tab go round the alert\'s buttons and never out to the page behind it; focus put outside comes back', async () => {
        const user = userEvent.setup();
        render(
            <>
                <button type="button">Before</button>
                <Alerts memberPubkey="me" isGuest={false} />
                <button type="button">After</button>
            </>,
        );
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
        await announce({ type: 'system_announcement', title: 'Second', body: 'Body second', severity: 'info', noticeId: 'k2' });
        const dialog = await screen.findByRole('alertdialog', { name: 'First' });
        const ack = within(dialog).getByRole('button', { name: 'Acknowledge' });
        const closeAll = within(dialog).getByRole('button', { name: 'Close all 2' });
        expect(dialog).toHaveFocus();

        // From the alert itself, Shift+Tab goes to its last button, not to "Before".
        await user.tab({ shift: true });
        expect(closeAll).toHaveFocus();
        await user.tab();
        expect(ack).toHaveFocus();
        await user.tab();
        expect(closeAll).toHaveFocus();
        await user.tab();
        expect(ack).toHaveFocus();
        await user.tab({ shift: true });
        expect(closeAll).toHaveFocus();
        await user.tab({ shift: true });
        expect(ack).toHaveFocus();

        act(() => screen.getByRole('button', { name: 'After' }).focus());
        expect(dialog).toHaveFocus();
        expect(api.markNoticesSeen).not.toHaveBeenCalled();
    });

    it('when the last alert is put away, focus goes back to where the member was', async () => {
        const user = userEvent.setup();
        render(
            <>
                <textarea aria-label="Message" />
                <Alerts memberPubkey="me" isGuest={false} />
            </>,
        );
        const box = screen.getByRole('textbox', { name: 'Message' });
        await user.click(box);
        await user.keyboard('hello');
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
        await announce({ type: 'system_announcement', title: 'Second', body: 'Body second', severity: 'info', noticeId: 'k2' });
        const first = await screen.findByRole('alertdialog', { name: 'First' });
        expect(first).toHaveFocus();
        fireEvent.click(within(first).getByRole('button', { name: 'Acknowledge' }));
        // Not between two alerts: the next one takes focus.
        expect(await screen.findByRole('alertdialog', { name: 'Second' })).toHaveFocus();
        await acknowledge();
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(box).toHaveFocus();
        await user.keyboard(' again');
        expect(box).toHaveValue('hello again');

        // Close all does the same.
        await announce({ type: 'system_announcement', title: 'Third', body: 'Body third', severity: 'info', noticeId: 'k3' });
        await announce({ type: 'system_announcement', title: 'Fourth', body: 'Body fourth', severity: 'info', noticeId: 'k4' });
        const third = await screen.findByRole('alertdialog', { name: 'Third' });
        expect(third).toHaveFocus();
        fireEvent.click(within(third).getByRole('button', { name: 'Close all 2' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(box).toHaveFocus();
    });

    it('when the member\'s place has gone while the alert showed, nothing breaks and focus stays where it falls', async () => {
        const Page = ({ search }: { search: boolean }) => (
            <>
                {search && <input aria-label="Search" />}
                <Alerts memberPubkey="me" isGuest={false} />
            </>
        );
        const { rerender } = render(<Page search />);
        act(() => screen.getByRole('textbox', { name: 'Search' }).focus());
        await announce({ type: 'system_announcement', title: 'First', body: 'Body first', severity: 'info', noticeId: 'k1' });
        await screen.findByRole('alertdialog', { name: 'First' });
        // The page behind changed while the alert showed: the search box is gone.
        rerender(<Page search={false} />);
        expect(screen.getByRole('alertdialog', { name: 'First' })).toBeInTheDocument();
        await acknowledge();
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(document.activeElement).toBe(document.body);
    });
});
