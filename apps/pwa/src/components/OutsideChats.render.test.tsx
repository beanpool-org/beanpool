/**
 * The screens of messages across communities on the web (X4b): components/AddressCardPanel.tsx and components/OutsideChats.tsx,
 * drawn over the real outside-chat store (lib/outside-chat-store.ts on the in-memory IndexedDB) with the round itself stood in
 * for (lib/outside-mail.test.ts plays it against the mailbox).
 *
 * What is checked: Fable's words (DECISION-outside-door.md, X2b) where the phone shows them, from core: the switch ends "in this
 * browser", "Each phone or browser you use has its own switch." under it, and the chat's banner says "What you write on another
 * phone or browser shows only there." under "Kept in this browser only."; showing my card opens this browser's door and the
 * switch closes it; a blocked person's card opens no box; a request takes no reply until Accept; an open chat has its box.
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

const here = vi.hoisted(() => ({ ctx: null as any, blocked: new Set<string>() }));
vi.mock('../lib/outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/outside-mail')>();
    const core = await import('@beanpool/core');
    const { hexToBytes: hex } = await import('@noble/hashes/utils.js');
    return {
        ...real,
        outsideContext: async () => here.ctx,
        outsideMessagesHere: async () => true,
        syncOutsideMailNow: async () => null,
        myHome: async () => HOME,
        myAddressCard: async (ctx: any) => core.signAddressCard({ key: ctx.identity.publicKey, home: HOME, name: 'Ben' }, core.ed25519Signer(hex(ctx.identity.privateKey))),
        sendFromBox: vi.fn(async () => ({ kept: true, error: null })),
    };
});

import { outsideChatStore, clearOutsideChats } from '../lib/outside-chat-store';
import { doorOpen } from '../lib/outside-mail';
import { AddressCardPanel } from './AddressCardPanel';
import { OutsideChatThread } from './OutsideChats';

const chatId = relayConversationId(BEN.key, SOL.key);

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    await clearOutsideChats();
    here.blocked = new Set();
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

    it('a request: its one line, Accept / Decline / Block, no box until Accept; Accept opens it', async () => {
        await here.ctx.store.writeTheirs(BEN.key, { id: crypto.randomUUID(), chatId, author: SOL.key, text: 'Hello Ben', replyTo: null, at: Date.now() }, { home: SOL_HOME, name: 'Sol' }, 'request');
        render(<OutsideChatThread chatId={chatId} onBack={() => {}} />);
        expect(await screen.findByTestId('outside-request')).toBeTruthy();
        expect(screen.getByText('Hello Ben')).toBeTruthy();
        expect(screen.getByTestId('outside-chat-writes-stay')).toBeTruthy();
        expect(screen.queryByTestId('outside-chat-input')).toBeNull();
        fireEvent.click(screen.getByTestId('outside-request-accept'));
        expect(await screen.findByTestId('outside-chat-input')).toBeTruthy();
        expect((await here.ctx.store.chat(BEN.key, chatId))?.state).toBe('open');
    });
});
