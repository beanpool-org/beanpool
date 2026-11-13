/**
 * The web's voice recorder (voice messages V4, DESIGN-cross-chat-voice-fable.md §5.3, §5.5): the phone's tap mode. With the box
 * empty, Send is a microphone. A click asks the browser for the microphone (the first time only; never before) and records:
 * a red dot, the clock, the bin and Stop (and Send, which stops and sends). Stop keeps it: play, bin, Send. Under one second
 * sends nothing and says so. At 3:00 it stops by itself and waits for Send. The rules are lib/voice.ts voiceRecorderStep.
 *
 * The sound is AAC in .m4a, asked of the browser at 32 kbps (lib/voice.ts VOICE_RECORD_TYPE): the format every phone plays.
 * The waveform is drawn from what the microphone hears, 48 bars, as the phone draws it.
 *
 * Sending: one line id per recording, made at the first Send and kept with it, so every try of one recording is the same line
 * and a Send after a try that timed out but landed is the node's duplicate, never a second voice message. The page's `onSend`
 * is given 60 s (voiceSendWithin), then aborted. A send that didn't go keeps the recording, back for play, bin and Send: the
 * page has said why above the box (VoiceNotSentError), or this bar says the error's words. Nothing plays while a recording
 * is going or waits (holdVoicePlayers). Leaving the chat throws the recording away and lets the microphone go.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { newDmMessageId, t, VOICE_MAX_MS, type VoiceInput } from '@beanpool/core';
import {
    isVoiceNotSent, levelDb, voiceBarsFromLevels, voiceClock, voiceRecorderStep, voiceSendWithin,
    VOICE_BITS_PER_SECOND, VOICE_IDLE, VOICE_RECORD_TYPE, VOICE_SEND_GIVE_UP_MS, VOICE_WORDS,
    type VoiceRecorderEvent, type VoiceRecorderState,
} from '../lib/voice';
import { holdVoicePlayers } from '../lib/voice-player';

const TICK_MS = 100;

interface Live {
    stream: MediaStream;
    recorder: MediaRecorder;
    chunks: Blob[];
    startedAt: number;
    levels: number[];
    timer: ReturnType<typeof setInterval> | null;
    context: AudioContext | null;
    stopped: Promise<void>;
    /** Settles `stopped`: the recorder's stop or error, or a start that threw (a recorder that never started fires neither). */
    settle: () => void;
}

interface Kept {
    voice: VoiceInput;
    /** The recording's own line id: made at the first Send, the same on every try. */
    lineId: string | null;
}

export type VoiceSend = (voice: VoiceInput, lineId: string, signal: AbortSignal) => Promise<void>;

export interface VoiceRecorderApi {
    state: VoiceRecorderState;
    /** Recording, waiting for Send, or going: the bar shows in the box's place. */
    active: boolean;
    /** The error's words from a send that didn't go and wasn't said above the box; null otherwise. */
    error: string | null;
    previewPlaying: boolean;
    start(): void;
    stop(): void;
    cancel(): void;
    send(): void;
    togglePreview(): void;
    dismiss(): void;
}

/**
 * The recorder for the open chat. `chatId` changing (another chat opened) starts it over: the recording is thrown away,
 * the microphone let go, and an answer for the last chat's send or ask is ignored (`gen`), as a phone screen's unmount does.
 */
export function useVoiceRecorder(onSend: VoiceSend, chatId: string | null): VoiceRecorderApi {
    const [state, setState] = useState<VoiceRecorderState>(VOICE_IDLE);
    const [error, setError] = useState<string | null>(null);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const stateRef = useRef<VoiceRecorderState>(VOICE_IDLE);
    const live = useRef<Live | null>(null);
    const kept = useRef<Kept | null>(null);
    const preview = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
    const mounted = useRef(true);
    const gen = useRef(0);
    const keeping = useRef<Promise<void> | null>(null);
    const sendRef = useRef(onSend);
    sendRef.current = onSend;

    const letGoOfPreview = useCallback(() => {
        const p = preview.current;
        preview.current = null;
        if (p) { p.audio.pause(); try { URL.revokeObjectURL(p.url); } catch { /* gone */ } }
        setPreviewPlaying(false);
    }, []);

    /** Stop the microphone and collect what it wrote: the .m4a's bytes, its length, its waveform. */
    const stopLive = useCallback(async (keepIt: boolean): Promise<VoiceInput | null> => {
        const l = live.current;
        live.current = null;
        if (!l) return null;
        if (l.timer) clearInterval(l.timer);
        const durationMs = Math.min(VOICE_MAX_MS, Math.max(1, Math.round(performance.now() - l.startedAt)));
        try { if (l.recorder.state !== 'inactive') l.recorder.stop(); } catch { /* already stopped */ }
        await l.stopped;
        for (const track of l.stream.getTracks()) { try { track.stop(); } catch { /* gone */ } }
        try { await l.context?.close(); } catch { /* gone */ }
        if (!keepIt) return null;
        const sound = new Uint8Array(await new Blob(l.chunks, { type: VOICE_RECORD_TYPE }).arrayBuffer());
        return { durationMs, bars: voiceBarsFromLevels(l.levels), sound };
    }, []);

    const dispatch = useCallback((event: VoiceRecorderEvent) => {
        const step = voiceRecorderStep(stateRef.current, event);
        stateRef.current = step.state;
        setState(step.state);
        holdVoicePlayers(step.state.phase !== 'idle');
        switch (step.effect) {
            case 'ask': void ask(); break;
            case 'start': void begin(); break;
            case 'keep': void keep(); break;
            case 'send': void go(); break;
            case 'discard': void discard(); break;
        }
    // The effects below read refs only; dispatch is made once.
    }, []);

    /** Still the same chat, still on screen: what an answer that took a while checks before it acts. */
    const current = (g: number) => mounted.current && gen.current === g;

    async function ask() {
        setError(null);
        const g = gen.current;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        } catch {
            if (current(g)) dispatch({ type: 'permission', granted: false });
            return;
        }
        if (!current(g) || stateRef.current.phase !== 'asking') { for (const tr of stream.getTracks()) tr.stop(); return; }
        try {
            const recorder = new MediaRecorder(stream, { mimeType: VOICE_RECORD_TYPE, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
            const chunks: Blob[] = [];
            let settle: () => void = () => {};
            const stopped = new Promise<void>((resolve) => { settle = resolve; });
            recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = () => settle();
            recorder.onerror = () => { settle(); if (mounted.current) dispatch({ type: 'failed' }); };
            // The microphone taken away (unplugged, another app): what was heard is not sent.
            for (const tr of stream.getTracks()) tr.onended = () => { if (mounted.current && stateRef.current.phase === 'recording') dispatch({ type: 'failed' }); };
            let context: AudioContext | null = null;
            let analyser: AnalyserNode | null = null;
            try {
                context = new AudioContext();
                // Made after the microphone's answer, outside the click: Safari can start it suspended, and the waveform is flat.
                if (context.state === 'suspended') void context.resume().catch(() => {});
                analyser = context.createAnalyser();
                analyser.fftSize = 1024;
                context.createMediaStreamSource(stream).connect(analyser);
            } catch { context = null; analyser = null; }
            const l: Live = { stream, recorder, chunks, startedAt: 0, levels: [], timer: null, context, stopped, settle };
            live.current = l;
            dispatch({ type: 'permission', granted: true });
            // A start that threw has already failed and let the microphone go (begin, then discard): no clock for it.
            if (live.current !== l) return;
            const frame = analyser ? new Float32Array(analyser.fftSize) : null;
            l.startedAt = performance.now();
            l.timer = setInterval(() => {
                if (analyser && frame) { analyser.getFloatTimeDomainData(frame); l.levels.push(levelDb(frame)); }
                dispatch({ type: 'tick', ms: performance.now() - l.startedAt });
            }, TICK_MS);
        } catch {
            for (const tr of stream.getTracks()) tr.stop();
            if (mounted.current) dispatch({ type: 'failed' });
        }
    }

    function begin() {
        const l = live.current;
        if (!l) return;
        try { l.recorder.start(); } catch {
            // It never started, so no stop or error will come: settle here, or stopLive waits for ever with the microphone on.
            l.settle();
            dispatch({ type: 'failed' });
        }
    }

    /** Stop and keep what was recorded; a Send pressed while it is being collected waits for it (`keeping`). */
    function keep() {
        const g = gen.current;
        keeping.current = stopLive(true).then((voice) => {
            if (voice && current(g)) kept.current = { voice, lineId: null };
        });
    }

    async function discard() {
        letGoOfPreview();
        kept.current = null;
        await stopLive(false);
    }

    async function go() {
        const g = gen.current;
        letGoOfPreview();
        if (live.current) keep();
        await keeping.current;
        if (!current(g)) return;
        const k = kept.current;
        if (!k) { dispatch({ type: 'failed' }); return; }
        // One line id per recording, on every try (PR #3112 review, round 3).
        if (!k.lineId) k.lineId = newDmMessageId();
        const lineId = k.lineId;
        try {
            await voiceSendWithin(VOICE_SEND_GIVE_UP_MS, t(VOICE_WORDS.givenUp), (signal) => sendRef.current(k.voice, lineId, signal));
            if (!current(g)) return;
            dispatch({ type: 'sent' });
        } catch (e) {
            if (!current(g)) return;
            setError(isVoiceNotSent(e) ? null : ((e as Error | null)?.message || t(VOICE_WORDS.failedToSend)));
            dispatch({ type: 'unsent' });
        }
    }

    // Another chat opened: start over, as a new screen would.
    const firstChat = useRef(true);
    useEffect(() => {
        if (firstChat.current) { firstChat.current = false; return; }
        gen.current += 1;
        letGoOfPreview();
        kept.current = null;
        void stopLive(false);
        stateRef.current = VOICE_IDLE;
        setState(VOICE_IDLE);
        setError(null);
        holdVoicePlayers(false);
    }, [chatId, letGoOfPreview, stopLive]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            letGoOfPreview();
            void stopLive(false);
            kept.current = null;
            holdVoicePlayers(false);
        };
    }, [letGoOfPreview, stopLive]);

    const togglePreview = useCallback(() => {
        if (stateRef.current.phase !== 'review' || !kept.current) return;
        if (preview.current && !preview.current.audio.paused) { preview.current.audio.pause(); return; }
        if (!preview.current) {
            const url = URL.createObjectURL(new Blob([kept.current.voice.sound as BlobPart], { type: VOICE_RECORD_TYPE }));
            const audio = new Audio(url);
            audio.onplay = () => setPreviewPlaying(true);
            audio.onpause = () => setPreviewPlaying(false);
            audio.onended = () => setPreviewPlaying(false);
            preview.current = { audio, url };
        }
        void preview.current.audio.play().catch(() => setPreviewPlaying(false));
    }, []);

    const phase = state.phase;
    return {
        state, error, previewPlaying,
        active: phase === 'recording' || phase === 'review' || phase === 'sending' || phase === 'asking',
        start: () => { setError(null); dispatch({ type: 'start' }); },
        stop: () => { const l = live.current; if (l) dispatch({ type: 'tick', ms: performance.now() - l.startedAt }); dispatch({ type: 'stop' }); },
        cancel: () => { setError(null); dispatch({ type: 'cancel' }); },
        send: () => { const l = live.current; if (l) dispatch({ type: 'tick', ms: performance.now() - l.startedAt }); setError(null); dispatch({ type: 'send' }); },
        togglePreview,
        dismiss: () => dispatch({ type: 'dismiss' }),
    };
}

const circle = (fill: string, ink: string, enabled = true): CSSProperties => ({
    width: '40px', height: '40px', minWidth: '40px', borderRadius: '50%', border: 'none', background: fill, color: ink,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', fontFamily: 'inherit', padding: 0,
    cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.6, flexShrink: 0,
});

/** The microphone in Send's place, with the box empty. */
export function VoiceMicButton({ rec, disabled }: { rec: VoiceRecorderApi; disabled?: boolean }) {
    return (
        <button type="button" data-testid="voice-mic" onClick={rec.start} disabled={disabled}
            aria-label={t('Record a voice message')} title={t('Record a voice message')} style={circle('var(--bg-hover)', 'var(--text-primary)', !disabled)}>
            <span aria-hidden="true">🎤</span>
        </button>
    );
}

/** The bar in the box's place while a recording is going, waits for Send, or is being sent. */
export function VoiceRecorderBar({ rec }: { rec: VoiceRecorderApi }) {
    const s = rec.state;
    const ms = s.phase === 'recording' || s.phase === 'review' || s.phase === 'sending' ? s.ms : 0;
    const sending = s.phase === 'sending';
    return (
        <div data-testid="voice-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
            <button type="button" data-testid="voice-bin" onClick={rec.cancel} disabled={sending} aria-label={t('Delete recording')} title={t('Delete recording')}
                style={circle('transparent', 'var(--text-secondary)', !sending)}>
                <span aria-hidden="true">🗑️</span>
            </button>
            <span role="timer" data-testid="voice-rec-clock" aria-label={t('Recording, {length}', { length: voiceClock(ms) })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', flex: '1 1 auto', minWidth: 0 }}>
                <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '50%', background: s.phase === 'recording' ? 'var(--danger)' : 'var(--text-muted)', flexShrink: 0 }} />
                {s.phase === 'asking' ? '…' : voiceClock(ms)}
            </span>
            {s.phase === 'recording' && (
                <button type="button" data-testid="voice-stop" onClick={rec.stop} aria-label={t('Stop recording')} title={t('Stop recording')}
                    style={circle('var(--bg-hover)', 'var(--text-primary)')}>
                    <span aria-hidden="true">■</span>
                </button>
            )}
            {(s.phase === 'review' || sending) && (
                <button type="button" data-testid="voice-preview" onClick={rec.togglePreview} disabled={sending}
                    aria-label={rec.previewPlaying ? t('Pause recording') : t('Play recording')} title={rec.previewPlaying ? t('Pause recording') : t('Play recording')}
                    style={circle('var(--bg-hover)', 'var(--text-primary)', !sending)}>
                    <span aria-hidden="true">{rec.previewPlaying ? '❚❚' : '▶'}</span>
                </button>
            )}
            <button type="button" data-testid="voice-send" onClick={rec.send} disabled={sending || s.phase === 'asking'}
                aria-label={sending ? t('Sending…') : t('Send voice message')} title={t('Send voice message')}
                style={circle('var(--bp-sage-fill)', '#fff', !sending && s.phase !== 'asking')}>
                <span aria-hidden="true">{sending ? '…' : '↑'}</span>
            </button>
        </div>
    );
}

/** The recorder's line above the box: why nothing was sent, or why a send didn't go. */
export function VoiceRecorderNote({ rec }: { rec: VoiceRecorderApi }) {
    const hint = rec.state.phase === 'idle' ? rec.state.hint : null;
    const hintWords = hint === 'short' ? t(VOICE_WORDS.short) : hint === 'denied' ? t(VOICE_WORDS.denied) : hint === 'failed' ? t(VOICE_WORDS.failed) : null;
    const words = rec.error ?? hintWords;
    if (!words) return null;
    return (
        <div role="status" data-testid="voice-note" style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', padding: '0.5rem 1rem',
            background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-primary)', fontSize: '0.85rem', color: 'var(--text-secondary)',
        }}>
            <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{words}</span>
            {hint && !rec.error && (
                <button type="button" onClick={rec.dismiss} aria-label={t('Dismiss')} style={{
                    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px',
                    minWidth: '28px', minHeight: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>✕</button>
            )}
        </div>
    );
}
