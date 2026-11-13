/**
 * The phone's one audio session (utils/voice-audio.ts; PR #3112 review): the recorder takes it and every chat player is paused;
 * while the recorder holds it, a player is refused and the mode is left alone (on iOS a playback mode stops a running
 * recording); once the recorder lets go, players play again. expo-audio is the stand-in (utils/__tests__/expo-audio-stub.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { expoAudioStub } from './expo-audio-stub';
import { audioForPlaying, holdAudioForRecording, holdAudioForReview, onAudioHeld, releaseAudio, voiceAudioHold } from '../voice-audio';

beforeEach(async () => {
    await releaseAudio();
    expoAudioStub.reset();
});

describe('one owner of the audio mode', () => {
    it('a recording pauses every chat player, and a player asks nothing of the mode until the recorder lets go', async () => {
        let paused = 0;
        const off = onAudioHeld(() => { paused += 1; });
        expect(await audioForPlaying()).toBe(true);
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: false, playsInSilentMode: true });

        await holdAudioForRecording();
        expect(paused).toBe(1);
        expect(voiceAudioHold()).toBe('recording');
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: true });
        const asked = expoAudioStub.modes.length;
        expect(await audioForPlaying()).toBe(false);
        expect(expoAudioStub.modes.length).toBe(asked);   // the mode left alone

        // Stopped, waiting for play, bin or send: the playback mode (for the preview), the chat's player still refused.
        await holdAudioForReview();
        expect(voiceAudioHold()).toBe('review');
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: false });
        expect(await audioForPlaying()).toBe(false);

        await releaseAudio();
        expect(voiceAudioHold()).toBeNull();
        expect(await audioForPlaying()).toBe(true);
        off();
        await holdAudioForRecording();
        expect(paused).toBe(2);   // review paused it once more; gone after off()
    });

    it('a hold that begins while a player is setting the mode still wins', async () => {
        const asking = audioForPlaying();
        await holdAudioForRecording();
        expect(await asking).toBe(false);
    });
});
