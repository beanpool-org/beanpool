import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
