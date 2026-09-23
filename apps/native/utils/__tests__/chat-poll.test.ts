/**
 * The refresh lifecycle every chat screen now shares (utils/chat-poll).
 *
 * The bug this guards: the group, enterprise and event chats polled the node every fifteen seconds from
 * mount to unmount — while the chat sat behind another screen, and while the app was in a pocket. Each of
 * these cases is one of those wasted requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChatPoll } from '../chat-poll';

/** The chats' real cadence. */
const EVERY = 15000;

describe('createChatPoll', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('loads once as soon as the chat is focused and the app is active, then on the interval', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);

        poll.setAppActive(true);
        poll.setFocused(true);
        expect(load).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(EVERY * 3);
        expect(load).toHaveBeenCalledTimes(4);
    });

    it('does not fetch while the screen is blurred', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        load.mockClear();

        poll.setFocused(false);
        expect(poll.isPolling()).toBe(false);
        vi.advanceTimersByTime(EVERY * 10);
        expect(load).not.toHaveBeenCalled();
    });

    it('does not fetch while the app is in the background', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        load.mockClear();

        poll.setAppActive(false);
        expect(poll.isPolling()).toBe(false);
        vi.advanceTimersByTime(EVERY * 10);
        expect(load).not.toHaveBeenCalled();
    });

    it('never starts while the app is backgrounded, even on a freshly opened chat', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);

        poll.setAppActive(false);
        poll.setFocused(true);
        vi.advanceTimersByTime(EVERY * 10);
        expect(load).not.toHaveBeenCalled();
    });

    it('does one immediate load when the screen comes back into focus', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        poll.setFocused(false);
        vi.advanceTimersByTime(EVERY * 4);
        load.mockClear();

        poll.setFocused(true);
        expect(load).toHaveBeenCalledTimes(1);
        // ...and not a backlog of the ticks that were skipped while away.
        vi.advanceTimersByTime(EVERY - 1);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('does one immediate load when the app comes back to the foreground', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        poll.setAppActive(false);
        vi.advanceTimersByTime(EVERY * 4);
        load.mockClear();

        poll.setAppActive(true);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('needs both: focus alone, or foreground alone, fetches nothing', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);

        poll.setFocused(true);
        vi.advanceTimersByTime(EVERY * 3);
        expect(load).not.toHaveBeenCalled();

        poll.setFocused(false);
        poll.setAppActive(true);
        vi.advanceTimersByTime(EVERY * 3);
        expect(load).not.toHaveBeenCalled();
    });

    it('a repeated focus or foreground event does not start a second timer or refetch', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        expect(load).toHaveBeenCalledTimes(1);

        poll.setFocused(true);
        poll.setAppActive(true);
        expect(load).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(EVERY);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('stop() ends the poll for good — leaving the screen stops the requests', () => {
        const load = vi.fn();
        const poll = createChatPoll(load, EVERY);
        poll.setAppActive(true);
        poll.setFocused(true);
        load.mockClear();

        poll.stop();
        expect(poll.isPolling()).toBe(false);
        vi.advanceTimersByTime(EVERY * 10);
        expect(load).not.toHaveBeenCalled();
    });
});
