/**
 * Voice messages on the web (DESIGN-cross-chat-voice-fable.md §5.5, slice V4), through the real chat page: a voice line plays
 * in a direct and a group chat (its words opened first), the 30-day 410 is said in plain words, quotes say "🎤 Voice
 * message", a voice line has no Edit; the microphone shows only where the community says it takes voice lines and the
 * browser writes AAC in .m4a, never in a request, and Firefox gets one line instead; and a recording is sent sealed, under one
 * line id on every try, and kept when a send is refused. A recorder that won't start lets the microphone go; the 60 s give-up
 * stops when the node takes the line, not after the chat's reload; the waveform's sound is started where Safari leaves it
 * suspended. A click on the microphone, or words typed, the moment the chat shows are not undone by the chat's opening.
 */
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { openDmVoice, sealDmVoice, VOICE_BARS, VOICE_MIME } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { getConversationMessages, sendMessageApi } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine, sealVoice } from '../lib/group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { lockForDm } from '../lib/dm-lock';
import { stopVoicePlayer } from '../lib/voice-player';

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

let communityInfo: { features: Record<string, unknown> } = { features: { voiceLines: true } };
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => communityInfo),
}));

const DM_CONV = 'c0ffee00-1111-4222-8333-444455556666';
const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';

const ana = person(true);
const ben = person();
const identity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

const dmChat = { id: DM_CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };
let dmConversation: Conversation;
const groupConversation = {
    id: G, type: 'group_thread', name: 'Working Bee', participants: [ana.publicKey, ben.publicKey], createdBy: ben.publicKey,
    unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
} as Conversation;

let node: FakeGroupNode;
let benEpoch: { epoch: number; key: Uint8Array };
let dmMessages: ApiMessage[] = [];
/** The chat's reload never answering (a slow uplink), from the moment the node takes a line. */
let reloadHangs = false;
const dmAttachments = new Map<string, { data: string; nonce: string; mime: string } | { status: number; code?: string }>();

/** The head of an .m4a: an `ftyp` box (16 bytes) and more of the file, which is all core's checks ask of the sound. */
const M4A = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76, 1, 2, 3, 4]);
const BARS = Array.from({ length: VOICE_BARS }, (_, i) => (i * 5) % 256);

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [dmConversation, groupConversation], totalUnread: 0 })),
    getConversationMessages: vi.fn(async (id: string) => {
        if (reloadHangs) return new Promise(() => {});
        return id === DM_CONV ? { conversation: dmConversation, messages: dmMessages } : { conversation: null, messages: [] };
    }),
    getGroupChat: vi.fn(async (id: string) => {
        if (id !== G) return { conversation: null, messages: [], canPost: false };
        return {
            conversation: groupConversation,
            messages: node.lines.map((l, i) => ({
                id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: l.type ?? 'text',
                metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.UTC(2026, 10, 12, 9, i)).toISOString(), editedAt: null,
            })),
            canPost: true,
            encryption: { current: node.current(), stale: false, fromEpoch: 1 },
        };
    }),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({
        groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '',
    }))),
    getMembers: vi.fn(async () => [{ publicKey: ana.publicKey, callsign: 'Ana' }, { publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(async (messageId: string) => {
        const att = dmAttachments.get(messageId);
        if (!att) throw Object.assign(new Error('Attachment not found'), { status: 404 });
        if ('status' in att) throw Object.assign(new Error('Gone'), att);
        return att;
    }),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

function dmVoiceFrom(from: typeof ana, durationMs = 2300, replyToId: string | null = null): ApiMessage {
    const id = crypto.randomUUID();
    const peer = from === ana ? ben : ana;
    const body = lockForDm('', dmChat, from, { messageId: id, replyToId });
    const v = sealDmVoice({ durationMs, bars: BARS, sound: M4A }, { myEdPrivHex: from.privateKey, peerEdPubHex: peer.publicKey, conversationId: DM_CONV },
        { senderPubHex: from.publicKey, messageId: id, replyToId });
    dmAttachments.set(id, { data: v.ciphertext, nonce: v.nonce, mime: VOICE_MIME });
    return {
        id, conversationId: DM_CONV, authorPubkey: from.publicKey, ciphertext: body.ciphertext, nonce: body.nonce, type: 'voice',
        metadata: replyToId ? JSON.stringify({ replyToId }) : undefined, timestamp: new Date().toISOString(),
    } as ApiMessage;
}

function dmWords(from: typeof ana, text: string, replyToId?: string): ApiMessage {
    const id = crypto.randomUUID();
    const body = lockForDm(text, dmChat, from, { messageId: id, replyToId: replyToId ?? null });
    return {
        id, conversationId: DM_CONV, authorPubkey: from.publicKey, ciphertext: body.ciphertext, nonce: body.nonce, type: 'text',
        metadata: replyToId ? JSON.stringify({ replyToId }) : undefined, timestamp: new Date().toISOString(),
    } as ApiMessage;
}

function benGroupVoice(durationMs = 4100): string {
    const id = crypto.randomUUID();
    const bind = { myEdPrivHex: ben.privateKey, groupKey: benEpoch.key, groupId: G, epoch: benEpoch.epoch, messageId: id };
    const body = sealLine('', bind);
    const v = sealVoice({ durationMs, bars: BARS, sound: M4A }, { ...bind, after: null });
    node.lines.push({
        id, author: ben.publicKey, ciphertext: body.ciphertext, nonce: body.nonce, type: 'voice',
        metadata: { epoch: benEpoch.epoch, sender: ben.publicKey }, attachment: { data: v.ciphertext, nonce: v.nonce, mime: VOICE_MIME },
    });
    return id;
}

/** A browser that writes AAC in .m4a (Chrome, Edge, Safari), or not (Firefox), on a secure page. */
let recorderWrites = true;
let recorderOptions: unknown[] = [];
/** A recorder whose start() throws (an encoder the browser turns down at start, a track that ended before it). */
let startThrows = false;
class FakeMediaRecorder {
    static isTypeSupported(type: string) { return recorderWrites && type.startsWith('audio/mp4'); }
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: unknown, opts: unknown) { recorderOptions.push(opts); }
    start() {
        if (startThrows) throw new DOMException('The encoder was turned down.', 'NotSupportedError');
        this.state = 'recording';
    }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([M4A]) });
        this.onstop?.();
    }
}
/** The waveform's sound; made suspended, as Safari can make one outside a click. */
class FakeAudioContext {
    static made: FakeAudioContext[] = [];
    state: AudioContextState = 'suspended';
    resume = vi.fn(async () => { this.state = 'running'; });
    close = vi.fn(async () => { this.state = 'closed'; });
    constructor() { FakeAudioContext.made.push(this); }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (f: Float32Array) => f.fill(0.1) }; }
    createMediaStreamSource() { return { connect: () => {} }; }
}
const track = { stop: vi.fn(), onended: null as null | (() => void) };
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
let clock = 1000;

/** The open chat's effects have run: its first read of the chat (only they and a send read it, and nothing is sent yet). */
const chatEffectsRan = () => vi.mocked(getConversationMessages).mock.calls.some(([id]) => id === DM_CONV);

/**
 * Acts on an element the moment React draws it: in the MutationObserver's microtask right after the commit that drew it,
 * the earliest a member could. React 19 yields to the browser after a commit that asks for a paint and runs its plain
 * effects in a later task, so a chat's "just opened" effects used to come after that moment and undo what was done in it.
 * On a loaded machine a findBy* resolved in that gap too (CI, 14 Nov: "Unable to find role="button" and name "Stop
 * recording"" twice, and a typed "hi" emptied once). Here the gap is certain, not up to the machine's load.
 */
function actTheMomentItShows(container: HTMLElement, find: () => HTMLElement | null, then: (el: HTMLElement) => void) {
    return new Promise<void>((resolve) => {
        const look = () => {
            const el = find();
            if (!el) return;
            observer.disconnect();
            then(el);
            resolve();
        };
        const observer = new MutationObserver(look);
        observer.observe(container, { childList: true, subtree: true, attributes: true });
        look();
    });
}

describe('voice messages on the web (V4)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetGroupChatLockStoreForTest();
        forgetGroupKeys();
        dmMessages = [];
        dmAttachments.clear();
        communityInfo = { features: { voiceLines: true } };
        recorderWrites = true;
        recorderOptions = [];
        startThrows = false;
        reloadHangs = false;
        FakeAudioContext.made = [];
        dmConversation = {
            id: DM_CONV, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, peerCallsign: 'Ben',
            unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
        } as Conversation;
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('isSecureContext', true);
        Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
        clock = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => 'probably');
        HTMLMediaElement.prototype.play = vi.fn(async () => {});
        HTMLMediaElement.prototype.pause = vi.fn();
        HTMLMediaElement.prototype.load = vi.fn();
        URL.createObjectURL = vi.fn(() => 'blob:voice');
        URL.revokeObjectURL = vi.fn();

        node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
        const id = crypto.randomUUID();
        const sealed = sealLine('Hello group', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
        node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
        benEpoch = { epoch, key };
        forgetGroupKeys();
    });

    afterEach(() => {
        cleanup();
        stopVoicePlayer();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('a DM voice line plays as a voice message, its length from inside the seal; no empty bubble', async () => {
        dmMessages = [dmVoiceFrom(ben, 2300)];
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        const play = await screen.findByRole('button', { name: 'Play voice message, 0:02' });
        expect(screen.getByTestId('voice-clock').textContent).toBe('0:02');
        expect(screen.getByRole('button', { name: 'Playback speed 1×' })).toBeTruthy();
        fireEvent.click(play);
        await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
        fireEvent.click(screen.getByRole('button', { name: 'Playback speed 1×' }));
        expect(await screen.findByRole('button', { name: 'Playback speed 1.5×' })).toBeTruthy();
    });

    it('the 30-day 410 says so in plain words; a part that fails its checks says it can\'t be played', async () => {
        const expired = dmVoiceFrom(ben);
        dmAttachments.set(expired.id, { status: 410, code: 'voice_expired' });
        const swapped = dmVoiceFrom(ben);
        // Another line's sealed part under this line's id: it doesn't open as this message's voice part.
        const other = dmVoiceFrom(ben);
        dmAttachments.set(swapped.id, dmAttachments.get(other.id)!);
        dmMessages = [expired, swapped];
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        expect(await screen.findByText('This voice message is no longer on the server.')).toBeTruthy();
        expect(await screen.findByText("This voice message can't be played.")).toBeTruthy();
    });

    it('a group voice line plays, opened under its epoch key and signer', async () => {
        benGroupVoice(4100);
        render(<MessagesPage identity={identity} openConversationId={G} />);
        expect(await screen.findByRole('button', { name: 'Play voice message, 0:04' })).toBeTruthy();
    });

    it('a reply to a voice line quotes it as a voice message', async () => {
        const voice = dmVoiceFrom(ben);
        dmMessages = [voice, dmWords(ana, 'Got it', voice.id)];
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await screen.findByText('Got it');
        expect(screen.getAllByText('🎤 Voice message').length).toBeGreaterThan(0);
    });

    it('my own voice line has no Edit', async () => {
        dmMessages = [dmVoiceFrom(ana)];
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await screen.findByRole('button', { name: 'Play voice message, 0:02' });
        expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    });

    it('the microphone shows with the box empty where the community takes voice lines; typing gives Send back', async () => {
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        const mic = await screen.findByRole('button', { name: 'Record a voice message' });
        expect(mic).toBeTruthy();
        fireEvent.change(screen.getByPlaceholderText('Message...'), { target: { value: 'hi' } });
        expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    });

    it('a click on the microphone the moment the chat shows records: opening the chat doesn\'t throw that recording away', async () => {
        const { container } = render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await actTheMomentItShows(container, () => container.querySelector<HTMLElement>('[data-testid="voice-mic"]'), (mic) => fireEvent.click(mic));
        await screen.findByRole('button', { name: 'Stop recording' });
        await waitFor(() => expect(chatEffectsRan()).toBe(true));
        // The chat's effects have run since, and the recording is still going.
        expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(track.stop).not.toHaveBeenCalled();
    });

    it('words typed the moment the chat shows stay in the box: opening the chat doesn\'t empty it after', async () => {
        const { container } = render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await actTheMomentItShows(container, () => container.querySelector<HTMLElement>('textarea'),
            (box) => fireEvent.change(box, { target: { value: 'hi' } }));
        await waitFor(() => expect(chatEffectsRan()).toBe(true));
        expect((screen.getByPlaceholderText('Message...') as HTMLTextAreaElement).value).toBe('hi');
        expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    });

    it('no microphone where the community says nothing of voice lines (a node from before V2), and asks for nothing', async () => {
        communityInfo = { features: {} };
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await screen.findByPlaceholderText('Message...');
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('Firefox (no AAC recorder): one line instead of a microphone, in a DM and a locked group', async () => {
        recorderWrites = false;
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        expect(await screen.findByText("This browser can't record voice messages. Chrome, Edge, Safari and the phone app can.")).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
        cleanup();
        render(<MessagesPage identity={identity} openConversationId={G} />);
        expect(await screen.findByText("This browser can't record voice messages. Chrome, Edge, Safari and the phone app can.")).toBeTruthy();
    });

    it('no microphone in a message request, either way', async () => {
        dmConversation = { ...dmConversation, request: { from: ana.publicKey, state: 'pending', at: '2026-09-01T00:00:00Z', nextLineIsRequest: true } } as Conversation;
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        await screen.findByPlaceholderText('Message...');
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    });

    it('a recording is sent sealed as part voice, one line id on every try, and kept when the send is refused', async () => {
        const sends: any[] = [];
        let refuse = true;
        vi.mocked(sendMessageApi).mockImplementation(async (...args: any[]) => {
            sends.push(args);
            if (refuse) throw Object.assign(new Error('Nothing was sent; try again in a moment.'), { status: 503 });
            return { success: true, message: { id: args[7] } } as any;
        });
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        // The browser asks at the first click, never before.
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
        await screen.findByRole('button', { name: 'Stop recording' });
        expect(recorderOptions[0]).toEqual({ mimeType: 'audio/mp4;codecs=mp4a.40.2', audioBitsPerSecond: 32_000 });
        clock += 2300;
        fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
        await waitFor(() => expect(sends).toHaveLength(1));
        const [conv, author, , , type, attachment, , id] = sends[0];
        expect([conv, author, type, attachment.mime]).toEqual([DM_CONV, ana.publicKey, 'voice', 'audio/mp4']);
        // Ben opens it as this message's voice part, from Ana, under their two keys.
        const opened = openDmVoice({ ciphertext: attachment.data, nonce: attachment.nonce }, { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey },
            { conversationId: DM_CONV, senderPubHex: ana.publicKey, messageId: id });
        expect(opened.durationMs).toBe(2300);
        expect(Array.from(opened.sound)).toEqual(Array.from(M4A));
        // Refused: the recording is kept, back for play, bin and Send.
        expect(await screen.findByRole('button', { name: 'Play recording' })).toBeTruthy();
        refuse = false;
        fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
        await waitFor(() => expect(sends).toHaveLength(2));
        expect(sends[1][7]).toBe(id);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeTruthy());
    });

    it('a community that no longer says it takes voice lines at Send gets nothing: the recording is kept and the chat says why', async () => {
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        await screen.findByRole('button', { name: 'Stop recording' });
        clock += 2000;
        fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
        await screen.findByRole('button', { name: 'Play recording' });
        // The info the page holds now says nothing of voice lines (core voiceLinesOn reads it at Send, as the phone does).
        delete communityInfo.features.voiceLines;
        fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
        expect(await screen.findByText("This community doesn't take voice messages yet. Nothing was sent.")).toBeTruthy();
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Play recording' })).toBeTruthy();
    });

    it('under a second sends nothing and says so', async () => {
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        await screen.findByRole('button', { name: 'Stop recording' });
        clock += 600;
        fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
        expect(await screen.findByText('Too short to send. Record for at least a second.')).toBeTruthy();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a recorder that won\'t start lets the microphone go: the track stopped, the sound closed, no clock left running', async () => {
        startThrows = true;
        vi.stubGlobal('AudioContext', FakeAudioContext);
        const started = vi.spyOn(globalThis, 'setInterval');
        const cleared = vi.spyOn(globalThis, 'clearInterval');
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        expect(await screen.findByText('The recording stopped. Nothing was sent.')).toBeTruthy();
        await waitFor(() => expect(track.stop).toHaveBeenCalled());
        await waitFor(() => expect(FakeAudioContext.made[0]?.close).toHaveBeenCalled());
        // The recorder's clock ticks every 100 ms: any it started was stopped.
        const clocks = started.mock.calls.flatMap((c, i) => (c[1] === 100 ? [started.mock.results[i].value] : []));
        expect(clocks.filter((id) => !cleared.mock.calls.some((c) => c[0] === id))).toEqual([]);
        expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeTruthy();
    });

    it('the minute for a send stops when the node takes the line: a slow reload after it doesn\'t hold the recorder', async () => {
        vi.mocked(sendMessageApi).mockImplementation(async (...args: any[]) => {
            reloadHangs = true;
            return { success: true, message: { id: args[7] } } as any;
        });
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        await screen.findByRole('button', { name: 'Stop recording' });
        clock += 2300;
        fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        // Sent, with the chat's reload still out: the recorder is done and the microphone is back.
        expect(await screen.findByRole('button', { name: 'Record a voice message' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Play recording' })).toBeNull();
        expect(reloadHangs).toBe(true);
    });

    it('the waveform\'s sound is started where the browser makes it suspended (Safari)', async () => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        await screen.findByRole('button', { name: 'Stop recording' });
        expect(FakeAudioContext.made).toHaveLength(1);
        expect(FakeAudioContext.made[0].resume).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Delete recording' }));
        await waitFor(() => expect(FakeAudioContext.made[0].close).toHaveBeenCalled());
    });

    it('nothing plays while a recording is going', async () => {
        dmMessages = [dmVoiceFrom(ben)];
        render(<MessagesPage identity={identity} openConversationId={DM_CONV} />);
        const play = await screen.findByRole('button', { name: 'Play voice message, 0:02' });
        fireEvent.click(await screen.findByRole('button', { name: 'Record a voice message' }));
        await screen.findByRole('button', { name: 'Stop recording' });
        expect((play as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(play);
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });
});
