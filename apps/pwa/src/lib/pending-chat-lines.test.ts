// @vitest-environment jsdom
/**
 * The store of lines this tab is sending, on its own: a line's lifetime, the order lines go in, how long one may go
 * unanswered, and what the next line is written after. The chat page's side, with real crypto, is
 * pages/MessagesPage.pending-lines.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderHook, act } from '@testing-library/react';
import {
    SEND_BOUND_MS, chatSettled, discardChatLine, forgetLinesWithRows, lineAfter, noteChatOnScreen, noteChatRead, resetPendingChatLinesForTest,
    retryChatLine, sendChatLine, usePendingChatLines, type NewChatLine, type SendChatLine,
} from './pending-chat-lines';

const line = (id: string, conversationId = 'chat-a', text = `words of ${id}`): NewChatLine => ({ id, conversationId, owner: 'me', text, replyToId: null });
const held = () => { const { result } = renderHook(() => usePendingChatLines()); return result; };
const never: SendChatLine = () => new Promise(() => {});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
    resetPendingChatLinesForTest();
    noteChatOnScreen('chat-a');
    vi.useFakeTimers();
    window.alert = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

describe('a stalled send', () => {
    it('ends as failed once the bound has passed, and never before', async () => {
        const lines = held();
        act(() => sendChatLine(line('l1'), never));
        await flush();
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS - 1); });
        expect(lines.current[0].state).toBe('sending');
        act(() => { vi.advanceTimersByTime(1); });
        expect(lines.current[0].state).toBe('failed');
        expect(lines.current[0].refused).toBe(false);
    });

    it('asks for a read of its chat when it ends: only its answer may have been lost', async () => {
        const read = vi.fn();
        noteChatOnScreen('chat-a', read);
        act(() => sendChatLine(line('l1'), never));
        await flush();
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('holds up no other chat, and the line behind it in its own chat goes when it has ended', async () => {
        const held = vi.fn(async () => 'taken' as const);
        const other = vi.fn(async () => 'taken' as const);
        act(() => {
            sendChatLine(line('stalled'), never);
            sendChatLine(line('behind'), held);
            sendChatLine(line('elsewhere', 'chat-b'), other);
        });
        await flush();
        expect(other).toHaveBeenCalledTimes(1);
        expect(held).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        await flush();
        expect(held).toHaveBeenCalledTimes(1);
    });

    it('that the node answers after the bound was taken after all: its line is not left failed', async () => {
        const lines = held();
        let answer!: (a: 'taken') => void;
        act(() => sendChatLine(line('late'), () => new Promise((r) => { answer = r; })));
        await flush();
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        expect(lines.current[0].state).toBe('failed');
        await act(async () => { answer('taken'); });
        expect(lines.current[0]).toMatchObject({ state: 'sending', taken: true });
    });
});

describe('a line the node took', () => {
    it('stays sending until its row is on screen, with one read asked for, and says so if no row ever comes', async () => {
        const lines = held();
        const read = vi.fn();
        noteChatOnScreen('chat-a', read);
        act(() => sendChatLine(line('l1'), async () => 'taken'));
        await flush();
        expect(lines.current[0]).toMatchObject({ state: 'sending', taken: true });
        expect(read).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        expect(lines.current[0].state).toBe('failed');
    });

    it('goes at once when its chat is not open: the chat reads its row when it opens', async () => {
        const lines = held();
        noteChatOnScreen(null);
        act(() => sendChatLine(line('l1'), async () => 'taken'));
        await flush();
        expect(lines.current).toEqual([]);
    });

    it('goes without a word when its chat closes before its row comes: the chat reads it when it opens', async () => {
        const lines = held();
        act(() => sendChatLine(line('l1'), async () => 'taken'));
        await flush();
        noteChatOnScreen(null);
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        expect(lines.current).toEqual([]);
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('goes with its row, and the list only changes when a line goes', () => {
        const lines = held();
        act(() => sendChatLine(line('l1'), never));
        const before = lines.current;
        act(() => forgetLinesWithRows(['some', 'other', 'rows']));
        expect(lines.current).toBe(before);
        act(() => forgetLinesWithRows(['l1']));
        expect(lines.current).toEqual([]);
    });
});

describe('a line that fails', () => {
    it('with its chat closed says so once, however many lines, and again after the chat has been open', async () => {
        noteChatOnScreen(null);
        act(() => {
            sendChatLine(line('l1'), async () => { throw new Error('no answer'); });
            sendChatLine(line('l2'), async () => { throw new Error('no answer'); });
        });
        await flush();
        await flush();
        expect(window.alert).toHaveBeenCalledTimes(1);
        expect(window.alert).toHaveBeenCalledWith('Message not delivered');
        noteChatOnScreen('chat-a');
        noteChatOnScreen(null);
        act(() => sendChatLine(line('l3'), async () => { throw new Error('no answer'); }));
        await flush();
        expect(window.alert).toHaveBeenCalledTimes(2);
    });

    it('with its chat open says nothing out loud: the line says it', async () => {
        act(() => sendChatLine(line('l1'), async () => { throw new Error('no answer'); }));
        await flush();
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('is tried again under its own id, and a discarded one that was waiting never goes', async () => {
        const lines = held();
        act(() => sendChatLine(line('l1'), async () => { throw new Error('no answer'); }));
        await flush();
        const again = vi.fn(async () => 'taken' as const);
        act(() => retryChatLine('l1', again));
        await flush();
        expect(again).toHaveBeenCalledTimes(1);
        expect(lines.current[0].id).toBe('l1');

        const behind = vi.fn(async () => 'taken' as const);
        act(() => {
            sendChatLine(line('stalled'), never);
            sendChatLine(line('l2'), behind);
            discardChatLine('l2');
        });
        await flush();
        act(() => { vi.advanceTimersByTime(SEND_BOUND_MS); });
        await flush();
        expect(behind).not.toHaveBeenCalled();
    });

    it('sent again in the same words replaces a refused line, never one that may have reached the node', async () => {
        const lines = held();
        act(() => sendChatLine(line('refused', 'chat-a', 'same words'), async () => 'refused'));
        await flush();
        act(() => sendChatLine(line('again', 'chat-a', 'same words'), never));
        expect(lines.current.map((l) => l.id)).toEqual(['again']);

        act(() => { resetPendingChatLinesForTest(); noteChatOnScreen('chat-a'); });
        const fresh = held();
        act(() => sendChatLine(line('unknown', 'chat-a', 'same words'), async () => { throw new Error('no answer'); }));
        await flush();
        act(() => sendChatLine(line('again', 'chat-a', 'same words'), never));
        expect(fresh.current.map((l) => l.id)).toEqual(['unknown', 'again']);
    });

});

describe('what the next line is written after', () => {
    const read = (dm: string | null, group: string | null = dm) => ({ dm, group });

    it('is the last read\'s newest line, or nothing where no read of this chat has landed', () => {
        expect(lineAfter('chat-a')).toEqual({ dm: null, group: null });
        noteChatRead('chat-a', ['x'], read('x'));
        expect(lineAfter('chat-a')).toEqual({ dm: 'x', group: 'x' });
        expect(lineAfter('chat-b')).toEqual({ dm: null, group: null });
    });

    it('is the line the node just took, even when a read that started before it lands after', async () => {
        noteChatRead('chat-a', ['x'], read('x'));
        act(() => sendChatLine(line('l1'), async () => 'taken'));
        await flush();
        expect(lineAfter('chat-a').dm).toBe('l1');
        noteChatRead('chat-a', ['x'], read('x'));
        expect(lineAfter('chat-a').dm).toBe('l1');
        noteChatRead('chat-a', ['x', 'l1', 'p'], read('p'));
        expect(lineAfter('chat-a').dm).toBe('p');
    });

    it('is worked out as the line goes, after the one before it was taken', async () => {
        noteChatRead('chat-a', ['x'], read('x'));
        const after: (string | null)[] = [];
        const send = (): SendChatLine => async () => { after.push(lineAfter('chat-a').dm); return 'taken'; };
        act(() => { sendChatLine(line('l1'), send()); sendChatLine(line('l2'), send()); sendChatLine(line('l3'), send()); });
        await act(async () => { await chatSettled('chat-a'); });
        expect(after).toEqual(['x', 'l1', 'l2']);
    });
});

describe('the words these lines say', () => {
    const WEB = path.resolve(__dirname, '../../words');
    const PHONE = path.resolve(__dirname, '../../../native/words');
    const LANGS = fs.readdirSync(WEB).filter((f) => /^[A-Za-z-]+\.json$/.test(f) && f !== 'en.json');
    const catalog = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, string>;

    it('are in all 24 catalogs', () => {
        expect(LANGS).toHaveLength(24);
        for (const file of LANGS) {
            const words = catalog(WEB, file);
            for (const key of ['Sending…', 'Retry', '! not delivered', 'Discard', 'Message not delivered']) {
                expect(words[key], `${file}: ${key}`).toBeTruthy();
            }
        }
    });

    it('name the chat tab one way on phone and web, tab and page title alike, in every language', () => {
        for (const file of LANGS) {
            const phone = catalog(PHONE, file);
            expect(phone['Chat'], `${file}: the phone's page title`).toBe(phone['Chat\u0004tab']);
            expect(catalog(WEB, file)['Chat\u0004tab'], `${file}: the web's tab`).toBe(phone['Chat\u0004tab']);
        }
    });
});
