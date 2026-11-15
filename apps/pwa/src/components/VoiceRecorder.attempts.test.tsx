/**
 * One recording attempt at a time (PR #3212 review, round 2). A click on the microphone starts an attempt that waits, maybe for
 * seconds: for the microphone's answer, for the sound to start and, on the encoder's path (Firefox, Brave on Android), for the
 * encoder's chunk to load the first time. The bin, another chat, closing the chat and a new click each end every attempt before
 * it for good, so when an ended attempt's wait comes back late it lets go of its own microphone and sound and touches nothing
 * else: the attempt from the last click is the one that records.
 *
 * The review measured the case this stops, in Firefox 160: microphone, the bin and the microphone again while the encoder
 * was still loading. The first, binned attempt came back first, passed the old check (same chat, phase "asking" again because
 * of the second click), and went live on the sound the bin had closed. Firefox makes the capture on a closed sound with no
 * error and hears nothing, so the person saw the clock, spoke, and Stop said the recorder didn't load, with voice turned off
 * for the session. The stand-in encoder below does what Firefox does: a capture made on a closed sound hears nothing.
 *
 * Every row runs through the real useVoiceRecorder. A row that ends on a click ends with exactly one attempt live, recording
 * through the last microphone and sound asked for; every earlier microphone stopped and every earlier sound closed; Stop keeps
 * a recording. A row that ends on the bin ends with nothing live and nothing said: a binned attempt that fails late (Chrome
 * throws on a closed sound) is not the recorder failing.
 */
import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setVoiceEncoderLoadForTest, useVoiceRecorder, type VoiceRecorderApi } from './VoiceRecorder';
// The stand-in encoder below, imported here so a load the test holds hands it over at once when let go (a dynamic import's
// own time in vitest would decide which attempt comes back first).
import * as voiceEncode from '../lib/voice-encode';

const M4A = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76, 9, 9, 9, 9]);

/** The encoder's captures, each with the sound it was made on, whether it heard anything, and whether it was thrown away. */
const enc = vi.hoisted(() => ({
    /** Holds startVoiceCapture: the cold encoder's own wait (the worklet's file and the WebAssembly). */
    starting: null as Promise<void> | null,
    /** What the browser does with a capture made on a closed sound (both measured in the review). */
    closedSound: 'Firefox' as 'Firefox' | 'Chrome',
    captures: [] as { context: { state: string }; heard: boolean; cancelled: boolean }[],
}));
vi.mock('../lib/voice-encode', () => ({
    startVoiceCapture: async (context: { state: string }) => {
        if (enc.starting) await enc.starting;
        // Chrome: the capture's node on a closed sound throws. Firefox 160: it is made with no error and hears nothing.
        if (context.state === 'closed' && enc.closedSound === 'Chrome') throw new DOMException('The AudioContext was closed.', 'InvalidStateError');
        const c = { context, heard: context.state === 'running', cancelled: false };
        enc.captures.push(c);
        return {
            stop: async () => { if (!c.heard || c.cancelled) throw new Error('nothing heard'); return M4A; },
            cancel: () => { c.cancelled = true; },
        };
    },
}));

/** A microphone: its one track, stopped or not. */
interface FakeStream { stopped: boolean; getTracks(): { stop(): void; onended: (() => void) | null }[] }
let streams: FakeStream[] = [];
/** The microphone's answers still to come, in the order they were asked (`microphoneSlow`). */
let answers: { yes(): void; no(): void }[] = [];
let microphoneSlow = false;
const getUserMedia = vi.fn(() => {
    const track = { stop: () => { s.stopped = true; }, onended: null as (() => void) | null };
    const s: FakeStream = { stopped: false, getTracks: () => [track] };
    streams.push(s);
    if (!microphoneSlow) return Promise.resolve(s);
    return new Promise<FakeStream>((resolve, reject) => {
        answers.push({
            yes: () => resolve(s),
            // A refused microphone gives no stream: nothing of it is on to stop.
            no: () => { s.stopped = true; reject(new DOMException('Permission denied', 'NotAllowedError')); },
        });
    });
});

/** The sound: made suspended; a closed one can't be resumed, as in every browser. */
class FakeAudioContext {
    static made: FakeAudioContext[] = [];
    state: AudioContextState = 'suspended';
    sampleRate = 48000;
    resume = vi.fn(async () => {
        if (this.state === 'closed') throw new DOMException('The AudioContext was closed.', 'InvalidStateError');
        this.state = 'running';
    });
    close = vi.fn(async () => { this.state = 'closed'; });
    constructor() { FakeAudioContext.made.push(this); }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (f: Float32Array) => f.fill(0.1) }; }
    createMediaStreamSource() { return { connect: () => {} }; }
}

/** The browser's recorder (Chrome, Edge, Safari): writes .m4a. */
class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([M4A]) });
        this.onstop?.();
    }
}

let clock = 1000;
/** Lets every answer that is ready come back: three turns of the event loop, each after the promises queued before it. */
async function settle() {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

type Tap = 'mic' | 'bin' | 'leave' | 'back';
const TAPS: Record<string, Tap[]> = {
    'mic': ['mic'],
    'mic, bin': ['mic', 'bin'],
    'mic, bin, mic': ['mic', 'bin', 'mic'],
    'mic, bin, mic, bin, mic': ['mic', 'bin', 'mic', 'bin', 'mic'],
    'mic, leave the chat, come back, mic': ['mic', 'leave', 'back', 'mic'],
};
/**
 * Where each attempt waits. Cold-loading: the encoder's chunk and its start are held until every tap is done. Starting: the
 * chunk is there, its start (the worklet's file, the WebAssembly) is held. Loaded: no wait of its own, so each attempt goes
 * live before the next tap. Microphone slow: the microphone's answers are held. And on the
 * encoder's path, what the browser does with a capture made on a closed sound. The browser's recorder is Chrome's, Edge's
 * and Safari's path; Firefox never takes it.
 */
type Wait = 'encoder cold-loading' | 'encoder starting' | 'encoder loaded' | 'encoder, microphone slow' | 'browser recorder, microphone slow';
const COLUMNS: { wait: Wait; browser: 'Firefox' | 'Chrome' }[] = [
    { wait: 'encoder cold-loading', browser: 'Firefox' },
    { wait: 'encoder cold-loading', browser: 'Chrome' },
    { wait: 'encoder starting', browser: 'Firefox' },
    { wait: 'encoder starting', browser: 'Chrome' },
    { wait: 'encoder loaded', browser: 'Firefox' },
    { wait: 'encoder loaded', browser: 'Chrome' },
    { wait: 'encoder, microphone slow', browser: 'Firefox' },
    { wait: 'encoder, microphone slow', browser: 'Chrome' },
    { wait: 'browser recorder, microphone slow', browser: 'Chrome' },
];

async function run(taps: Tap[], wait: Wait, browser: 'Firefox' | 'Chrome'): Promise<{ rec: { current: VoiceRecorderApi }; unmount: () => void }> {
    enc.closedSound = browser;
    const encoderPath = wait.startsWith('encoder');
    microphoneSlow = wait.endsWith('microphone slow');
    let releaseChunk: () => void = () => {};
    let releaseStart: () => void = () => {};
    if (wait === 'encoder cold-loading') {
        const chunk = new Promise<void>((r) => { releaseChunk = r; });
        enc.starting = new Promise<void>((r) => { releaseStart = r; });
        setVoiceEncoderLoadForTest(async () => { await chunk; return voiceEncode; });
    } else {
        if (wait === 'encoder starting') enc.starting = new Promise<void>((r) => { releaseStart = r; });
        setVoiceEncoderLoadForTest(async () => voiceEncode);
    }
    const onSend = vi.fn(async () => {});
    const { result, rerender, unmount } = renderHook(({ chat }) => useVoiceRecorder(onSend, chat, encoderPath), { initialProps: { chat: 'chat-a' } });
    for (const tap of taps) {
        await act(async () => {
            if (tap === 'mic') result.current.start();
            else if (tap === 'bin') result.current.cancel();
            else if (tap === 'leave') rerender({ chat: 'chat-b' });
            else rerender({ chat: 'chat-a' });
            await settle();
        });
    }
    // Every wait comes back now, the earliest asked first: the order in which the ended attempts used to win.
    await act(async () => {
        for (const a of answers) a.yes();
        answers = [];
        releaseChunk();
        releaseStart();
        await settle();
    });
    return { rec: result, unmount };
}

describe('one recording attempt at a time: a cancel ends every earlier attempt for good', () => {
    beforeEach(() => {
        streams = [];
        answers = [];
        microphoneSlow = false;
        enc.starting = null;
        enc.closedSound = 'Firefox';
        enc.captures = [];
        FakeAudioContext.made = [];
        getUserMedia.mockClear();
        clock = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.stubGlobal('AudioContext', FakeAudioContext);
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    });

    afterEach(() => {
        cleanup();
        setVoiceEncoderLoadForTest(null);
        enc.starting = null;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    for (const [name, taps] of Object.entries(TAPS)) {
        for (const { wait, browser } of COLUMNS) {
            const endsBinned = taps[taps.length - 1] === 'bin';
            it(`${name} (${wait}, ${browser}): ${endsBinned
                ? 'nothing live and nothing said; the microphone and the sound let go'
                : 'one attempt live, through the last microphone and sound; every earlier one let go; Stop keeps it'}`, async () => {
                const { rec, unmount } = await run(taps, wait, browser);
                const mics = taps.filter((t) => t === 'mic').length;
                expect(getUserMedia).toHaveBeenCalledTimes(mics);
                expect(streams).toHaveLength(mics);

                if (endsBinned) {
                    // The binned attempt's late answer is not a failure of the recorder: no note, the microphone stays.
                    expect(rec.current.state).toEqual({ phase: 'idle', hint: null });
                    expect(rec.current.encoderFailed).toBe(false);
                    expect(streams.every((s) => s.stopped)).toBe(true);
                    expect(FakeAudioContext.made.every((c) => c.state === 'closed')).toBe(true);
                    expect(enc.captures.every((c) => c.cancelled)).toBe(true);
                    unmount();
                    return;
                }

                // Exactly one attempt live: the last click's.
                expect(rec.current.state.phase).toBe('recording');
                const lastStream = streams[streams.length - 1];
                expect(streams.filter((s) => !s.stopped)).toEqual([lastStream]);
                const lastSound = FakeAudioContext.made[FakeAudioContext.made.length - 1];
                expect(FakeAudioContext.made.filter((c) => c.state !== 'closed')).toEqual([lastSound]);
                if (wait.startsWith('encoder')) {
                    expect(FakeAudioContext.made).toHaveLength(mics); // one sound per click, made in the click
                    const live = enc.captures.filter((c) => !c.cancelled);
                    expect(live).toHaveLength(1);
                    expect(live[0].context).toBe(lastSound);
                    expect(live[0].heard).toBe(true);
                }

                // It records: Stop keeps it, to play and send, and nothing says the recorder failed.
                clock += 2300;
                await act(async () => { rec.current.stop(); await settle(); });
                expect(rec.current.state.phase).toBe('review');
                expect(rec.current.encoderFailed).toBe(false);
                // And then every microphone is off and every sound closed.
                expect(streams.every((s) => s.stopped)).toBe(true);
                expect(FakeAudioContext.made.every((c) => c.state === 'closed')).toBe(true);
                unmount();
            });
        }
    }

    for (const wait of ['encoder, microphone slow', 'browser recorder, microphone slow'] as const) {
        it(`a late "no" from the microphone for an attempt the bin ended doesn't touch the next one (${wait})`, async () => {
            microphoneSlow = true;
            setVoiceEncoderLoadForTest(async () => voiceEncode);
            const { result } = renderHook(() => useVoiceRecorder(vi.fn(async () => {}), 'chat-a', wait.startsWith('encoder')));
            await act(async () => { result.current.start(); await settle(); });
            await act(async () => { result.current.cancel(); await settle(); });
            await act(async () => { result.current.start(); await settle(); });
            const [first, second] = answers;
            await act(async () => { first.no(); await settle(); });
            // The ended attempt's "no" is not the new attempt's: it is still asking, not told the microphone was refused.
            expect(result.current.state).toEqual({ phase: 'asking' });
            await act(async () => { second.yes(); await settle(); });
            expect(result.current.state.phase).toBe('recording');
            expect(streams.filter((s) => !s.stopped)).toEqual([streams[1]]);
            expect(FakeAudioContext.made.filter((c) => c.state !== 'closed')).toEqual([FakeAudioContext.made[FakeAudioContext.made.length - 1]]);
        });
    }

    it('closing the chat while the encoder loads lets the microphone and the sound go, and the late load starts nothing', async () => {
        let releaseChunk: () => void = () => {};
        const chunk = new Promise<void>((r) => { releaseChunk = r; });
        setVoiceEncoderLoadForTest(async () => { await chunk; return voiceEncode; });
        const { result, unmount } = renderHook(() => useVoiceRecorder(vi.fn(async () => {}), 'chat-a', true));
        await act(async () => { result.current.start(); await settle(); });
        expect(streams).toHaveLength(1);
        unmount();
        expect(streams[0].stopped).toBe(true);
        await act(async () => { await settle(); });
        expect(FakeAudioContext.made[0].state).toBe('closed');
        await act(async () => { releaseChunk(); await settle(); });
        expect(enc.captures).toEqual([]);
    });
});
