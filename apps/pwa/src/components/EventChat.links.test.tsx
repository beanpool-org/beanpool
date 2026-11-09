/**
 * An event chat: a link in a line is a link, for everyone going (Marty, 9 Nov: on the phone a URL in a message opens; on the
 * web it was plain words). A removed line has none. The rule is core's chat-links.ts, the same as the phone's.
 */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventChat } from './EventChat';
import * as api from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn() };
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
        readOnly: false, readOnlyReason: null, canPost: true, isHost: false, title: 'Working bee',
        eventEndAt: new Date(2030, 8, 28, 12, 0).toISOString(), eventState: 'scheduled', privateNote: null,
        notice: "Visible to the host, everyone going, and this node's operator.",
        ...over,
    };
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    vi.mocked(api.getEventChat).mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('EventChat: a link in a line', () => {
    it('is a link to the address, in a new tab, with the words around it kept', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            messages: [message({ ciphertext: b64('Map and parking: https://byron.beanpool.org/events, see you there') })],
        }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);

        const link = (await screen.findByTestId('chat-link')) as HTMLAnchorElement;
        expect(link.tagName).toBe('A');
        // The comma that follows it is not in the address; the link run, as on the phone, is the words up to the space.
        expect(link.getAttribute('href')).toBe('https://byron.beanpool.org/events');
        expect(link.textContent).toBe('https://byron.beanpool.org/events,');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.style.color).toBe('var(--link)');
        expect(link.style.textDecoration).toBe('underline');
        expect(link.style.overflowWrap).toBe('anywhere');
        expect(link.closest('p')!.textContent).toBe('Map and parking: https://byron.beanpool.org/events, see you there');
    });

    it('a click on it is left to the browser, and Copy still copies the whole line', async () => {
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        vi.mocked(api.getEventChat).mockResolvedValue(view({ messages: [message({ ciphertext: b64('www.beanpool.org') })] }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);

        const link = (await screen.findByTestId('chat-link')) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('https://www.beanpool.org');
        let notPrevented = true;
        await act(async () => { notPrevented = fireEvent.click(link); });
        expect(notPrevented).toBe(true);
        expect(writeText).not.toHaveBeenCalled();

        const line = link.closest('li') as HTMLElement;
        await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Copy message' })); });
        expect(writeText).toHaveBeenCalledWith('www.beanpool.org');
    });

    it('words with no link are drawn exactly as they were', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({ messages: [message({ ciphertext: b64('Bring byron.beanpool.org to mind, not a link') })] }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        await screen.findByText('Bring byron.beanpool.org to mind, not a link');
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
    });

    it('a removed line has no link', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            isHost: true,
            messages: [message({ type: 'removed', ciphertext: b64('https://evil.example/pay') })],
        }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        await screen.findByText('removed by the host');
        expect(screen.queryAllByTestId('chat-link')).toEqual([]);
        expect(document.querySelector('a[href*="evil"]')).toBeNull();
    });
});
