/**
 * The screens of messages across communities on the web (X4b): components/AddressCardPanel.tsx and components/OutsideChats.tsx,
 * drawn over the real outside-chat store (lib/outside-chat-store.ts on the in-memory IndexedDB) with the round itself stood in
 * for (lib/outside-mail.test.ts plays it against the mailbox).
 *
 * What is checked: Fable's words (DECISION-outside-door.md, X2b) where the phone shows them, from core: the switch ends "in this
 * browser", "Each phone or browser you use has its own switch." under it, and the chat's banner says "What you write on another
 * phone or browser shows only there." under "Kept in this browser only."; showing my card opens this browser's door and the
 * switch closes it; a blocked person's card opens no box; a request takes no reply until Accept; an open chat has its box.
 * Changes to lines (X6): an edit reads "edited", a deleted line "This message was deleted", reactions under the line with mine
 * marked; a tap on a line in an open chat offers the chat's reactions and, on mine only, Edit message and Delete message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    OUTSIDE_DOOR_EACH_DEVICE, OUTSIDE_DOOR_SWITCH_BROWSER, OUTSIDE_WRITES_STAY_THERE, addressCardLink, ed25519Signer, relayConversationId,
    signAddressCard,
} from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <span data-testid="qr" data-value={value} /> }));

const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), SOL = seedKey();
const B = 'https://b.example', HOME = 'b.example', SOL_HOME = 'a.example';

const here = vi.hoisted(() => ({ ctx: null as any, blocked: new Set<string>(), roundThrows: false }));
vi.mock('../lib/outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/outside-mail')>();
    const core = await import('@beanpool/core');
    const { hexToBytes: hex } = await import('@noble/hashes/utils.js');
    return {
        ...real,
        outsideContext: async () => here.ctx,
        outsideMessagesHere: async () => true,
        // A round that throws at once (as one did in a page whose api had no node address): the screen stays up.
        syncOutsideMailNow: () => { if (here.roundThrows) throw new Error('no node address'); return Promise.resolve(null); },
        myHome: async () => HOME,
        myAddressCard: async (ctx: any) => core.signAddressCard({ key: ctx.identity.publicKey, home: HOME, name: 'Ben' }, core.ed25519Signer(hex(ctx.identity.privateKey))),
        sendFromBox: vi.fn(async () => ({ kept: true, error: null })),
        sendOutsideChange: vi.fn(async () => {}),
    };
});

import { outsideChatStore, clearOutsideChats } from '../lib/outside-chat-store';
import { doorOpen, sendOutsideChange } from '../lib/outside-mail';
import { AddressCardPanel } from './AddressCardPanel';
import { OutsideChatThread, outsideRoundNow } from './OutsideChats';

const chatId = relayConversationId(BEN.key, SOL.key);

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    await clearOutsideChats();
    here.blocked = new Set();
    here.roundThrows = false;
    here.ctx = {
        nodeUrl: B, identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B),
        isBlocked: async (k: string) => here.blocked.has(k),
    };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the address card and its door (AddressCardPanel)', () => {
    it('no switch until the card is shown; showing it opens this browser\'s door, with the switch "in this browser" and each device\'s own', async () => {
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        const show = await screen.findByTestId('show-my-card');
        expect(screen.queryByTestId('door-switch')).toBeNull();
        expect(screen.queryByTestId('door-each-device')).toBeNull();
        fireEvent.click(show);
        const sw = await screen.findByTestId('door-switch') as HTMLInputElement;
        expect(sw.checked).toBe(true);
        expect(await doorOpen(here.ctx)).toBe(true);
        expect(screen.getByText(OUTSIDE_DOOR_SWITCH_BROWSER)).toBeTruthy();
        expect(OUTSIDE_DOOR_SWITCH_BROWSER.endsWith('in this browser')).toBe(true);
        expect(screen.getByTestId('door-each-device').textContent).toBe(OUTSIDE_DOOR_EACH_DEVICE);
        expect(OUTSIDE_DOOR_EACH_DEVICE).toBe('Each phone or browser you use has its own switch.');
        expect(screen.getByTestId('qr').getAttribute('data-value')).toMatch(/^https?:\/\//);
        // The switch closes it: this browser's door only.
        fireEvent.click(sw);
        await waitFor(async () => expect(await doorOpen(here.ctx)).toBe(false));
    });

    it('a blocked person\'s card opens no box and changes nothing here; an unblocked one opens the first-message box', async () => {
        const card = await signAddressCard({ key: SOL.key, home: SOL_HOME, name: 'Sol' }, ed25519Signer(hexToBytes(SOL.seed)));
        here.blocked.add(SOL.key);
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        fireEvent.change(await screen.findByTestId('paste-card'), { target: { value: addressCardLink(card) } });
        fireEvent.click(screen.getByTestId('read-card'));
        expect(await screen.findByText('You have blocked this user. Messaging is disabled.')).toBeTruthy();
        expect(screen.queryByTestId('first-message')).toBeNull();
        expect(await here.ctx.store.chat(BEN.key, chatId)).toBeNull();

        here.blocked.delete(SOL.key);
        fireEvent.click(screen.getByTestId('read-card'));
        expect(await screen.findByTestId('first-message')).toBeTruthy();
        expect(screen.getByText('a.example · name not confirmed here')).toBeTruthy();
    });
});

describe('the chat (OutsideChatThread)', () => {
    it('an open chat: kept in this browser only, what I write elsewhere shows only there, and its box', async () => {
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        const banner = await screen.findByTestId('outside-chat-kept-here');
        expect(banner.textContent).toContain('Kept in this browser only. Your community keeps no copy.');
        expect(screen.getByTestId('outside-chat-writes-stay').textContent).toBe(OUTSIDE_WRITES_STAY_THERE);
        expect(OUTSIDE_WRITES_STAY_THERE).toBe('What you write on another phone or browser shows only there.');
        expect(screen.getByTestId('outside-chat-input')).toBeTruthy();
        expect(screen.getByTestId('outside-chat-home').textContent).toBe('a.example · name not confirmed here');
    });

    it('a request: its one line, Accept / Decline / Block, no box until Accept; Accept opens it and tells the page (Back then lands on the chats)', async () => {
        await here.ctx.store.writeTheirs(BEN.key, { id: crypto.randomUUID(), chatId, author: SOL.key, text: 'Hello Ben', replyTo: null, at: Date.now() }, { home: SOL_HOME, name: 'Sol' }, 'request');
        const onAccepted = vi.fn();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} onAccepted={onAccepted} />);
        expect(await screen.findByTestId('outside-request')).toBeTruthy();
        expect(screen.getByText('Hello Ben')).toBeTruthy();
        expect(screen.getByTestId('outside-chat-writes-stay')).toBeTruthy();
        expect(screen.queryByTestId('outside-chat-input')).toBeNull();
        expect(onAccepted).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('outside-request-accept'));
        expect(await screen.findByTestId('outside-chat-input')).toBeTruthy();
        expect((await here.ctx.store.chat(BEN.key, chatId))?.state).toBe('open');
        expect(onAccepted).toHaveBeenCalledTimes(1);
    });
});

describe('changes to lines (X6)', () => {
    async function openWithLines() {
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        const theirs = crypto.randomUUID(), mine = crypto.randomUUID(), gone = crypto.randomUUID();
        const at = Date.now() - 10_000;
        await here.ctx.store.writeTheirs(BEN.key, { id: theirs, chatId, author: SOL.key, text: 'Bikes at 3', replyTo: null, at }, { home: SOL_HOME, name: 'Sol' }, 'line');
        await here.ctx.store.writeTheirs(BEN.key, { id: gone, chatId, author: SOL.key, text: 'Oops', replyTo: null, at: at + 1 }, { home: SOL_HOME, name: 'Sol' }, 'line');
        await here.ctx.store.addMine(BEN.key, { id: mine, chatId, author: BEN.key, text: 'See you there', replyTo: null, at: at + 2, item: '{}' });
        await here.ctx.store.setMineState(BEN.key, chatId, mine, 'delivered');
        return { theirs, mine, gone, at };
    }
    beforeEach(() => { vi.mocked(sendOutsideChange).mockClear(); });

    it('reads its changes: edited, deleted, and reactions with mine marked', async () => {
        const { theirs, gone, at } = await openWithLines();
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-edit', itemId: crypto.randomUUID(), lineId: theirs, author: SOL.key, at: at + 5, text: 'Bikes at 4' });
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-delete', itemId: crypto.randomUUID(), lineId: gone, author: SOL.key, at: at + 6 });
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-reaction', itemId: crypto.randomUUID(), lineId: theirs, author: BEN.key, at: at + 7, emoji: '👍' });
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-reaction', itemId: crypto.randomUUID(), lineId: theirs, author: SOL.key, at: at + 8, emoji: '👍' });
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        expect(await screen.findByText('Bikes at 4')).toBeTruthy();
        expect(screen.queryByText('Bikes at 3')).toBeNull();
        expect(screen.getByTestId('outside-line-edited').textContent).toBe('edited');
        expect(screen.getByTestId('outside-line-deleted').textContent).toBe('This message was deleted');
        expect(screen.queryByText('Oops')).toBeNull();
        expect(screen.getByTestId('outside-line-reactions').textContent).toBe('👍 2');
    });

    it('a tap on their line: the chat\'s seven reactions, no Edit or Delete; a reaction is sent, and tapped again it is taken back', async () => {
        const { theirs } = await openWithLines();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByText('Bikes at 3'));
        const actions = await screen.findByTestId('outside-line-actions');
        expect([...actions.querySelectorAll('button[aria-label^="React with"]')].map((b) => b.textContent)).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏', '😁']);
        expect(screen.queryByTestId('outside-line-edit')).toBeNull();
        expect(screen.queryByTestId('outside-line-delete')).toBeNull();
        fireEvent.click(screen.getByLabelText('React with ❤️'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenCalledWith(here.ctx, chatId, { kind: 'dm-reaction', lineId: theirs, emoji: '❤️' }));
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-reaction', itemId: crypto.randomUUID(), lineId: theirs, author: BEN.key, at: Date.now(), emoji: '❤️' });
        fireEvent.click(await screen.findByText('Bikes at 3'));
        await waitFor(() => expect(screen.getByLabelText('React with ❤️').getAttribute('aria-pressed')).toBe('true'));
        fireEvent.click(screen.getByLabelText('React with ❤️'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenLastCalledWith(here.ctx, chatId, { kind: 'dm-reaction', lineId: theirs, emoji: '' }));
    });

    it('a tap on my line: Edit message fills the box and Save sends the edit; Delete message asks first', async () => {
        const { mine } = await openWithLines();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-edit'));
        const box = screen.getByTestId('outside-chat-input') as HTMLTextAreaElement;
        expect(box.value).toBe('See you there');
        expect(screen.getByTestId('outside-chat-send').textContent).toBe('Save');
        fireEvent.change(box, { target: { value: 'See you at 4' } });
        fireEvent.click(screen.getByTestId('outside-chat-send'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenCalledWith(here.ctx, chatId, { kind: 'dm-edit', lineId: mine, text: 'See you at 4' }));
        await waitFor(() => expect(screen.getByTestId('outside-chat-send').textContent).toBe('Send'));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-delete'));
        expect(confirm).toHaveBeenCalledWith('Delete for everyone?\n\nIt will read "This message was deleted" for both of you.');
        expect(sendOutsideChange).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('outside-line-delete'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenLastCalledWith(here.ctx, chatId, { kind: 'dm-delete', lineId: mine }));
        confirm.mockRestore();
    });

    it('a request\'s line, and a deleted one, offer nothing to tap', async () => {
        await here.ctx.store.writeTheirs(BEN.key, { id: crypto.randomUUID(), chatId, author: SOL.key, text: 'Hello Ben', replyTo: null, at: Date.now() }, { home: SOL_HOME, name: 'Sol' }, 'request');
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByText('Hello Ben'));
        expect(screen.queryByTestId('outside-line-actions')).toBeNull();
        expect(screen.getByTestId('outside-line-theirs').getAttribute('role')).toBeNull();
    });
});

describe('the round never takes a screen down (preflight: every MessagesPage test went red on a round that threw at once)', () => {
    it('outsideRoundNow answers null when the round throws at once, and the chat still draws', async () => {
        here.roundThrows = true;
        await expect(outsideRoundNow()).resolves.toBeNull();
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        expect(await screen.findByTestId('outside-chat-kept-here')).toBeTruthy();
    });
});
