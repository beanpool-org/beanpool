/**
 * A voice message in its bubble (voice messages V4, DESIGN-cross-chat-voice-fable.md §5.5), in direct and group chats. The
 * phone's twin is apps/native components/chat/VoiceBubble.tsx (#3112): the same states and words.
 *
 * Play and pause; the sender's waveform with what has played drawn solid (click along it, or the arrow keys, to move); the
 * length, or the position while it plays; 1× → 1.5× → 2×. The sound opens when the bubble is drawn (`load`): the line's
 * words first, then the node's sealed part (lib/voice.ts openDmVoiceLine, lib/group-chat-lines.ts getDecryptedGroupVoice).
 *
 * Drawn in the bubble's own ink (currentColor), so it reads on my bubble and theirs, light and dark, with no colour of its own.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { t, type VoicePart } from '@beanpool/core';
import { browserPlaysVoice, voiceClock, voiceSpeedLabel, VOICE_WORDS, type VoiceOpenResult } from '../lib/voice';
import { cycleVoiceSpeed, pauseVoice, playVoice, registerVoice, seekVoice, useVoicePlayer } from '../lib/voice-player';

type Shown = { kind: 'loading' } | { kind: 'cant-play-here' } | VoiceOpenResult;

const BAR_MAX_PX = 22;

export function VoiceBubble({ messageId, load }: { messageId: string; load: () => Promise<VoiceOpenResult> }) {
    const [shown, setShown] = useState<Shown>(() => (browserPlaysVoice() ? { kind: 'loading' } : { kind: 'cant-play-here' }));
    const [attempt, setAttempt] = useState(0);
    const loadRef = useRef(load);
    loadRef.current = load;
    const player = useVoicePlayer();

    useEffect(() => {
        if (!browserPlaysVoice()) return;
        let active = true;
        setShown({ kind: 'loading' });
        loadRef.current().then((r) => { if (active) setShown(r); }, () => { if (active) setShown({ kind: 'unavailable' }); });
        return () => { active = false; };
    }, [messageId, attempt]);

    const voice: VoicePart | null = shown.kind === 'ok' ? shown.voice : null;
    useEffect(() => {
        if (!voice) return;
        return registerVoice(messageId, async () => voice);
    }, [messageId, voice]);

    const isCurrent = player.currentId === messageId;
    const playing = isCurrent && player.playing;
    const positionMs = isCurrent ? player.positionMs : 0;

    const toggle = useCallback(() => {
        if (!voice) return;
        if (playing) pauseVoice();
        else void playVoice(messageId, voice, isCurrent && positionMs < voice.durationMs ? undefined : 0);
    }, [voice, playing, messageId, isCurrent, positionMs]);

    if (shown.kind === 'loading') return <span style={{ opacity: 0.7 }}>{t(VOICE_WORDS.loading)}</span>;
    if (shown.kind === 'unavailable') {
        return (
            <button type="button" data-testid="voice-retry" onClick={() => setAttempt((n) => n + 1)} style={{
                background: 'none', border: 'none', padding: '6px 0', minHeight: '44px', font: 'inherit', color: 'inherit',
                fontStyle: 'italic', textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer', textAlign: 'left',
            }}>
                {t(VOICE_WORDS.unavailable)}
            </button>
        );
    }
    if (!voice) {
        const words = shown.kind === 'gone' ? VOICE_WORDS.gone : shown.kind === 'cant-play-here' ? VOICE_WORDS.cantPlayHere : VOICE_WORDS.refused;
        return <span data-testid="voice-cant-play" style={{ fontStyle: 'italic', opacity: 0.85 }}><span aria-hidden="true">🎤 </span>{t(words)}</span>;
    }

    const share = voice.durationMs > 0 ? Math.min(1, positionMs / voice.durationMs) : 0;
    const seekTo = (s: number) => { void seekVoice(messageId, voice, s); };
    const round: CSSProperties = {
        width: '44px', height: '44px', minWidth: '44px', borderRadius: '50%', border: '2px solid currentColor', background: 'transparent',
        color: 'inherit', font: 'inherit', fontSize: '1rem', lineHeight: 1, cursor: player.held ? 'not-allowed' : 'pointer', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: player.held ? 0.5 : 1, flexShrink: 0,
    };
    return (
        <div data-testid="voice-bubble" style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, width: '100%', maxWidth: '260px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <button
                    type="button"
                    onClick={toggle}
                    disabled={player.held}
                    aria-label={playing ? t('Pause voice message') : t('Play voice message, {length}', { length: voiceClock(voice.durationMs) })}
                    style={round}
                >
                    <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
                </button>
                <div
                    role="slider"
                    tabIndex={0}
                    aria-label={t('Voice message position')}
                    aria-valuemin={0}
                    aria-valuemax={Math.round(voice.durationMs / 1000)}
                    aria-valuenow={Math.round(positionMs / 1000)}
                    aria-valuetext={voiceClock(positionMs)}
                    data-testid="voice-wave"
                    onClick={(e) => {
                        const box = e.currentTarget.getBoundingClientRect();
                        if (box.width > 0) seekTo((e.clientX - box.left) / box.width);
                    }}
                    onKeyDown={(e) => {
                        const step = voice.durationMs > 0 ? 5000 / voice.durationMs : 0;
                        if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(share + step); }
                        else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(share - step); }
                    }}
                    style={{ flex: 1, minWidth: 0, height: '32px', display: 'flex', alignItems: 'center', gap: '1px', cursor: 'pointer', borderRadius: '4px' }}
                >
                    {voice.bars.map((b, i) => (
                        <span key={i} aria-hidden="true" style={{
                            flex: '1 1 0', minWidth: '1px', maxWidth: '4px', borderRadius: '1px', background: 'currentColor',
                            height: `${Math.max(2, Math.round((b / 255) * BAR_MAX_PX))}px`, opacity: (i + 0.5) / voice.bars.length <= share ? 1 : 0.4,
                        }} />
                    ))}
                </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.75rem', paddingLeft: '52px' }}>
                <span data-testid="voice-clock" style={{ fontVariantNumeric: 'tabular-nums' }}>{voiceClock(isCurrent && positionMs > 0 ? positionMs : voice.durationMs)}</span>
                <button
                    type="button"
                    onClick={cycleVoiceSpeed}
                    aria-label={t('Playback speed {speed}', { speed: voiceSpeedLabel(player.speed) })}
                    style={{
                        minWidth: '44px', minHeight: '28px', padding: '2px 8px', borderRadius: '999px', border: '1px solid currentColor',
                        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer',
                    }}
                >
                    {voiceSpeedLabel(player.speed)}
                </button>
            </div>
        </div>
    );
}
