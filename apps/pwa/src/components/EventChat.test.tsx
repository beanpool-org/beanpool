import { render, screen, fireEvent, waitFor, createEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventChat, decodeEventChatText } from './EventChat';
import { EventDetail } from './EventCard';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getEventChat: vi.fn(),
        postEventChatMessage: vi.fn(),
        removeEventChatMessage: vi.fn(),
        rsvpEvent: vi.fn(),
        removeMarketplacePost: vi.fn(),
    };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

function message(over: Partial<api.EventThreadMessage> = {}): api.EventThreadMessage {
    return {
        id: 'm1', conversationId: 'ev-1', authorPubkey: 'goer-pk', authorCallsign: 'Goer',
        authorAvatar: null, ciphertext: b64('Bringing a thermos'), nonce: 'plaintext-v1',
        type: 'text', timestamp: new Date(2030, 8, 27, 10, 0).toISOString(), ...over,
    } as api.EventThreadMessage;
}

function view(over: Partial<api.EventThreadView> = {}): api.EventThreadView {
    return {
        conversation: { id: 'ev-1', type: 'event_thread', name: 'Working bee', participants: [], createdBy: 'host-pk', createdAt: '' } as any,
        messages: [message()],
        readOnly: false,
        readOnlyReason: null,
        canPost: true,
        isHost: false,
        title: 'Working bee',
        eventEndAt: new Date(2030, 8, 28, 12, 0).toISOString(),
        eventState: 'scheduled',
        privateNote: null,
        notice: "Visible to the host, everyone going, and this node's operator.",
        ...over,
    };
}

/** The floor the design holds to: a 320px-wide screen at 130% text. */
function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

describe('EventChat (docs/events-on-the-map.md §2.2, §3)', () => {
    beforeEach(() => {
        vi.mocked(api.getEventChat).mockReset();
        vi.mocked(api.postEventChatMessage).mockReset();
        vi.mocked(api.removeEventChatMessage).mockReset();
        window.confirm = () => true;
    });
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('reads node-readable plaintext-v1 and shows the message with its author', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect(await screen.findByText('Bringing a thermos')).toBeTruthy();
        expect(screen.getByText('Goer')).toBeTruthy();
        expect(decodeEventChatText(b64('hello'), 'text')).toBe('hello');
    });

    it('pins the private note above the messages and never as a message', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({ privateNote: 'Gate code 1234' }));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const note = await screen.findByTestId('event-chat-pinned-note');
        expect(note.textContent).toContain('Gate code 1234');
        // Pinned means it does not scroll with the list: it is a sibling of the scroller, outside it.
        expect(note.className).toMatch(/flex-shrink-0/);
        expect(note.querySelector('li')).toBeNull();
        expect(screen.getAllByRole('listitem').length).toBe(1);
    });

    it('carries the one line that says the node can read this chat', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect((await screen.findByTestId('event-chat-notice')).textContent)
            .toBe("Visible to the host, everyone going, and this node's operator.");
    });

    it('sends a message and reloads the chat', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        vi.mocked(api.postEventChatMessage).mockResolvedValue({ success: true, message: message({ id: 'm2' }) });
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const box = await screen.findByLabelText('Message everyone going');
        fireEvent.change(box, { target: { value: '  See you there  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(api.postEventChatMessage).toHaveBeenCalledWith('ev-1', 'See you there'));
        await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
        expect(vi.mocked(api.getEventChat).mock.calls.length).toBeGreaterThan(1);
    });

    it('holds the composer to 2000 characters, the same cap the node applies', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const box = await screen.findByLabelText('Message everyone going') as HTMLTextAreaElement;
        expect(box.maxLength).toBe(2000);
        fireEvent.change(box, { target: { value: 'x'.repeat(2500) } });
        expect(box.value.length).toBe(2000);
    });

    it('goes read-only when the event has ended: the banner says so and the composer is gone', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            readOnly: true, canPost: false, readOnlyReason: 'This event has ended. The chat is read-only.',
        }));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect((await screen.findByTestId('event-chat-readonly')).textContent)
            .toBe('This event has ended. The chat is read-only.');
        expect(screen.queryByLabelText('Message everyone going')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('says the event was cancelled when that is why it is read-only', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            readOnly: true, canPost: false, eventState: 'cancelled',
            readOnlyReason: 'This event was cancelled. The chat is read-only.',
        }));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect((await screen.findByTestId('event-chat-readonly')).textContent)
            .toBe('This event was cancelled. The chat is read-only.');
    });

    it('offers Remove to the host only, and shows a removed message as removed', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        const { unmount } = renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect(await screen.findByText('Bringing a thermos')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Remove message/ })).toBeNull();
        unmount();

        vi.mocked(api.getEventChat).mockResolvedValue(view({ isHost: true }));
        vi.mocked(api.removeEventChatMessage).mockResolvedValue({ success: true, message: message({ type: 'removed' }) });
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove message from Goer' }));
        await waitFor(() => expect(api.removeEventChatMessage).toHaveBeenCalledWith('ev-1', 'm1'));
        expect(decodeEventChatText(b64('anything'), 'removed')).toBe('removed by the host');
    });

    it('says why when the node refuses the chat, rather than showing an empty room', async () => {
        vi.mocked(api.getEventChat).mockRejectedValue(new Error('Only the host and people going can open this event chat'));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        expect((await screen.findByTestId('event-chat-error')).textContent)
            .toBe('Only the host and people going can open this event chat');
    });

    it('keeps every control at 48px and the header truncating at 320px', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({ isHost: true, title: 'Working bee at the hall — bring gloves and a long-handled shovel' }));
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} onBack={() => {}} />);
        const title = await screen.findByText(/Working bee at the hall/);
        expect(title.className).toMatch(/truncate/);
        for (const name of ['Back', 'Send', 'Remove message from Goer']) {
            expect(screen.getByRole('button', { name }).className).toMatch(/min-h-\[48px\]/);
        }
        expect((screen.getByLabelText('Message everyone going') as HTMLElement).className).toMatch(/min-h-\[48px\]/);
    });
});

describe('EventDetail chat entry (docs/events-on-the-map.md §3)', () => {
    const baseEvent: any = {
        id: 'ev-1', type: 'event', title: 'Working bee', description: '', credits: 0, priceType: 'fixed',
        authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(),
        active: true, status: 'active', lat: -28.55, lng: 153.5,
        eventStartAt: new Date(Date.now() + 86400000).toISOString(),
        eventEndAt: new Date(Date.now() + 90000000).toISOString(),
        eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
    };

    it('offers the chat to someone going, labelled plainly — no number that reads as unread messages (B3)', () => {
        const onOpenChat = vi.fn();
        render(<EventDetail post={baseEvent} identity={identity} onOpenChat={onOpenChat} />);
        const btn = screen.getByTestId('event-open-chat');
        expect(btn.textContent).toBe('💬 Open event chat');
        expect(btn.textContent).not.toMatch(/\d/);
        fireEvent.click(btn);
        expect(onOpenChat).toHaveBeenCalledWith(baseEvent);
    });

    it('offers it to the host, who need not have RSVPd', () => {
        render(<EventDetail post={{ ...baseEvent, myRsvp: null, eventRsvps: [] }} identity={identity} onOpenChat={vi.fn()} />);
        expect(screen.getByTestId('event-open-chat')).toBeTruthy();
    });

    it('does not offer it to someone who is only Interested, or to nobody', () => {
        const { unmount } = render(<EventDetail post={{ ...baseEvent, myRsvp: 'interested' }} identity={identity} onOpenChat={vi.fn()} />);
        expect(screen.queryByTestId('event-open-chat')).toBeNull();
        unmount();
        render(<EventDetail post={{ ...baseEvent, myRsvp: null }} identity={identity} onOpenChat={vi.fn()} />);
        expect(screen.queryByTestId('event-open-chat')).toBeNull();
    });
});

describe('EventChat: the way back to the event (A4)', () => {
    it('carries a View event button in the header, so a cancelled or ended event can still be opened', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            readOnly: true, canPost: false, eventState: 'cancelled',
            readOnlyReason: 'This event was cancelled. The chat is read-only.',
        }));
        const onOpenEvent = vi.fn();
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} onOpenEvent={onOpenEvent} />);
        const btn = await screen.findByTestId('event-chat-open-event');
        expect(btn.textContent).toBe('View event');
        expect(btn.className).toMatch(/min-h-\[48px\]/);
        fireEvent.click(btn);
        expect(onOpenEvent).toHaveBeenCalledTimes(1);
    });
});

describe('EventChat: an event chat carries no photos', () => {
    function pictureClipboard() {
        const file = new File([new Uint8Array(1)], 'screenshot.png', { type: 'image/png' });
        return {
            files: [file],
            items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
            types: ['Files'],
        };
    }

    beforeEach(() => {
        vi.mocked(api.getEventChat).mockReset();
        vi.mocked(api.postEventChatMessage).mockReset();
        vi.mocked(api.getEventChat).mockResolvedValue(view() as any);
    });

    it('a pasted picture says so in one line and posts nothing', async () => {
        render(<EventChat postId="ev-1" identity={identity} />);
        const composer = await screen.findByLabelText('Message everyone going');

        fireEvent.paste(composer, { clipboardData: pictureClipboard() });

        expect(await screen.findByTestId('event-chat-image-notice'))
            .toHaveTextContent('Photos can only be sent in direct messages');
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
    });

    it('a dropped picture does the same', async () => {
        render(<EventChat postId="ev-1" identity={identity} />);
        const composer = await screen.findByLabelText('Message everyone going');

        fireEvent.drop(composer, { dataTransfer: pictureClipboard() });

        expect(await screen.findByTestId('event-chat-image-notice'))
            .toHaveTextContent('Photos can only be sent in direct messages');
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
    });

    it('a dropped file that is not a picture is swallowed, not opened by the browser', async () => {
        render(<EventChat postId="ev-1" identity={identity} />);
        const composer = await screen.findByLabelText('Message everyone going');
        const pdf = new File([new Uint8Array(1)], 'minutes.pdf', { type: 'application/pdf' });

        // onDragOver took this drop, so onDrop owes it a preventDefault —
        // otherwise the browser navigates the tab to the file and the event,
        // the chat and the unsent draft all go with it.
        const drop = createEvent.drop(composer, {
            dataTransfer: {
                files: [pdf],
                items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => pdf }],
                types: ['Files'],
            },
        });
        fireEvent(composer, drop);

        expect(drop.defaultPrevented).toBe(true);
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
    });

    it('a text-only drop is left to the composer: nothing is prevented', async () => {
        render(<EventChat postId="ev-1" identity={identity} />);
        const composer = await screen.findByLabelText('Message everyone going');

        const drop = createEvent.drop(composer, {
            dataTransfer: { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'] },
        });
        fireEvent(composer, drop);

        expect(drop.defaultPrevented).toBe(false);
        expect(screen.queryByTestId('event-chat-image-notice')).not.toBeInTheDocument();
    });

    it('a text-only paste is left alone', async () => {
        render(<EventChat postId="ev-1" identity={identity} />);
        const composer = await screen.findByLabelText('Message everyone going');

        fireEvent.paste(composer, {
            clipboardData: { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'] },
        });

        expect(screen.queryByTestId('event-chat-image-notice')).not.toBeInTheDocument();
    });
});

describe('EventChat: the keyboard sends, not only the mouse', () => {
    beforeEach(() => {
        vi.mocked(api.getEventChat).mockReset();
        vi.mocked(api.postEventChatMessage).mockReset();
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        vi.mocked(api.postEventChatMessage).mockResolvedValue({ success: true, message: message({ id: 'm2' }) });
    });

    async function composer() {
        renderAt320(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        return await screen.findByLabelText('Message everyone going') as HTMLTextAreaElement;
    }

    it('Enter sends the message, once, without touching the Send button', async () => {
        const box = await composer();
        fireEvent.change(box, { target: { value: '  See you there  ' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        await waitFor(() => expect(api.postEventChatMessage).toHaveBeenCalledWith('ev-1', 'See you there'));
        expect(vi.mocked(api.postEventChatMessage).mock.calls.length).toBe(1);
        await waitFor(() => expect(box.value).toBe(''));
    });

    it('Shift+Enter is a newline, not a send', async () => {
        const box = await composer();
        fireEvent.change(box, { target: { value: 'first line' } });
        fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
        await Promise.resolve();
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
        // The draft is still the person's to finish.
        expect(box.value).toBe('first line');
    });

    it('Enter while an input method is composing never sends: it is picking characters', async () => {
        const box = await composer();
        fireEvent.change(box, { target: { value: 'にほんご' } });
        fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
        // Safari and older browsers say the same thing with keyCode 229.
        fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
        await Promise.resolve();
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
        expect(box.value).toBe('にほんご');
    });

    it('Enter on an empty draft sends nothing', async () => {
        const box = await composer();
        fireEvent.keyDown(box, { key: 'Enter' });
        fireEvent.change(box, { target: { value: '   ' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        await Promise.resolve();
        expect(api.postEventChatMessage).not.toHaveBeenCalled();
    });
});

describe('EventChat: the no-photos line does not stay pinned', () => {
    function pictureClipboard() {
        const file = new File([new Uint8Array(1)], 'screenshot.png', { type: 'image/png' });
        return {
            files: [file],
            items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
            types: ['Files'],
        };
    }

    beforeEach(() => {
        vi.mocked(api.getEventChat).mockReset();
        vi.mocked(api.postEventChatMessage).mockReset();
        vi.mocked(api.getEventChat).mockResolvedValue(view() as any);
        vi.mocked(api.postEventChatMessage).mockResolvedValue({} as any);
    });

    async function pasteAPicture() {
        const composer = await screen.findByLabelText('Message everyone going');
        fireEvent.paste(composer, { clipboardData: pictureClipboard() });
        expect(await screen.findByTestId('event-chat-image-notice'))
            .toHaveTextContent('Photos can only be sent in direct messages');
        return composer;
    }

    it('the person can dismiss it', async () => {
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        await pasteAPicture();

        const dismiss = screen.getByLabelText('Dismiss');
        expect(dismiss.className).toMatch(/min-h-\[48px\]/);
        fireEvent.click(dismiss);

        await waitFor(() => expect(screen.queryByTestId('event-chat-image-notice')).not.toBeInTheDocument());
    });

    it('sending a message clears it', async () => {
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const composer = await pasteAPicture();

        fireEvent.change(composer, { target: { value: 'Bringing a thermos' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(api.postEventChatMessage).toHaveBeenCalledWith('ev-1', 'Bringing a thermos'));
        await waitFor(() => expect(screen.queryByTestId('event-chat-image-notice')).not.toBeInTheDocument());
    });

    it('a failed send leaves it alone', async () => {
        vi.mocked(api.postEventChatMessage).mockRejectedValue(new Error('Node said no.'));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const composer = await pasteAPicture();

        fireEvent.change(composer, { target: { value: 'Bringing a thermos' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(await screen.findByText('Node said no.')).toBeInTheDocument();
        expect(screen.getByTestId('event-chat-image-notice'))
            .toHaveTextContent('Photos can only be sent in direct messages');
    });

    it('moving to another event drops it', async () => {
        const { rerender } = render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        await pasteAPicture();

        rerender(<EventChat postId="ev-2" identity={identity} refreshMs={0} />);

        await waitFor(() => expect(screen.queryByTestId('event-chat-image-notice')).not.toBeInTheDocument());
    });
});

/**
 * The poll stops while nobody is looking.
 *
 * An event chat left open in a background tab used to keep pulling a page of messages every twelve seconds
 * for as long as the browser stayed open — the one poller in this app that ignored `document.hidden`. Most of
 * our members pay for that data on an old phone.
 */
describe('EventChat: the refresh pauses while the tab is hidden', () => {
    const REFRESH = 12000;
    let hidden = false;

    beforeEach(() => {
        vi.mocked(api.getEventChat).mockReset();
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (document as any).hidden;
    });

    /** What the browser does when the tab goes behind another, or the phone locks. */
    const setHidden = async (next: boolean) => {
        hidden = next;
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    };

    /** Advance the clock and let every load this fired settle, so React never updates outside act(). */
    const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

    const open = async () => {
        const rendered = render(<EventChat postId="ev-1" identity={identity} refreshMs={REFRESH} />);
        await act(async () => { });
        return rendered;
    };

    it('keeps refreshing while the tab is visible', async () => {
        await open();
        expect(api.getEventChat).toHaveBeenCalledTimes(1);

        await tick(REFRESH * 2);
        expect(api.getEventChat).toHaveBeenCalledTimes(3);
    });

    it('asks the node for nothing while the tab is hidden', async () => {
        await open();
        vi.mocked(api.getEventChat).mockClear();

        await setHidden(true);
        await tick(REFRESH * 10);
        expect(api.getEventChat).not.toHaveBeenCalled();
    });

    it('loads once, straight away, when the tab comes back', async () => {
        await open();
        await setHidden(true);
        await tick(REFRESH * 5);
        vi.mocked(api.getEventChat).mockClear();

        await setHidden(false);
        expect(api.getEventChat).toHaveBeenCalledTimes(1);

        // One load, not a backlog of the ticks that were skipped while it was hidden.
        await tick(REFRESH - 1);
        expect(api.getEventChat).toHaveBeenCalledTimes(1);

        await tick(1);
        expect(api.getEventChat).toHaveBeenCalledTimes(2);
    });

    it('stops for good when the chat is closed', async () => {
        const { unmount } = await open();
        vi.mocked(api.getEventChat).mockClear();

        unmount();
        await tick(REFRESH * 10);
        expect(api.getEventChat).not.toHaveBeenCalled();
    });
});
