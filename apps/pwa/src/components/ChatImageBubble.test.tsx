/**
 * A direct message's photo bubble on the web (components/ChatImageBubble.tsx), mounted on its own and opened again when what it
 * opens with changes (from #3104's deciding review, 13 Nov: the bubble kept "🔒 Image unavailable" after its first try failed,
 * even once the line was shown old, or the chat's key or the thread check's answer arrived, until the chat was reopened).
 *
 * The node's attachment, and the two openers (the line's own, core's old-line one), are faked at their edges: the node's answer
 * is held until the test gives it, the openers read what the attachment carries and refuse a key that isn't the right one.
 * The bubble and the words are the real ones. Real crypto on a real thread is MessagesPage.old-chat-photos.test.tsx.
 */
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Att = { data: string; nonce: string };
const net = vi.hoisted(() => ({ asks: [] as Array<{ id: string; resolve: (a: { data: string; nonce: string }) => void; reject: (e: Error) => void }> }));
const opened = vi.hoisted(() => ({ line: [] as string[], old: [] as string[] }));

vi.mock('../lib/api', () => ({
    getMessageAttachmentApi: vi.fn((id: string) => new Promise<Att>((resolve, reject) => { net.asks.push({ id, resolve, reject }); })),
}));
// A new line's photo opens only under the right key; the picture it gives back is named for the attachment it was sealed in.
vi.mock('../lib/e2e-crypto', () => ({
    openDmLine: vi.fn((att: Att, keys: { peerEdPubHex: string }) => {
        opened.line.push(att.nonce);
        if (keys.peerEdPubHex !== 'peer-good') throw new Error('does not open under this key');
        return { text: `data:image/jpeg;base64,${att.nonce}` };
    }),
}));
vi.mock('@beanpool/core', async (original) => ({
    ...(await original<typeof import('@beanpool/core')>()),
    openDmOldPhoto: vi.fn((_words: unknown, att: Att, keys: { peerEdPubHex: string }) => {
        opened.old.push(att.nonce);
        if (keys.peerEdPubHex !== 'peer-good') throw new Error('does not open under this key');
        return `data:image/jpeg;base64,old-${att.nonce}`;
    }),
}));

import { ChatImageBubble } from './ChatImageBubble';
import { getMessageAttachmentApi } from '../lib/api';

type Props = Parameters<typeof ChatImageBubble>[0];
const base: Props = { messageId: 'm-1', conversationId: 'conv-1', authorPubkey: 'ana', metadata: null, bodyFormat: 4, peerPubHex: 'peer-good', myPrivHex: 'mine', onOpen: undefined, old: null };
/** The line's own sealing, as the page hands it over for a line the thread check showed old (a new object on every draw). */
const oldLine = () => ({ words: { ciphertext: 'words-ct', nonce: 'words-nonce' }, timestamp: '2026-11-01T00:00:00Z' });

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const photo = () => screen.queryByRole('img')?.getAttribute('src') ?? null;
const locked = () => !!screen.queryByText('🔒 Image unavailable');
const loading = () => !!screen.queryByText('Loading image…');
const answer = async (ask: (typeof net.asks)[number], nonce: string) => { ask.resolve({ data: 'blob', nonce }); await settle(); };

let view: ReturnType<typeof render>;
/** Draws the bubble (or draws it again with other props, in the same place: the same bubble, never a new one). */
const show = async (props: Partial<Props>) => {
    const element = <ChatImageBubble {...base} {...props} />;
    if (view) view.rerender(element); else view = render(element);
    await settle();
};

beforeEach(() => { net.asks.length = 0; opened.line.length = 0; opened.old.length = 0; vi.mocked(getMessageAttachmentApi).mockClear(); });
afterEach(() => { cleanup(); view = undefined as never; });

describe('a web photo bubble that first fails opens when what it opens with arrives', () => {
    it('shows the photo once the chat\'s key arrives (peerPubHex changes), without a new bubble', async () => {
        await show({ peerPubHex: 'peer-wrong' });
        expect(loading()).toBe(true);
        await answer(net.asks[0], 'a');
        expect(locked()).toBe(true);

        await show({ peerPubHex: 'peer-good' });
        expect(locked()).toBe(false);
        expect(loading()).toBe(true);
        expect(net.asks).toHaveLength(2);
        await answer(net.asks[1], 'a');
        expect(photo()).toBe('data:image/jpeg;base64,a');
        expect(locked()).toBe(false);
    });

    // Conversion code, log row OLDCHAT, remove after 12 Dec 2026: this test (it goes with the `old` prop).
    it('shows the photo once the thread check shows the line old, through the old path only, read-only', async () => {
        // First draw: not verified and not (yet) old, so nothing opens it and nothing is fetched.
        await show({ bodyFormat: null, old: null });
        expect(locked()).toBe(true);
        expect(net.asks).toHaveLength(0);

        await show({ bodyFormat: null, old: oldLine() });
        expect(locked()).toBe(false);
        expect(net.asks).toHaveLength(1);
        await answer(net.asks[0], 'p');
        expect(photo()).toBe('data:image/jpeg;base64,old-p');
        expect(opened.old).toEqual(['p']);
        // An old line's photo never goes through the new opener, and the bubble offers nothing to write with.
        expect(opened.line).toEqual([]);
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('shows the photo once the thread check verifies the line (bodyFormat null → 4)', async () => {
        await show({ bodyFormat: null, old: null });
        expect(locked()).toBe(true);
        await show({ bodyFormat: 4 });
        await answer(net.asks[0], 'v');
        expect(photo()).toBe('data:image/jpeg;base64,v');
        expect(opened.old).toEqual([]);
    });

    it('opens again after the node had no file the first time (a throw from the net, not only from the opener)', async () => {
        await show({ messageId: 'm-1', peerPubHex: 'peer-good' });
        net.asks[0].reject(Object.assign(new Error('Attachment not found'), { status: 404 }));
        await settle();
        expect(locked()).toBe(true);
        await show({ messageId: 'm-1', peerPubHex: 'peer-good', metadata: '{"seq":2}' });
        await answer(net.asks[1], 'b');
        expect(photo()).toBe('data:image/jpeg;base64,b');
    });

    it('asks again for another message in the same bubble, and clears the last photo while it does', async () => {
        await show({ messageId: 'm-1' });
        await answer(net.asks[0], 'one');
        expect(photo()).toBe('data:image/jpeg;base64,one');

        await show({ messageId: 'm-2' });
        expect(net.asks.map((a) => a.id)).toEqual(['m-1', 'm-2']);
        // m-1's picture is not left standing under m-2 while m-2 loads.
        expect(photo()).toBeNull();
        expect(loading()).toBe(true);
        await answer(net.asks[1], 'two');
        expect(photo()).toBe('data:image/jpeg;base64,two');
    });

    it('tapping the photo hands its address up to be shown full screen', async () => {
        const onOpen = vi.fn();
        await show({ onOpen });
        await answer(net.asks[0], 'tap');
        fireEvent.click(screen.getByRole('button', { name: 'View photo full screen' }));
        expect(onOpen).toHaveBeenCalledWith('data:image/jpeg;base64,tap');
    });
});

describe('the latest attempt wins', () => {
    it('an earlier attempt that opens late cannot overwrite a newer photo', async () => {
        await show({ peerPubHex: 'peer-good', messageId: 'm-1' });
        await show({ peerPubHex: 'peer-good', messageId: 'm-1', metadata: 'changed' });
        const [early, late] = net.asks;
        await answer(late, 'new');
        expect(photo()).toBe('data:image/jpeg;base64,new');
        await answer(early, 'stale');
        expect(photo()).toBe('data:image/jpeg;base64,new');
        expect(locked()).toBe(false);
    });

    it('an earlier attempt that fails late cannot lock a photo a newer attempt opened', async () => {
        await show({ peerPubHex: 'peer-wrong' });
        await show({ peerPubHex: 'peer-good' });
        const [early, late] = net.asks;
        await answer(late, 'new');
        expect(photo()).toBe('data:image/jpeg;base64,new');
        // The first attempt's opener refuses its key only now.
        await answer(early, 'stale');
        expect(photo()).toBe('data:image/jpeg;base64,new');
        expect(locked()).toBe(false);
    });

    it('an earlier attempt that opens late cannot lift a newer failure', async () => {
        await show({ peerPubHex: 'peer-good' });
        await show({ peerPubHex: 'peer-wrong' });
        const [early, late] = net.asks;
        await answer(late, 'bad');
        expect(locked()).toBe(true);
        await answer(early, 'stale');
        expect(locked()).toBe(true);
        expect(photo()).toBeNull();
    });
});

describe('a real failure stays a failure until what it opens with changes', () => {
    it('asks once, however often the page draws it again with the same things, and however long it waits', async () => {
        await show({ peerPubHex: 'peer-wrong', old: null, onOpen: () => {} });
        await answer(net.asks[0], 'x');
        expect(locked()).toBe(true);
        vi.useFakeTimers();
        try {
            // Every poll redraws the page: the same line and key, a new callback and a new `old` object each time.
            for (let i = 0; i < 5; i++) {
                view.rerender(<ChatImageBubble {...base} peerPubHex="peer-wrong" old={null} onOpen={() => {}} />);
                await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            }
            expect(net.asks).toHaveLength(1);
            expect(locked()).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    // Conversion code, log row OLDCHAT, remove after 12 Dec 2026: this test (it goes with the `old` prop).
    it('an old line that fails stays failed through redraws that hand over a new old object, and tries again only on new words', async () => {
        await show({ bodyFormat: null, peerPubHex: 'peer-wrong', old: oldLine() });
        await answer(net.asks[0], 'x');
        expect(locked()).toBe(true);
        await show({ bodyFormat: null, peerPubHex: 'peer-wrong', old: oldLine() });
        await show({ bodyFormat: null, peerPubHex: 'peer-wrong', old: oldLine() });
        expect(net.asks).toHaveLength(1);
        expect(locked()).toBe(true);

        await show({ bodyFormat: null, peerPubHex: 'peer-wrong', old: { ...oldLine(), words: { ciphertext: 'words-ct-2', nonce: 'words-nonce' } } });
        expect(net.asks).toHaveLength(2);
        await answer(net.asks[1], 'y');
        expect(locked()).toBe(true);
        expect(net.asks).toHaveLength(2);
    });
});
