/**
 * The phone's one audio session (utils/voice-audio.ts; PR #3112 review): the recorder takes it and every chat player is paused;
 * while the recorder holds it, a player is refused and the mode is left alone (on iOS a playback mode stops a running
 * recording); once the recorder lets go, players play again. expo-audio is the stand-in (utils/__tests__/expo-audio-stub.ts).
 *
 * Round 2: a hold has an owner, the chat screen. A recording waiting for review in one chat holds only that chat's player (a
 * chat opened on top of it plays), and only its owner lets go of it (the top chat's send or bin leaves it held). A live
 * microphone still holds every player on the phone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expoAudioStub } from './expo-audio-stub';
import { audioForPlaying, holdAudioForRecording, holdAudioForReview, newVoiceAudioOwner, onAudioHeld, releaseAudio, voiceAudioHold } from '../voice-audio';

const A = 'chat-a';
const B = 'chat-b';

beforeEach(async () => {
    await releaseAudio(A);
    await releaseAudio(B);
    expoAudioStub.reset();
});
afterEach(async () => {
    await releaseAudio(A);
    await releaseAudio(B);
});

describe('one owner of the audio mode', () => {
    it('a recording pauses every chat player, and a player asks nothing of the mode until the recorder lets go', async () => {
        let paused = 0;
        const off = onAudioHeld(A, () => { paused += 1; });
        expect(await audioForPlaying(A)).toBe(true);
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: false, playsInSilentMode: true });

        await holdAudioForRecording(A);
        expect(paused).toBe(1);
        expect(voiceAudioHold(A)).toBe('recording');
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: true });
        const asked = expoAudioStub.modes.length;
        expect(await audioForPlaying(A)).toBe(false);
        expect(expoAudioStub.modes.length).toBe(asked);   // the mode left alone

        // Stopped, waiting for play, bin or send: the playback mode (for the preview), the chat's player still refused.
        await holdAudioForReview(A);
        expect(voiceAudioHold(A)).toBe('review');
        expect(expoAudioStub.modes.at(-1)?.mode).toMatchObject({ allowsRecording: false });
        expect(await audioForPlaying(A)).toBe(false);

        await releaseAudio(A);
        expect(voiceAudioHold(A)).toBeNull();
        expect(await audioForPlaying(A)).toBe(true);
        off();
        await holdAudioForRecording(A);
        expect(paused).toBe(2);   // review paused it once more; gone after off()
    });

    it('a hold that begins while a player is setting the mode still wins', async () => {
        const asking = audioForPlaying(A);
        await holdAudioForRecording(A);
        expect(await asking).toBe(false);
    });

    it('every screen is its own owner', () => {
        expect(newVoiceAudioOwner('dm1')).not.toBe(newVoiceAudioOwner('dm1'));
    });
});

describe('a hold reaches its own chat only (PR #3112 review, round 2: voice-audio.ts:65)', () => {
    it('a recording waiting for review in the chat underneath: the chat on top plays, and is never paused by it', async () => {
        let pausedA = 0;
        let pausedB = 0;
        const offA = onAudioHeld(A, () => { pausedA += 1; });
        const offB = onAudioHeld(B, () => { pausedB += 1; });
        // A's member records, stops for review (or a send failed and came back), then opens B on top (header → profile → Message).
        await holdAudioForRecording(A);
        await holdAudioForReview(A);
        expect([pausedA, pausedB]).toEqual([2, 1]);   // the live microphone paused both; the review only A
        expect(voiceAudioHold(B)).toBeNull();
        expect(await audioForPlaying(B)).toBe(true);
        expect(await audioForPlaying(A)).toBe(false);
        // A send in A that failed while B is open comes back to review: B's sound isn't stopped.
        await holdAudioForReview(A);
        expect(pausedB).toBe(1);
        offA();
        offB();
    });

    it('the chat on top sends or bins its own recording: the chat underneath stays held', async () => {
        await holdAudioForRecording(A);
        await holdAudioForReview(A);
        // B records and sends (or bins) on top.
        await holdAudioForRecording(B);
        expect(await audioForPlaying(A)).toBe(false);
        await holdAudioForReview(B);
        await releaseAudio(B);
        expect(voiceAudioHold(A)).toBe('review');
        expect(await audioForPlaying(A)).toBe(false);
        expect(await audioForPlaying(B)).toBe(true);
        // A lets go of its own: A plays again.
        await releaseAudio(A);
        expect(await audioForPlaying(A)).toBe(true);
    });

    it('a live microphone in any chat holds every player, and no other chat\'s review or release sets the playback mode under it', async () => {
        await holdAudioForReview(A);
        await holdAudioForRecording(B);
        expect(await audioForPlaying(A)).toBe(false);
        expect(await audioForPlaying(B)).toBe(false);
        expect(await audioForPlaying('chat-c')).toBe(false);
        const asked = expoAudioStub.modes.length;
        // A's review again (a send came back) and A's release, while B records: the mode left alone (it would cut B on iOS).
        await holdAudioForReview(A);
        await releaseAudio(A);
        expect(expoAudioStub.modes.length).toBe(asked);
        expect(voiceAudioHold('chat-c')).toBe('recording');
        // A release by an owner that holds nothing changes nothing.
        await releaseAudio('chat-c');
        expect(expoAudioStub.modes.length).toBe(asked);
        expect(voiceAudioHold(B)).toBe('recording');
    });
});
