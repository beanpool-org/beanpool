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
 * marked; a tap on a line in an open chat offers the chat's reactions and, on mine only, Edit message and Delete message. Report
 * message (X6 round 3): on every line of theirs not deleted, in every state of the chat, a request's included; the table of
 * chat states x lines says what a tap offers (core outsideLineActions, the phone's table too).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    ACROSS_FIRST_LINE_NOTE, OUTSIDE_DOOR_EACH_DEVICE, OUTSIDE_DOOR_SWITCH_BROWSER, OUTSIDE_WRITES_STAY_THERE, addressCardLink, ed25519Signer, relayConversationId,
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
        // A report of their line (X5) as the screen makes it: recorded; what it sends is outside-mail.test.ts's.
        reportOutsideLine: vi.fn(async () => {}),
    };
});
vi.mock('../lib/blocklist', () => ({ blockUser: vi.fn(async (key: string) => { here.blocked.add(key); }) }));

import { outsideChatStore, clearOutsideChats } from '../lib/outside-chat-store';
import { doorOpen, reportOutsideLine, sendFromBox, sendOutsideChange } from '../lib/outside-mail';
import { AddressCardPanel } from './AddressCardPanel';
import { OutsideChatThread, outsideRoundNow } from './OutsideChats';
import { outOfView, recordScrolls, stopRecordingScrolls } from '../chat-end-in-view.test-support';

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

/**
 * The note under a first line across (slice S5 part 2, DESIGN-no-switch-messaging-fable.md §3 "Member-facing words"; core
 * ACROSS_FIRST_LINE_NOTE, acrossFirstLineNoteUnder): under my first line only, while they have written nothing; gone once
 * they write; never in a chat brought back. Drawn in the theme's secondary text colour (a token both themes define, so it
 * reads in light and dark), and it wraps anywhere (a 320 px screen at 130 % text never scrolls sideways).
 */
describe('the note under a first line across (S5 part 2)', () => {
    const NOTE = 'They will see this if they take messages from other communities.';
    const mine = (id: string, text: string, at: number) => here.ctx.store.addMine(BEN.key, { id, chatId, author: BEN.key, text, replyTo: null, at, item: '{}' });

    it('under my first line only, while they have written nothing; in both themes\' secondary text, wrapping anywhere', async () => {
        expect(ACROSS_FIRST_LINE_NOTE).toBe(NOTE);
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        const at = Date.now() - 10_000;
        await mine('m1', 'Hello from my community', at);
        await mine('m2', 'A second line', at + 1);
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        const note = await screen.findByTestId('outside-first-line-note');
        expect(screen.getAllByTestId('outside-first-line-note')).toHaveLength(1);
        expect(note.textContent).toBe(NOTE);
        expect(note.parentElement?.textContent).toContain('Hello from my community');
        expect(note.parentElement?.textContent).not.toContain('A second line');
        expect(note.style.color).toBe('var(--text-secondary)');
        expect(note.style.overflowWrap).toBe('anywhere');
    });

    it('gone once they write', async () => {
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        const at = Date.now() - 10_000;
        await mine('m1', 'Hello from my community', at);
        await here.ctx.store.writeTheirs(BEN.key, { id: 't1', chatId, author: SOL.key, text: 'Hi back', replyTo: null, at: at + 1, sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'line');
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        await screen.findByText('Hi back');
        expect(screen.queryByTestId('outside-first-line-note')).toBeNull();
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
        await here.ctx.store.writeTheirs(BEN.key, { id: crypto.randomUUID(), chatId, author: SOL.key, text: 'Hello Ben', replyTo: null, at: Date.now(), sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'request');
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

    // The deciding review of #3285 (the guest chat's twin is GuestChats.render.test.tsx): this page scrolled its newest line
    // to the bottom of the screen, so the box, or a request's Accept, sat under it, out of view. Each state -> what must be
    // in view when the chat opens.
    describe('opens at its newest line, with what comes after it in view (30 lines)', () => {
        beforeEach(() => recordScrolls());
        afterEach(() => stopRecordingScrolls());
        const newest = () => document.querySelector('[role="log"]')?.lastElementChild ?? null;
        async function withLines(state: 'request' | 'open' | 'declined') {
            const at = Date.now() - 100_000;
            for (let i = 0; i < 30; i++) {
                await here.ctx.store.writeTheirs(BEN.key, { id: crypto.randomUUID(), chatId, author: SOL.key, text: `Line ${i + 1}`, replyTo: null, at: at + i, sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'request');
            }
            if (state !== 'request') await here.ctx.store.decide(BEN.key, chatId, state);
            render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
            await waitFor(() => expect(document.querySelectorAll('[data-testid="outside-line-theirs"]')).toHaveLength(30));
        }
        const ROWS: Array<[string, 'request' | 'open' | 'declined', Array<[string, () => Element | null]>]> = [
            ['open: the newest line and the box', 'open', [['the newest line', newest], ['the box', () => screen.queryByTestId('outside-chat-input')]]],
            ['a request: the newest line and Accept', 'request', [['the newest line', newest], ['Accept', () => screen.queryByTestId('outside-request-accept')]]],
            ['declined: the newest line', 'declined', [['the newest line', newest]]],
        ];
        it.each(ROWS)('%s', async (_what, state, must) => {
            await withLines(state);
            await waitFor(() => expect(must.map(([name, el]) => outOfView(el(), name)).filter(Boolean)).toEqual([]));
        });
    });
});

describe('changes to lines (X6)', () => {
    async function openWithLines() {
        await here.ctx.store.openChat(BEN.key, chatId, { key: SOL.key, home: SOL_HOME, name: 'Sol' });
        const theirs = crypto.randomUUID(), mine = crypto.randomUUID(), gone = crypto.randomUUID();
        const at = Date.now() - 10_000;
        await here.ctx.store.writeTheirs(BEN.key, { id: theirs, chatId, author: SOL.key, text: 'Bikes at 3', replyTo: null, at, sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'line');
        await here.ctx.store.writeTheirs(BEN.key, { id: gone, chatId, author: SOL.key, text: 'Oops', replyTo: null, at: at + 1, sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'line');
        await here.ctx.store.addMine(BEN.key, { id: mine, chatId, author: BEN.key, text: 'See you there', replyTo: null, at: at + 2, item: '{}' });
        await here.ctx.store.setMineState(BEN.key, chatId, mine, 'delivered');
        return { theirs, mine, gone, at };
    }
    beforeEach(() => { vi.mocked(sendOutsideChange).mockClear(); vi.mocked(reportOutsideLine).mockClear(); });

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
        expect(screen.getByTestId('outside-line-reactions').textContent).toBe('👍2');
    });

    it('a tap on their line: the chat\'s seven reactions and Report message, no Edit or Delete; a reaction is sent, and tapped again it is taken back', async () => {
        const { theirs } = await openWithLines();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByText('Bikes at 3'));
        const actions = await screen.findByTestId('outside-line-actions');
        expect([...actions.querySelectorAll('button[aria-label^="React with"]')].map((b) => b.textContent)).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏', '😁']);
        expect(screen.getByTestId('outside-line-report').textContent).toBe('Report message');
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
        fireEvent.change(await screen.findByTestId('outside-chat-input'), { target: { value: 'half a thought' } });
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-edit'));
        const box = screen.getByTestId('outside-chat-input') as HTMLTextAreaElement;
        expect(box.value).toBe('See you there');
        expect(screen.getByTestId('outside-chat-send').textContent).toBe('Save');
        fireEvent.change(box, { target: { value: 'See you at 4' } });
        fireEvent.click(screen.getByTestId('outside-chat-send'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenCalledWith(here.ctx, chatId, { kind: 'dm-edit', lineId: mine, text: 'See you at 4' }));
        await waitFor(() => expect(screen.getByTestId('outside-chat-send').textContent).toBe('Send'));
        // What was typed before the edit is back in the box, never lost.
        expect((screen.getByTestId('outside-chat-input') as HTMLTextAreaElement).value).toBe('half a thought');
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-delete'));
        expect(await screen.findByText('Delete for everyone?')).toBeTruthy();
        expect(screen.getByText('It will read "This message was deleted" for both of you.')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(sendOutsideChange).toHaveBeenCalledTimes(1);
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-delete'));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenLastCalledWith(here.ctx, chatId, { kind: 'dm-delete', lineId: mine }));
    });

    it('leaving in the middle of an edit: the edit comes back as the edit (Save sends it as one), and the words typed before it come back after; never a new line', async () => {
        const { mine } = await openWithLines();
        vi.mocked(sendFromBox).mockClear();
        const first = render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.change(await screen.findByTestId('outside-chat-input'), { target: { value: 'see you' } });
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-edit'));
        fireEvent.change(screen.getByTestId('outside-chat-input'), { target: { value: 'See you at 4' } });
        // Back: the chat closes mid-edit.
        first.unmount();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        await waitFor(() => expect((screen.getByTestId('outside-chat-input') as HTMLTextAreaElement).value).toBe('See you at 4'));
        expect(screen.getByTestId('outside-chat-send').textContent).toBe('Save');
        expect(screen.getByTestId('outside-chat-edit-cancel')).toBeTruthy();
        fireEvent.click(screen.getByTestId('outside-chat-send'));
        await waitFor(() => expect(sendOutsideChange).toHaveBeenCalledWith(here.ctx, chatId, { kind: 'dm-edit', lineId: mine, text: 'See you at 4' }));
        await waitFor(() => expect((screen.getByTestId('outside-chat-input') as HTMLTextAreaElement).value).toBe('see you'));
        expect(screen.getByTestId('outside-chat-send').textContent).toBe('Send');
        expect(sendFromBox).not.toHaveBeenCalled();
    });

    it('leaving mid-edit, back, then Cancel: the words typed before it, and the line\'s words are never the draft', async () => {
        await openWithLines();
        vi.mocked(sendFromBox).mockClear();
        const first = render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.change(await screen.findByTestId('outside-chat-input'), { target: { value: 'see you' } });
        fireEvent.click(await screen.findByText('See you there'));
        fireEvent.click(await screen.findByTestId('outside-line-edit'));
        first.unmount();
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByTestId('outside-chat-edit-cancel'));
        await waitFor(() => expect((screen.getByTestId('outside-chat-input') as HTMLTextAreaElement).value).toBe('see you'));
        expect(screen.getByTestId('outside-chat-send').textContent).toBe('Send');
        expect(sendOutsideChange).not.toHaveBeenCalled();
        expect(sendFromBox).not.toHaveBeenCalled();
    });

    it('a deleted line of mine shows no tick: nothing is left to deliver', async () => {
        const { mine, at } = await openWithLines();
        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-delete', itemId: crypto.randomUUID(), lineId: mine, author: BEN.key, at: at + 9 });
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        expect((await screen.findAllByTestId('outside-line-deleted')).length).toBe(1);
        expect(screen.queryByTestId('outside-line-state')).toBeNull();
    });

    it('a request\'s line offers Report message and no reactions; the report goes, blocks its sender, and Done goes back (design §3.5)', async () => {
        const line = crypto.randomUUID();
        await here.ctx.store.writeTheirs(BEN.key, { id: line, chatId, author: SOL.key, text: 'Hello Ben', replyTo: null, at: Date.now(), sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'request');
        const onBack = vi.fn();
        render(<OutsideChatThread chatId={chatId} onBack={onBack} />);
        fireEvent.click(await screen.findByText('Hello Ben'));
        expect(screen.getByTestId('outside-line-theirs').getAttribute('role')).toBe('button');
        expect(screen.getByTestId('outside-line-report')).toBeTruthy();
        expect(screen.queryAllByLabelText(/^React with/)).toHaveLength(0);
        fireEvent.click(screen.getByTestId('outside-line-report'));
        const card = await screen.findByRole('dialog');
        expect(card.textContent).toContain('Report this message');
        expect(card.textContent).toContain('Reporting a request blocks its sender too.');
        fireEvent.click(screen.getByRole('button', { name: 'Spam or scam' }));
        fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
        expect(await screen.findByTestId('report-sent')).toBeTruthy();
        expect(reportOutsideLine).toHaveBeenCalledWith(here.ctx, chatId, line, 'Spam or scam');
        expect(here.blocked.has(SOL.key)).toBe(true);
        await waitFor(async () => expect((await here.ctx.store.chat(BEN.key, chatId))?.state).toBe('declined'));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('a report my server refuses: the card says so and keeps the choice; nothing is blocked', async () => {
        const { theirs } = await openWithLines();
        vi.mocked(reportOutsideLine).mockRejectedValueOnce(new Error('the server said no'));
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        fireEvent.click(await screen.findByText('Bikes at 3'));
        fireEvent.click(screen.getByTestId('outside-line-report'));
        fireEvent.click(await screen.findByRole('button', { name: 'Spam or scam' }));
        fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
        expect(await screen.findByText('That did not go through. Please try again.')).toBeTruthy();
        expect(reportOutsideLine).toHaveBeenCalledWith(here.ctx, chatId, theirs, 'Spam or scam');
        expect(screen.getByRole('button', { name: '✓ Spam or scam' })).toBeTruthy();
        expect(here.blocked.has(SOL.key)).toBe(false);
        expect((await here.ctx.store.chat(BEN.key, chatId))?.state).toBe('open');
    });

    /**
     * The rule, as the screen draws it (core outsideLineActions, the phone's table too): every line of theirs not deleted can be
     * reported, in every state of the chat; only what changes the chat (reactions, Edit, Delete) needs it open. "blocked" is a
     * chat as Block leaves it: declined, its sender blocked.
     */
    describe('what a tap on a line offers, in every state of the chat', () => {
        type State = 'request' | 'open' | 'declined' | 'blocked';
        type Line = 'theirs' | 'mine' | 'theirs, deleted' | 'mine, deleted';
        const offers = (react: boolean, edit: boolean, remove: boolean, report: boolean) => ({ react, edit, remove, report });
        const nothing = offers(false, false, false, false);
        const table: Record<State, Record<Line, ReturnType<typeof offers>>> = {
            request: { theirs: offers(false, false, false, true), mine: nothing, 'theirs, deleted': nothing, 'mine, deleted': nothing },
            open: { theirs: offers(true, false, false, true), mine: offers(true, true, true, false), 'theirs, deleted': nothing, 'mine, deleted': nothing },
            declined: { theirs: offers(false, false, false, true), mine: nothing, 'theirs, deleted': nothing, 'mine, deleted': nothing },
            blocked: { theirs: offers(false, false, false, true), mine: nothing, 'theirs, deleted': nothing, 'mine, deleted': nothing },
        };
        for (const state of Object.keys(table) as State[]) {
            for (const kind of Object.keys(table[state]) as Line[]) {
                it(`${state} chat, ${kind} line`, async () => {
                    const at = Date.now() - 10_000;
                    const line = crypto.randomUUID();
                    const mine = kind.startsWith('mine');
                    // Their line first (a request is made by their first line), then mine once it is open.
                    const theirs = mine ? crypto.randomUUID() : line;
                    await here.ctx.store.writeTheirs(BEN.key, { id: theirs, chatId, author: SOL.key, text: 'Their words', replyTo: null, at, sealed: '{}' }, { home: SOL_HOME, name: 'Sol' }, 'request');
                    if (mine) {
                        await here.ctx.store.decide(BEN.key, chatId, 'open');
                        await here.ctx.store.addMine(BEN.key, { id: line, chatId, author: BEN.key, text: 'My words', replyTo: null, at: at + 1, item: '{}' });
                        await here.ctx.store.setMineState(BEN.key, chatId, line, 'delivered');
                    }
                    if (kind.endsWith('deleted')) {
                        await here.ctx.store.putChange(BEN.key, chatId, { kind: 'dm-delete', itemId: crypto.randomUUID(), lineId: line, author: mine ? BEN.key : SOL.key, at: at + 2 });
                    }
                    if (state === 'open') await here.ctx.store.decide(BEN.key, chatId, 'open');
                    if (state === 'declined' || state === 'blocked') await here.ctx.store.decide(BEN.key, chatId, 'declined');
                    if (state === 'blocked') here.blocked.add(SOL.key);
                    if (state === 'request' && mine) {
                        // Mine in a request: no state this browser's store makes (a chat I wrote in is open or declined, and a
                        // declined one takes no new line), so the chat is read as a request here; the rule holds there too.
                        const real = here.ctx.store;
                        here.ctx.store = { ...real, chat: async (...a: Parameters<typeof real.chat>) => { const c = await real.chat(...a); return c && { ...c, state: 'request' }; } };
                    }
                    expect((await here.ctx.store.chat(BEN.key, chatId))?.state).toBe(state === 'blocked' ? 'declined' : state);
                    render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
                    await screen.findByTestId('outside-chat-kept-here');
                    const bubble = (await screen.findAllByTestId(mine ? 'outside-line-mine' : 'outside-line-theirs'))[0];
                    fireEvent.click(bubble);
                    const want = table[state][kind];
                    expect({
                        react: screen.queryAllByLabelText(/^React with/).length === 7,
                        edit: !!screen.queryByTestId('outside-line-edit'),
                        remove: !!screen.queryByTestId('outside-line-delete'),
                        report: !!screen.queryByTestId('outside-line-report'),
                    }).toEqual(want);
                    const any = Object.values(want).some(Boolean);
                    expect(bubble.getAttribute('role')).toBe(any ? 'button' : null);
                    if (!any) expect(screen.queryByTestId('outside-line-actions')).toBeNull();
                });
            }
        }
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
