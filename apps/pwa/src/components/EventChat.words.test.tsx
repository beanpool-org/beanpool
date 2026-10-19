/**
 * An event's chat in the member's language (words S3, web sweep W1): the header, the pinned note's label, the empty
 * lines, the host's Remove, the composer and the no-photos line through t(), with the phone's EventChatView keys; a
 * message's time through core's formatDate ("28 Sep, 9:00"). The messages, the note, the event's title and the members'
 * names are theirs; the read-only reason and the notice under the chat are the node's own lines, shown as it wrote them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EventChat } from './EventChat';
import * as api from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(async () => ({ success: true })) };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const NOTICE = "Visible to the host, everyone going, and this node's operator.";
const READ_ONLY = 'This event has ended. The chat is read-only.';

function message(over: Partial<api.EventThreadMessage> = {}): api.EventThreadMessage {
    return {
        id: 'm1', conversationId: 'ev-1', authorPubkey: 'goer-pk', authorCallsign: 'Goer', authorAvatar: 'bundled://leaf',
        ciphertext: b64('Bringing a thermos'), nonce: 'plaintext-v1', type: 'text',
        timestamp: new Date(2030, 8, 28, 9, 5).toISOString(), ...over,
    } as api.EventThreadMessage;
}

function view(over: Partial<api.EventThreadView> = {}): api.EventThreadView {
    return {
        conversation: { id: 'ev-1', type: 'event_thread', name: 'Working bee', participants: [], createdBy: 'host-pk', createdAt: '' } as any,
        messages: [message(), message({ id: 'm2', type: 'removed', ciphertext: '' })],
        readOnly: false, readOnlyReason: null, canPost: true, isHost: true, title: 'Working bee',
        eventEndAt: new Date(2030, 8, 28, 12, 0).toISOString(), eventState: 'scheduled',
        privateNote: 'Gate code 1234', notice: NOTICE, ...over,
    };
}

/** What members wrote (the event's title, the note, a message, a name), and the node's own lines, shown as written. */
const OTHERS = ['Working bee', 'Gate code 1234', 'Bringing a thermos', 'Goer', NOTICE, READ_ONLY];

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    vi.mocked(api.getEventChat).mockReset();
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('an event chat in the pseudo-locale', () => {
    it("the host's chat: the note, the messages and their times, Remove and its question, the no-photos line", async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        await showIn('xx');
        const said: string[] = [];
        vi.spyOn(window, 'confirm').mockImplementation((q) => { said.push(String(q)); return true; });
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} onBack={vi.fn()} onOpenEvent={vi.fn()} />);
        expect(await screen.findByText('Bringing a thermos')).toBeInTheDocument();
        expect(screen.getByText(xx('removed by the host'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(6);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: xx('Remove message from {name}').replace('{name}', 'Goer') }));
        await waitFor(() => expect(api.removeEventChatMessage).toHaveBeenCalledWith('ev-1', 'm1'));
        expect(said).toEqual([xx('Remove this message from the event chat?')]);

        const file = new File([new Uint8Array(1)], 'shot.png', { type: 'image/png' });
        fireEvent.paste(screen.getByLabelText(xx('Message everyone going')), {
            clipboardData: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], types: ['Files'] },
        });
        expect(await screen.findByText(xx('Photos can only be sent in direct messages'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
    });

    it('opening, a chat the node would not open, and an ended one with nothing said', async () => {
        await showIn('xx');
        vi.mocked(api.getEventChat).mockReturnValue(new Promise(() => {}));
        const { unmount } = render(<EventChat postId="ev-1" identity={identity} refreshMs={0} onBack={vi.fn()} />);
        expect(screen.getByText(xx('Opening the chat…'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        unmount();

        vi.mocked(api.getEventChat).mockRejectedValue(new Error(''));
        const second = render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect((await screen.findByTestId('event-chat-error')).textContent).toBe(xx('Could not open this event chat.'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        second.unmount();

        vi.mocked(api.getEventChat).mockResolvedValue(view({ messages: [], readOnly: true, readOnlyReason: READ_ONLY, canPost: false, privateNote: null }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect(await screen.findByText(xx('Nothing was said here.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('an event chat in English', () => {
    it('in English nothing is bracketed, and the words are as they were; the time reads "28 Sep, 9:05"', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} onBack={vi.fn()} onOpenEvent={vi.fn()} />);
        expect(await screen.findByText('Bringing a thermos')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByTestId('event-chat-pinned-note').querySelector('p')!.textContent).toBe('📌 Note for people who are going');
        expect(screen.getAllByText('28 Sep, 9:05')).toHaveLength(2);
        expect(screen.getByText('removed by the host')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove message from Goer' }).textContent).toBe('Remove');
        expect(screen.getByPlaceholderText('Message everyone going…')).toBeInTheDocument();
        expect(screen.getByTestId('event-chat-open-event').textContent).toBe('View event');
        expect(screen.getByText('Event chat')).toBeInTheDocument();
    });
});
