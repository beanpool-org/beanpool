/**
 * An event's chat box grows with its words like the Messages composer (fix/web-composer-grow; Marty,
 * 14 Nov 2026: "a little vertical bar showing? what is this?"). One line when empty, a line taller per
 * line of words up to five, a scrollbar only past five, one line again after a send; no drag handle,
 * since the box sizes itself. jsdom lays nothing out: composer-grow.test-support.ts does the arithmetic.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventChat } from './EventChat';
import * as api from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';
import { installTextareaGeometry, showsScrollbar, hidesWords, heightOf } from '../composer-grow.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getEventChat: vi.fn(),
        postEventChatMessage: vi.fn(),
        removeEventChatMessage: vi.fn(),
    };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

function view(): api.EventThreadView {
    return {
        conversation: { id: 'ev-1', type: 'event_thread', name: 'Working bee', participants: [], createdBy: 'host-pk', createdAt: '' } as any,
        messages: [{
            id: 'm1', conversationId: 'ev-1', authorPubkey: 'goer-pk', authorCallsign: 'Goer',
            authorAvatar: null, ciphertext: b64('Bringing a thermos'), nonce: 'plaintext-v1',
            type: 'text', timestamp: new Date(2030, 8, 27, 10, 0).toISOString(),
        } as api.EventThreadMessage],
        readOnly: false,
        readOnlyReason: null,
        canPost: true,
        isHost: false,
        title: 'Working bee',
        eventEndAt: new Date(2030, 8, 28, 12, 0).toISOString(),
        eventState: 'scheduled',
        privateNote: null,
        notice: "Visible to the host, everyone going, and this node's operator.",
    };
}

let undoGeometry: () => void = () => {};
beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    vi.mocked(api.getEventChat).mockReset();
    vi.mocked(api.postEventChatMessage).mockReset();
    vi.mocked(api.getEventChat).mockResolvedValue(view());
    undoGeometry = installTextareaGeometry();
});
afterEach(() => {
    undoGeometry();
    vi.unstubAllGlobals();
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe("An event's chat box grows with its words", () => {
    it('empty: no scrollbar; each line a line taller up to five; the sixth scrolls with a scrollbar; no drag handle', async () => {
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const box = await screen.findByLabelText('Message everyone going') as HTMLTextAreaElement;

        expect(showsScrollbar(box)).toBe(false);
        expect(hidesWords(box)).toBe(false);
        expect(box.className).toMatch(/\bresize-none\b/);
        expect(box.className).not.toMatch(/\bresize-y\b/);

        const heights: number[] = [];
        for (let n = 1; n <= 6; n++) {
            fireEvent.change(box, { target: { value: lines(n) } });
            heights.push(heightOf(box));
            expect(hidesWords(box)).toBe(false);
            expect(showsScrollbar(box)).toBe(n === 6);
        }
        for (let n = 1; n < 5; n++) expect(heights[n]).toBeGreaterThan(heights[n - 1]);
        expect(heights[5]).toBe(heights[4]);
    });

    it('after a send the box is one line again', async () => {
        vi.mocked(api.postEventChatMessage).mockResolvedValue({ success: true, message: { id: 'm2' } } as any);
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const box = await screen.findByLabelText('Message everyone going') as HTMLTextAreaElement;
        fireEvent.change(box, { target: { value: 'x' } });
        const oneLine = heightOf(box);

        fireEvent.change(box, { target: { value: lines(4) } });
        expect(heightOf(box)).toBeGreaterThan(oneLine);
        fireEvent.keyDown(box, { key: 'Enter' });

        await waitFor(() => expect(box.value).toBe(''));
        expect(heightOf(box)).toBe(oneLine);
        expect(showsScrollbar(box)).toBe(false);
    });
});
