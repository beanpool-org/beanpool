/**
 * An event chat's Copy (Marty, 9 Nov: "I can't select and copy text from previous messages"): every line with words has a
 * Copy button for everyone going, not only the host; a removed line has none; the words are selectable.
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

describe('EventChat: Copy message', () => {
    it('offers Copy to a member who is not the host, and puts the words on the clipboard with a brief "Copied"', async () => {
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        vi.mocked(api.getEventChat).mockResolvedValue(view({ isHost: false }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);

        const words = await screen.findByText('Bringing a thermos');
        const line = words.closest('li') as HTMLElement;
        const copy = within(line).getByRole('button', { name: 'Copy message' });
        expect(within(line).queryByRole('button', { name: /^Remove message from/ })).toBeNull();

        await act(async () => { fireEvent.click(copy); });
        expect(writeText).toHaveBeenCalledWith('Bringing a thermos');
        expect(within(line).getAllByText('Copied').length).toBeGreaterThan(0);
        // Said to a screen reader too.
        expect(within(line).getByRole('status').textContent).toBe('Copied');
    });

    it('keeps the host\'s Remove beside Copy', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({ isHost: true }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const line = (await screen.findByText('Bringing a thermos')).closest('li') as HTMLElement;
        expect(within(line).getByRole('button', { name: 'Copy message' })).toBeTruthy();
        expect(within(line).getByRole('button', { name: 'Remove message from Goer' })).toBeTruthy();
    });

    it('offers no Copy on a removed line', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view({
            isHost: true,
            messages: [message({ type: 'removed', ciphertext: '' })],
        }));
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const line = (await screen.findByText('removed by the host')).closest('li') as HTMLElement;
        expect(within(line).queryByRole('button', { name: 'Copy message' })).toBeNull();
    });

    it('draws the words selectable', async () => {
        vi.mocked(api.getEventChat).mockResolvedValue(view());
        render(<EventChat postId="ev-1" identity={identity} refreshMs={0} />);
        const words = await screen.findByText('Bringing a thermos');
        expect(words.closest('p')!.className).toContain('select-text');
        for (let el: HTMLElement | null = words; el; el = el.parentElement) {
            expect(el.style.userSelect).not.toBe('none');
            expect(el.className).not.toContain('select-none');
        }
    });
});
