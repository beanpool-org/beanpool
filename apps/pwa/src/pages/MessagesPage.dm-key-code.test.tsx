/**
 * A web DM's ⋮ menu and its read-only "Key code" (DESIGN-dm-key-signal-model §5, slice S3; §4 for the words).
 *
 * - Every DM header has a ⋮ "Chat menu" with "Key code"; a group chat's menu has no Key code.
 * - Key code shows the digits of the ONE key the chat's listing names for the other person (the key its lines are sealed
 *   to), the same digits the phone shows for that key (its own helper, loaded as it is), and the line that says this
 *   browser doesn't remember key codes. The unknown-name twins when the name isn't known; the no-code line when the
 *   listing names no single other key.
 * - The web never shows "verified" as a state: no Mark as verified, no Verified ✓, the word only inside that one sentence.
 * - The web stores nothing about keys: opening the menu, showing the code and closing it write nothing to localStorage,
 *   sessionStorage or IndexedDB.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../lib/e2e-crypto', () => ({
    dmThreadInShownOrder: (msgs: unknown[]) => msgs,
    dmQuoteFrom: vi.fn(() => null),
    dmQuoteLabel: vi.fn(() => null),
    dmLineShownText: vi.fn((v: { text: string | null } | undefined) => v?.text ?? ''),
    dmLineIsUnattributed: vi.fn(() => false),
    dmReplyToOf: vi.fn(() => null),
    decodePlaintext: vi.fn((c: string) => c),
    encodePlaintext: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    sealDmLine: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 4, after: null, conversationId: '', moved: false })),
    checkDmThread: vi.fn(() => new Map()),
    dmAfterReference: vi.fn(() => null),
    dmLineMarkText: vi.fn(() => null),
    newDmMessageId: vi.fn(() => 'msg-1'),
    isEncryptedNonce: vi.fn(() => false),
    DM_LINE_NOT_VERIFIED_TEXT: "🔒 This message couldn't be verified, so it isn't shown.",
}));

const ME: BeanPoolIdentity = { publicKey: 'a1'.repeat(32), privateKey: 'k', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const KOFI = 'bb'.repeat(32);
const NO_NAME = 'c3'.repeat(32);
const CY = 'd4'.repeat(32);
const GROUP_ID = 'group-crew-123';

const conv = (id: string, participants: string[], extra: Partial<Conversation> = {}): Conversation => ({
    id, type: 'dm', name: null, participants, createdBy: ME.publicKey, createdAt: '2026-10-01T00:00:00Z', ...extra,
} as Conversation);

const CONVERSATIONS: Record<string, Conversation> = {
    'dm-kofi': conv('dm-kofi', [ME.publicKey, KOFI], { peerCallsign: 'Kofi', peerAvatar: null }),
    'dm-no-name': conv('dm-no-name', [ME.publicKey, NO_NAME]),
    'dm-nobody': conv('dm-nobody', [ME.publicKey]),
    'dm-two-others': conv('dm-two-others', [ME.publicKey, KOFI, CY], { peerCallsign: 'Kofi' }),
    [GROUP_ID]: { id: GROUP_ID, type: 'group_thread', name: 'Garden crew', participants: [ME.publicKey, KOFI], createdBy: ME.publicKey, createdAt: '2026-10-01T00:00:00Z' } as Conversation,
};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: Object.values(CONVERSATIONS), totalUnread: 0 })),
    getConversationMessages: vi.fn(async (convId: string) => ({ conversation: CONVERSATIONS[convId], messages: [] as ApiMessage[] })),
    getMembers: vi.fn(async () => [{ publicKey: KOFI, callsign: 'Kofi' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async (groupId: string) => ({ conversation: CONVERSATIONS[groupId], messages: [], canPost: true })),
    getGroupMembers: vi.fn(async () => [
        { groupId: GROUP_ID, memberPubkey: ME.publicKey, callsign: 'Ana', role: 'member', status: 'active', joinedAt: '' },
        { groupId: GROUP_ID, memberPubkey: KOFI, callsign: 'Kofi', role: 'member', status: 'active', joinedAt: '' },
    ]),
    getMemberProfile: vi.fn(async () => { throw new Error('Not found'); }),
    getMemberRatings: vi.fn(async () => ({ average: 0, count: 0, ratings: [] })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 10, keeperOf: [] })),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
    groupKeysNet: { get: vi.fn(), post: vi.fn() },
    getMyVouching: vi.fn(async () => null),
}));

type PhoneHelper = { keyCodeOf: (k: string) => string | null; keyCodeSpoken: (c: string) => string };
/** The phone's own key code helper (apps/native/utils/key-code.ts), loaded as it is. */
async function phoneHelper(): Promise<PhoneHelper> {
    return (await import(/* @vite-ignore */ path.resolve(__dirname, '../../../native/utils/key-code.ts'))) as PhoneHelper;
}

async function openChat(id: string) {
    render(<MessagesPage identity={ME} openConversationId={id} onOpenProfile={vi.fn()} />);
    await screen.findByRole('button', { name: 'Back to chats' });
}

function openKeyCode() {
    fireEvent.click(screen.getByTestId('dm-chat-menu-toggle'));
    const menu = screen.getByRole('dialog', { name: 'Chat menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Key code' }));
    return screen.getByRole('dialog', { name: 'Key code' });
}

/** Every word "verified" in the dialog sits inside the one sentence that says the phone app can mark someone. */
function expectNoVerifiedState(dialog: HTMLElement, sentence: string) {
    const rest = (dialog.textContent || '').split(sentence).join('');
    expect(rest).not.toMatch(/verif/i);
    expect(within(dialog).queryByRole('button', { name: /verif/i })).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
}

describe('web DM: ⋮ → Key code (read only)', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it("shows the listed key's digits, the same as the phone's for that key, with the browser line and no verified state", async () => {
        const phone = await phoneHelper();
        await openChat('dm-kofi');
        const toggle = screen.getByTestId('dm-chat-menu-toggle');
        expect(toggle).toHaveAccessibleName('Chat menu');
        expect(toggle.tagName).toBe('BUTTON');

        const dialog = openKeyCode();
        expect(within(dialog).getByRole('heading', { name: "Kofi's key code" })).toBeInTheDocument();
        const digits = within(dialog).getByTestId('dm-key-code-digits');
        expect(digits.textContent).toBe(phone.keyCodeOf(KOFI));
        expect(digits.textContent).toBe('1479 0507 0978 3849 9965');
        // Spoken digit by digit (hidden text beside the aria-hidden groups: a paragraph can't carry an aria-label).
        expect(digits).toHaveAttribute('aria-hidden', 'true');
        expect(within(dialog).getByText(`Key code: ${phone.keyCodeSpoken(phone.keyCodeOf(KOFI)!)}`)).toHaveClass('sr-only');
        const line = "This browser doesn't remember key codes. The phone app can mark Kofi as verified and ask you if the code changes.";
        expect(within(dialog).getByText(line)).toBeInTheDocument();
        expectNoVerifiedState(dialog, line);
        // Focus went to the new heading, not to the page behind.
        expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Key code' }));
    });

    it('the unknown-name twins when the chat has no name for the other person', async () => {
        const phone = await phoneHelper();
        await openChat('dm-no-name');
        const dialog = openKeyCode();
        expect(within(dialog).getByRole('heading', { name: "This chat's key code" })).toBeInTheDocument();
        expect(within(dialog).getByTestId('dm-key-code-digits').textContent).toBe(phone.keyCodeOf(NO_NAME));
        const line = "This browser doesn't remember key codes. The phone app can mark this person as verified and ask you if the code changes.";
        expect(within(dialog).getByText(line)).toBeInTheDocument();
        expectNoVerifiedState(dialog, line);
    });

    it('no single other key listed (nobody, or two others): the no-code line and no digits', async () => {
        for (const id of ['dm-nobody', 'dm-two-others']) {
            await openChat(id);
            const dialog = openKeyCode();
            expect(within(dialog).getByText('There is no key code to show for this chat yet.')).toBeInTheDocument();
            expect(within(dialog).queryByTestId('dm-key-code-digits')).toBeNull();
            expect(dialog.textContent).not.toMatch(/\d{4} \d{4}/);
            cleanup();
        }
    });

    it('writes nothing to localStorage, sessionStorage or IndexedDB from opening the menu to closing it', async () => {
        await openChat('dm-kofi');
        const writes: string[] = [];
        for (const name of ['setItem', 'removeItem', 'clear'] as const) {
            vi.spyOn(localStorage, name).mockImplementation(((...args: unknown[]) => { writes.push(`localStorage.${name}(${String(args[0] ?? '')})`); }) as never);
            vi.spyOn(Storage.prototype, name).mockImplementation(((...args: unknown[]) => { writes.push(`Storage.${name}(${String(args[0] ?? '')})`); }) as never);
        }
        const idb = { open: vi.fn(() => { writes.push('indexedDB.open'); return {}; }), deleteDatabase: vi.fn(() => { writes.push('indexedDB.deleteDatabase'); return {}; }) };
        vi.stubGlobal('indexedDB', idb);

        const dialog = openKeyCode();
        expect(within(dialog).getByTestId('dm-key-code-digits')).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close menu' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        // Opened again, it starts at the menu: nothing was kept from the first look.
        fireEvent.click(screen.getByTestId('dm-chat-menu-toggle'));
        expect(screen.getByRole('dialog', { name: 'Chat menu' })).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();

        expect(writes).toEqual([]);
        expect(idb.open).not.toHaveBeenCalled();
    });

    it("a group chat's menu has no Key code, and no DM ⋮ is drawn there", async () => {
        render(<MessagesPage identity={ME} openConversationId={GROUP_ID} onNavigate={vi.fn()} onOpenProfile={vi.fn()} />);
        await screen.findByRole('button', { name: 'Back to chats' });
        expect(screen.queryByTestId('dm-chat-menu-toggle')).toBeNull();
        fireEvent.click(screen.getByTestId('group-chat-menu-toggle'));
        const menu = screen.getByRole('dialog', { name: 'Chat menu' });
        expect(within(menu).queryByRole('button', { name: 'Key code' })).toBeNull();
    });
});
