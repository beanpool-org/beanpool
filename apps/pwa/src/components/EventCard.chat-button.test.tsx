/**
 * The event page's chat button (Marty, 16 Nov 2026: "the chat should be a little more obvious within the event card ... a
 * slightly more obvious colour? or increase the font size? ... the spacing between the chat icon and open could be a little
 * bigger"): words that say it is a chat and who is in it, the brand ink (core's ink.brand, every look), a step up in size,
 * real room between the icon and the words, and a count of the lines the member hasn't read. The phone's EventDetail has the
 * same (apps/native/utils/__tests__/event-chat-button-render.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { EventDetail } from './EventCard';
import * as api from '../lib/api';
import { notifyConversationRead } from '../lib/conversation-read';
import { PAGE_BUTTON, PAGE_CHAT_LABEL, PAGE_CHAT_NEW } from './market-card-shell';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getConversations: vi.fn(),
        rsvpEvent: vi.fn(),
        removeMarketplacePost: vi.fn(),
        getMarketplacePosts: vi.fn(async () => []),
        getMyEvents: vi.fn(async () => []),
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberRatings: vi.fn(async () => ({ ratings: [], average: 0, count: 0 })),
        myNodeRoleOnce: vi.fn(async () => null),
    };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const event: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee', description: '', credits: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true, status: 'active',
    lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + 86400000).toISOString(),
    eventEndAt: new Date(Date.now() + 90000000).toISOString(), eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
};
const listWith = (chats: any[]) => ({ conversations: chats, totalUnread: chats.reduce((n, c) => n + (c.unreadCount || 0), 0) });
const eventChat = (unreadCount: number) => ({ id: 'ev-1', type: 'event_thread', name: 'Working bee', participants: [], createdBy: 'host-pk', createdAt: '', unreadCount });

beforeEach(() => {
    vi.mocked(api.getConversations).mockReset();
    vi.mocked(api.getConversations).mockResolvedValue(listWith([]) as any);
});

describe('the chat button says it is a chat, in the brand colour', () => {
    it('words: "Chat with people going", never "Open event chat", and no number while nothing is unread', async () => {
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        const btn = screen.getByTestId('event-open-chat');
        await waitFor(() => expect(api.getConversations).toHaveBeenCalledWith('me-pk'));
        expect(btn).toHaveAccessibleName('Chat with people going');
        expect(btn.textContent).toContain('Chat with people going');
        expect(btn.textContent).not.toContain('Open event chat');
        expect(btn.textContent).not.toMatch(/\d/);
        expect(screen.queryByTestId('event-chat-new')).toBeNull();
    });

    it('the brand ink outline and words (core ink.brand), not the neutral outline Share and Add to calendar keep', () => {
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        const classes = screen.getByTestId('event-open-chat').className.split(/\s+/);
        for (const c of PAGE_BUTTON.chat.split(' ')) expect(classes, c).toContain(c);
        for (const c of ['border-bp-ink-brand', 'text-bp-ink-brand']) expect(classes).toContain(c);
        for (const c of ['border-nature-300', 'text-nature-900']) expect(classes).not.toContain(c);
        expect(screen.getByTestId('event-share').className).toContain('border-nature-300');
    });

    it('a step up in size, and real room between the icon and the words', () => {
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        const btn = screen.getByTestId('event-open-chat');
        const [icon, words] = Array.from(btn.children) as HTMLElement[];
        expect(icon.textContent).toBe('💬');
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(words.textContent).toBe('Chat with people going');
        expect(words.className).toContain(PAGE_CHAT_LABEL);
        expect(PAGE_CHAT_LABEL).toContain('text-base'); // 16, the page button's own words are 15
        expect(btn.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-3'])); // 12 px, was one space
    });
});

describe('a count of the lines not read yet', () => {
    it('3 unread in their chat list: "3 new" on the button, and in its name', async () => {
        vi.mocked(api.getConversations).mockResolvedValue(listWith([eventChat(3)]) as any);
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        const pill = await screen.findByTestId('event-chat-new');
        expect(pill.textContent).toBe('3 new');
        expect(pill.className).toContain(PAGE_CHAT_NEW);
        expect(screen.getByTestId('event-open-chat')).toHaveAccessibleName('Chat with people going, 3 new');
    });

    it('1 unread: "1 new"', async () => {
        vi.mocked(api.getConversations).mockResolvedValue(listWith([eventChat(1)]) as any);
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        expect((await screen.findByTestId('event-chat-new')).textContent).toBe('1 new');
    });

    it('none unread, or the chat not in their list (nobody has posted): no count', async () => {
        for (const list of [listWith([eventChat(0)]), listWith([{ ...eventChat(4), id: 'other-event' }]), listWith([])]) {
            vi.mocked(api.getConversations).mockResolvedValue(list as any);
            const { unmount } = render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
            await waitFor(() => expect(api.getConversations).toHaveBeenCalled());
            await act(async () => { await Promise.resolve(); });
            expect(screen.queryByTestId('event-chat-new')).toBeNull();
            unmount();
            vi.mocked(api.getConversations).mockClear();
        }
    });

    it('the count goes once the chat is read', async () => {
        vi.mocked(api.getConversations).mockResolvedValue(listWith([eventChat(2)]) as any);
        render(<EventDetail post={event} identity={identity} onOpenChat={vi.fn()} />);
        await screen.findByTestId('event-chat-new');
        act(() => notifyConversationRead('ev-1'));
        expect(screen.queryByTestId('event-chat-new')).toBeNull();
    });

    it('the host, who need not have answered, has the button and its count', async () => {
        vi.mocked(api.getConversations).mockResolvedValue(listWith([eventChat(5)]) as any);
        render(<EventDetail post={{ ...event, myRsvp: null, eventRsvps: [] }} identity={identity} onOpenChat={vi.fn()} />);
        expect((await screen.findByTestId('event-chat-new')).textContent).toBe('5 new');
    });

    it('Interested or not going: no chat button, and their chat list is never asked for it', async () => {
        for (const myRsvp of ['interested', null]) {
            const { unmount } = render(<EventDetail post={{ ...event, myRsvp }} identity={identity} onOpenChat={vi.fn()} />);
            expect(screen.queryByTestId('event-open-chat')).toBeNull();
            unmount();
        }
        await act(async () => { await Promise.resolve(); });
        expect(api.getConversations).not.toHaveBeenCalled();
    });
});
