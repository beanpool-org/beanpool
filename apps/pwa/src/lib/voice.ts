/**
 * Voice messages on the web (scratch/fable-design/DESIGN-cross-chat-voice-fable.md §5.5, slice V4): the rules, with nothing of
 * the page in them. The phone's twins are apps/native/utils/voice-recorder.ts and utils/dm-voice.ts (V3, #3112); the sound
 * format, the part and its checks are core's (voice.ts, V1), the node's side is V2 (#3111).
 *
 * Where the microphone shows: only where the chat's community says it takes voice lines (`features.voiceLines`, read by
 * nodeTakesVoice alone, so its name changes in one place), and only where this browser can write the one format every phone
 * plays (AAC in .m4a, VOICE_RECORD_TYPE): Chrome, Edge and Safari. Firefox can't, and gets one line instead of a microphone;
 * so does a page on a plain http address, where no browser gives the microphone (lights-out mode on the hall Wi-Fi).
 *
 * Recording on the web is the phone's tap mode (its screen reader and largest-text mode): a click starts, Stop keeps it for
 * play, bin and Send, Send sends. A mouse has no slide to cancel or lock, so the web has the bin and Stop instead. Under one
 * second sends nothing; at 3:00 it stops by itself and waits for Send. The browser asks for the microphone at the first
 * click, never before.
 */
import {
    openDmVoice, VOICE_BARS, VOICE_MAX_MS, word,
    type DmKeys, type VoicePart, type WordKey,
} from '@beanpool/core';

/**
 * The web's voice sentences (word() keys, shown through t()). The ones the phone also says are the phone's own English
 * (apps/native components/chat/VoiceBubble.tsx, VoiceRecorder.tsx, utils/db.ts), so both read the same in every language.
 */
export const VOICE_WORDS = {
    /** In the microphone's place, where the browser can't write AAC in .m4a (Firefox). */
    cantRecordBrowser: word("This browser can't record voice messages. Chrome, Edge, Safari and the phone app can."),
    /** In the microphone's place, on a plain http address: no browser gives the microphone there. */
    cantRecordAddress: word("Voice messages can't be recorded on this address. The phone app can."),
    short: word('Too short to send. Record for at least a second.'),
    denied: word("The microphone is off for this site. Allow it in the browser's site settings, then try again."),
    failed: word('The recording stopped. Nothing was sent.'),
    /** The bubble's states, the phone's words. */
    gone: word('This voice message is no longer on the server.'),
    refused: word("This voice message can't be played."),
    unavailable: word('Voice message unavailable. Tap to try again.'),
    /** This browser can't decode .m4a at all (Firefox on a Linux machine with no AAC decoder, §5.5). */
    cantPlayHere: word("This voice message can't be played in this browser."),
    loading: word('Loading voice message…'),
    /** A voice line in quotes, the reply banner and the Home chat card: the phone's words. */
    line: word('🎤 Voice message'),
    /** A voice line from a request: never fetched until accepted (§3.5); the phone's words. */
    closed: word('Voice message: shown when you accept'),
    givenUp: word('Sending the voice message is taking too long — please try again.'),
    cantSend: word("This voice message can't be sent. Record it again."),
    notInThisChat: word("Voice messages can't be sent in this chat."),
    failedToSend: word('Could not send the voice message.'),
    waitForLast: word('Wait for the last message to go.'),
} as const satisfies Record<string, WordKey>;

/** The type the recorder asks the browser for: AAC (mp4a.40.2) in an .m4a file, the format every phone plays (§5.2). */
export const VOICE_RECORD_TYPE = 'audio/mp4;codecs=mp4a.40.2';
/** The bit rate asked of the browser's encoder (§5.2: 32 kbps, as both phones record). */
export const VOICE_BITS_PER_SECOND = 32_000;
/** Shorter than this, sent or stopped, is nothing. */
export const VOICE_MIN_MS = 1000;
/** A voice send that hasn't answered by now is given up for real (its request aborted), as the phone's 60 s. */
export const VOICE_SEND_GIVE_UP_MS = 60_000;

/**
 * The community says it takes voice lines: `features.voiceLines === true` on its info (GET /api/community/info). Absent, as on
 * a node from before V2 (Byron 1.4.1), is no: such a node stores a voice line as an empty text line. The flag's name is read
 * here and nowhere else (the node's flag is added by the lane feat/voice-mic-when-node-takes-it).
 */
export function nodeTakesVoice(info: { features?: unknown } | null | undefined): boolean {
    const features = info?.features as Record<string, unknown> | null | undefined;
    return !!features && typeof features === 'object' && features.voiceLines === true;
}

/** Whether this browser can record a voice message here: 'yes', 'no-format' (Firefox: no AAC recorder), 'no-microphone' (http). */
export type VoiceRecordable = 'yes' | 'no-format' | 'no-microphone';

interface RecordEnv {
    MediaRecorder?: { isTypeSupported?: (type: string) => boolean };
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } };
}

/**
 * What this browser can do, read when the chat draws its composer. The format first: Firefox has a recorder but no AAC
 * encoder, so it says "this browser" wherever it is opened; then the microphone, which no browser gives a plain http page.
 */
export function browserRecordsVoice(env: RecordEnv = globalThis as unknown as RecordEnv): VoiceRecordable {
    let writes = false;
    try { writes = typeof env.MediaRecorder?.isTypeSupported === 'function' && env.MediaRecorder.isTypeSupported(VOICE_RECORD_TYPE) === true; } catch { writes = false; }
    if (!writes) return 'no-format';
    if (env.isSecureContext === false || typeof env.navigator?.mediaDevices?.getUserMedia !== 'function') return 'no-microphone';
    return 'yes';
}

/** The line shown in the microphone's place when this browser can't record (none when it can): a word() key. */
export function voiceCantRecordWords(can: VoiceRecordable): WordKey | null {
    if (can === 'no-format') return VOICE_WORDS.cantRecordBrowser;
    if (can === 'no-microphone') return VOICE_WORDS.cantRecordAddress;
    return null;
}

/** Whether this browser can play an .m4a at all (Firefox on Linux with no AAC decoder can't): '' from canPlayType is no. */
export function browserPlaysVoice(doc: Pick<Document, 'createElement'> | null = typeof document === 'undefined' ? null : document): boolean {
    try {
        const a = doc?.createElement('audio') as HTMLAudioElement | undefined;
        return !!a && typeof a.canPlayType === 'function' && a.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '';
    } catch {
        return false;
    }
}

// ─── The recorder's steps ──────────────────────────────────────────────────────────────────────────────────────────

/** Why the recorder is idle with a line to show: too short, the microphone refused, or it stopped on its own. */
export type VoiceHint = 'short' | 'denied' | 'failed' | null;

export type VoiceRecorderState =
    | { phase: 'idle'; hint: VoiceHint }
    /** The first click: the browser is asking for the microphone. Nothing is recorded. */
    | { phase: 'asking' }
    | { phase: 'recording'; ms: number }
    /** Stopped and kept: play, bin or Send. `limit`: it stopped itself at 3:00. */
    | { phase: 'review'; ms: number; limit: boolean }
    /** Send was pressed: it is going; nothing new records until it has gone or come back unsent. */
    | { phase: 'sending'; ms: number };

export type VoiceRecorderEvent =
    | { type: 'start' }
    | { type: 'permission'; granted: boolean }
    | { type: 'tick'; ms: number }
    | { type: 'stop' }
    | { type: 'cancel' }
    | { type: 'send' }
    /** The send went: the recording is done with. */
    | { type: 'sent' }
    /** The send didn't go (refused, given up, offline): the recording is kept, back for play, bin and Send. */
    | { type: 'unsent' }
    /** The recorder failed to start, the browser took the microphone away, or nothing was written to send. */
    | { type: 'failed' }
    | { type: 'dismiss' };

/**
 * What the component does after a step: 'ask' the browser for the microphone; 'start' recording; 'keep' stop and keep the
 * file; 'send' stop if still recording, then send; 'discard' stop if still recording and throw the file away.
 */
export type VoiceRecorderEffect = 'ask' | 'start' | 'keep' | 'send' | 'discard' | null;

export const VOICE_IDLE: VoiceRecorderState = { phase: 'idle', hint: null };

export interface VoiceRecorderStep {
    state: VoiceRecorderState;
    effect: VoiceRecorderEffect;
}

/** One step of the recorder. Pure. */
export function voiceRecorderStep(state: VoiceRecorderState, event: VoiceRecorderEvent): VoiceRecorderStep {
    const same = { state, effect: null };
    switch (event.type) {
        case 'start':
            return state.phase === 'idle' ? { state: { phase: 'asking' }, effect: 'ask' } : same;
        case 'permission':
            if (state.phase !== 'asking') return same;
            return event.granted ? { state: { phase: 'recording', ms: 0 }, effect: 'start' } : { state: { phase: 'idle', hint: 'denied' }, effect: null };
        case 'tick': {
            if (state.phase !== 'recording') return same;
            const ms = Math.max(state.ms, Math.floor(event.ms));
            if (ms >= VOICE_MAX_MS) return { state: { phase: 'review', ms: VOICE_MAX_MS, limit: true }, effect: 'keep' };
            return { state: { phase: 'recording', ms }, effect: null };
        }
        case 'stop':
            if (state.phase !== 'recording') return same;
            if (state.ms < VOICE_MIN_MS) return { state: { phase: 'idle', hint: 'short' }, effect: 'discard' };
            return { state: { phase: 'review', ms: state.ms, limit: false }, effect: 'keep' };
        case 'cancel':
            return state.phase === 'recording' || state.phase === 'review' || state.phase === 'asking' ? { state: VOICE_IDLE, effect: 'discard' } : same;
        case 'send':
            if (state.phase !== 'recording' && state.phase !== 'review') return same;
            if (state.ms < VOICE_MIN_MS) return { state: { phase: 'idle', hint: 'short' }, effect: 'discard' };
            return { state: { phase: 'sending', ms: state.ms }, effect: 'send' };
        case 'sent':
            return state.phase === 'sending' ? { state: VOICE_IDLE, effect: 'discard' } : same;
        case 'unsent':
            return state.phase === 'sending' ? { state: { phase: 'review', ms: state.ms, limit: state.ms >= VOICE_MAX_MS }, effect: null } : same;
        case 'failed':
            return state.phase === 'recording' || state.phase === 'asking' || state.phase === 'sending'
                ? { state: { phase: 'idle', hint: 'failed' }, effect: 'discard' } : same;
        case 'dismiss':
            return state.phase === 'idle' && state.hint ? { state: VOICE_IDLE, effect: null } : same;
    }
}

/** The recorder's line for an idle hint: a word() key. */
export function voiceHintWords(hint: VoiceHint): WordKey | null {
    if (hint === 'short') return VOICE_WORDS.short;
    if (hint === 'denied') return VOICE_WORDS.denied;
    if (hint === 'failed') return VOICE_WORDS.failed;
    return null;
}

/** The quietest level drawn as more than nothing, in dBFS: the phone's floor, so both draw a voice the same. */
const FLOOR_DB = -50;

/** A level in dBFS from one frame of samples (-1 to 1): its loudness, -Infinity for silence. */
export function levelDb(samples: ArrayLike<number>): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * The waveform the sender draws while recording (§5.4): VOICE_BARS whole numbers, 0 to 255, from the levels heard (dBFS, one
 * a tick). Each bar is the loudest level in its share, mapped as the phone maps expo-audio's metering. None: a flat line.
 */
export function voiceBarsFromLevels(levels: readonly number[]): number[] {
    const bars: number[] = [];
    for (let i = 0; i < VOICE_BARS; i++) {
        const from = Math.floor((i * levels.length) / VOICE_BARS);
        const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / VOICE_BARS));
        let loudest = -Infinity;
        for (let j = from; j < to && j < levels.length; j++) if (Number.isFinite(levels[j]) && levels[j] > loudest) loudest = levels[j];
        const share = loudest === -Infinity ? 0 : Math.min(1, Math.max(0, (loudest - FLOOR_DB) / -FLOOR_DB));
        bars.push(Math.round(share * 255));
    }
    return bars;
}

/** A length as the bubble and the recorder show it: 0:07, 1:42, 3:00. */
export function voiceClock(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The speeds the bubble steps through (§5.5), remembered in this browser. */
export const VOICE_SPEEDS = [1, 1.5, 2] as const;
export function nextVoiceSpeed(speed: number): number {
    const i = VOICE_SPEEDS.indexOf(speed as (typeof VOICE_SPEEDS)[number]);
    return VOICE_SPEEDS[(i + 1) % VOICE_SPEEDS.length];
}
export function voiceSpeedLabel(speed: number): string {
    return `${speed}×`;
}

// ─── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A voice message the chat refused and has already said why above the box: the recorder keeps the recording, back for play,
 * bin and Send, and says nothing more (the phone's VoiceNotSentError, PR #3112 review round 3).
 */
export class VoiceNotSentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VoiceNotSentError';
    }
}

export function isVoiceNotSent(e: unknown): boolean {
    return e instanceof VoiceNotSentError || (e as { name?: unknown } | null)?.name === 'VoiceNotSentError';
}

/**
 * A voice send bounded at `ms`: `send` gets an AbortSignal that aborts at `ms`, which aborts its request, and a send that
 * answers after it writes nothing (the page reads `signal.aborted`). The recording is then back for review under the same
 * line id, and Send again is the node's duplicate (it answers the line it stored), never a second voice message.
 */
export function voiceSendWithin<T>(ms: number, tooLong: string, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const giveUp = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { giveUp.abort(); reject(new Error(tooLong)); }, ms);
    });
    return Promise.race([send(giveUp.signal), late]).finally(() => clearTimeout(timer));
}

// ─── Opening ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a voice bubble can play: the opened part; 'gone' (the node no longer keeps it: 30 days, 410 voice_expired, or 404);
 * 'refused' (it didn't open, or failed core's checks: "can't be played"); 'unavailable' (the node couldn't be asked).
 */
export type VoiceOpenResult = { kind: 'ok'; voice: VoicePart } | { kind: 'gone' } | { kind: 'refused' } | { kind: 'unavailable' };

/** A node's answer for a part it no longer has: the 30-day expiry answers 410 (code voice_expired); an old row 404. */
export function isGoneAnswer(e: unknown): boolean {
    const status = (e as { status?: unknown } | null)?.status;
    return status === 404 || status === 410;
}

/** What a DM voice line is bound to: its conversation, its named sender, its id, its metadata (the reply it answers). */
export interface DmVoiceRef {
    conversationId: string;
    senderPubHex: string;
    messageId: string;
    metadata?: string | null;
}

/**
 * A DM voice line's sound, opened only as part of its message: its words must have opened first (`wordsOpened`, the thread
 * check's format 4), and the sound opens under the same keys and the same named sender as they did. Nothing is fetched for
 * a line whose words didn't open. The web keeps no former keys (no pinned key history: its thread check is given none), so
 * a voice part never opens under a key its words didn't.
 */
export async function openDmVoiceLine(
    fetchPart: () => Promise<{ data?: string; ciphertext?: string; nonce: string }>,
    keys: DmKeys | null,
    ref: DmVoiceRef,
    wordsOpened: boolean,
): Promise<VoiceOpenResult> {
    if (!keys || !wordsOpened) return { kind: 'refused' };
    let part: { data?: string; ciphertext?: string; nonce: string };
    try { part = await fetchPart(); } catch (e) { return isGoneAnswer(e) ? { kind: 'gone' } : { kind: 'unavailable' }; }
    try {
        const ciphertext = typeof part.data === 'string' ? part.data : part.ciphertext ?? '';
        const opened = openDmVoice({ ciphertext, nonce: part.nonce }, keys,
            { conversationId: ref.conversationId, senderPubHex: ref.senderPubHex, messageId: ref.messageId, metadata: ref.metadata ?? null });
        return { kind: 'ok', voice: { durationMs: opened.durationMs, bars: opened.bars, sound: opened.sound } };
    } catch {
        // A VoiceRefusedError (it didn't open as this message's voice part, or failed core's checks), or a malformed answer.
        return { kind: 'refused' };
    }
}
