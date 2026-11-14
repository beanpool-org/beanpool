# Spike: recording voice messages in Firefox (AAC in .m4a)

14 Nov 2026, Opus 5.5. Investigation only: no app code changed. Question (Marty: "really? no firefox?"): can the web app
record the one voice format every phone plays (AAC-LC in .m4a, mono, 24 kHz, 32 kbps; DESIGN-cross-chat-voice §5.2)
in Firefox, where `MediaRecorder` can't write it? The lines are sealed end to end, so the server can never convert.

**Answer: yes, with a lazily loaded WASM encoder. Firefox's own encoder can't do it.** Measured below.

## 1. Candidates

| Candidate | Licence (AGPL-3.0-only app) | Download | 3-min encode | Output |
|---|---|---|---|---|
| Firefox WebCodecs `AudioEncoder`, `mp4a.40.2` | none needed | 0 | **not supported** | n/a |
| **`@mediabunny/aac-encoder` 1.66.0** (FFmpeg's own AAC-LC encoder in WASM, in a worker) + **`mediabunny` 1.66.0** (MP4 muxer) | encoder: FFmpeg **LGPL-2.1+**, wrapper **MPL-2.0**; muxer **MPL-2.0**. No "Incompatible With Secondary Licenses" notice in either, so both combine with AGPL-3.0 | **331 KB gzip** (267 KB brotli) for both; the muxer alone is 45 KB gzip, so the encoder is ~285 KB | **1.47 s** for 180 s (≈120× real time) on an M4 Pro; first 100 ms chunk accepted 54 ms after start (worker and WASM loaded) | AAC-LC, `mp4a`, 24000 Hz, 1 ch, 32.0 kbps, `.m4a` (`ftyp isom`), moov before mdat |
| `@ffmpeg/core` 0.12.10 (ffmpeg.wasm) | GPL-2.0-or-later (usable under AGPL via GPLv3) | 64.7 MB unpacked on npm (not gzipped; far too big for a chat) | not measured | would match |
| libav.js with an AAC variant | LGPL-2.1 | not measured: its README says the published npm variants leave out MPEG codecs, so it needs our own Emscripten build | not measured | would match |
| `@audio/encode-aac`, fdk-aac builds | **fdk-aac: not AGPL-compatible**, excluded | — | — | — |

Firefox measured: **Firefox 160.0, macOS, headless** (`probe.html`, raw output `firefox-voice-aac/probe-firefox160-macos.json`):
`AudioEncoder` exists; `isConfigSupported` is false for every AAC config tried (`mp4a.40.2` at 24/44.1/48 kHz, mono and
stereo, CBR, `aac.format` aac and adts, `mp4a.40.5`, `mp4a.67`), and a real `configure` + `encode` of one second fails
with `NotSupportedError`. It encodes Opus and Vorbis only. `MediaRecorder.isTypeSupported('audio/mp4…')` is false.
Firefox on Windows and Linux was not measured (it may differ by platform encoder; nothing I found says it does).

Sizes: minified ESM bundles made with esbuild from the published packages, importing only `Output`, `Mp4OutputFormat`,
`BufferTarget`, `AudioSampleSource`, `AudioSample`, `canEncodeAudio` and `registerAacEncoder`; `gzip -9`, `brotli -q 11`.

Speed: measured on an Apple M4 Pro only; I had no slow laptop. The encoder is single-threaded WASM. **Estimate, not
measured:** an old dual-core laptop at 5–10× slower single-thread would take ~7–15 s for 3 minutes if everything were
encoded after Stop. The slice below encodes while recording (100 ms chunks), so the wait at Stop is the last chunk and
the finalize: 7 ms here.

## 2. The proof (`firefox-voice-aac/`, throwaway)

`run.mjs` serves the folder on localhost (a secure context) and opens a page in the installed **Firefox 160 headless**
with a fresh throwaway profile, `media.volume_scale` 0 and a fake microphone. Nothing is played: the signal is made in
memory. `encode.html` makes 3 minutes of a voice-like signal at 24 kHz and feeds it to Mediabunny + the AAC encoder in
100 ms chunks, as a recorder would (raw output `firefox-voice-aac/encode-firefox160-macos.json`).
Playwright's own Firefox (1543, Firefox 155) would not start on this Mac ("Could not find profile folder"), so the
proof used the stock Firefox instead.

Result, 739,467 bytes:

- **ffprobe:** `codec_name=aac profile=LC codec_tag_string=mp4a sample_rate=24000 channels=1 bit_rate=32010
  duration=180.010667`; boxes `ftyp:24 moov:18979 mdat:720464`, brands `isom`, `isommp41`.
- **ffmpeg full decode** (`-xerror -f null`): no errors.
- **Apple AudioToolbox** (`afinfo`, `afconvert` to WAV on macOS, the decoder family iOS uses): `1 ch, 24000 Hz, aac`,
  4220 packets, 180.01 s, "optimized" (moov first); decoded to 180.01 s of 16-bit PCM.
- **Core's checks:** it starts with an `ftyp` box of 24 bytes (`looksLikeM4a`), and 739,467 bytes is under
  `VOICE_SOUND_MAX_BYTES` (862,364) with 123 KB to spare. About 246 KB a minute, as §5.2 expects (240).

Not verified: a real iPhone and a real Android 8 phone playing it (the Apple decoder on macOS and ffmpeg stand in);
Firefox on Windows and Linux; a real microphone. **The capture path is not proven:** the check that a 24 kHz
`AudioContext` takes Firefox's fake microphone through an `AudioWorklet` timed out in headless, so whether Firefox
captures at 24 kHz or the slice must resample from 48 kHz is open. The AAC-LC patent position of shipping our own
encoder is a question for Marty, not measured here (Mediabunny publishes this encoder openly; browsers and phone systems
ship their own AAC encoders).

## 3. Recommendation: build it

About 330 KB gzip, loaded only when someone taps the microphone in a browser that can't write AAC itself (Chrome,
Edge, Safari and the phone download nothing new), produces the same file the phone makes, passes core's checks, and
Apple's decoder plays it. The licences fit AGPL-3.0-only. Slice sketch:

1. **Capture (first, it is the open risk):** `getUserMedia` → `AudioContext` → `AudioWorklet` handing 100 ms of Float32
   to the page. Try a 24 kHz context; if Firefox refuses or misbehaves, run at the device rate and resample to 24 kHz
   in the worklet. The worklet's frames also feed `levelDb` for the waveform, as now. Measure in a real Firefox with a
   real microphone (Marty, one step) before going further.
2. **Encode:** a new `apps/pwa/src/lib/voice-encode-wasm.ts`, reached only by dynamic `import()` from `VoiceRecorder`
   when `MediaRecorder` can't write `VOICE_RECORD_TYPE` but `AudioWorklet` and WebAssembly exist. It calls
   `registerAacEncoder()` only when `canEncodeAudio('aac')` is false, adds each chunk to an `AudioSampleSource('aac',
   32000)` at 24 kHz, and Stop finalizes an `Mp4OutputFormat({ fastStart: 'in-memory' })` into the same `Uint8Array`
   sound the MediaRecorder path gives today. The line format, `voicePartBytes`, sealing and sending are unchanged.
3. **Where the mic shows:** `browserRecordsVoice` gains a third yes (e.g. `'yes-wasm'`); `cantRecordBrowser` stays for
   browsers with neither; its words drop "Chrome, Edge, Safari" once Firefox records (24 languages, through the words
   tool). The http line is unchanged.
4. **Packaging:** `mediabunny` and `@mediabunny/aac-encoder` pinned in `apps/pwa`, in their own Vite chunk. No
   precaching service worker was found in `apps/pwa` (no workbox or VitePWA config), so the chunk is fetched only on
   import; check that again at build time. Add both licences (MPL-2.0; FFmpeg LGPL-2.1+ with a pointer to its source)
   to the third-party notices.
5. **Tests:** vitest for the pure parts (which recorder a browser gets, the resampler, chunk timestamps); one Playwright
   Firefox test with a fake microphone that records 2 s and checks the bytes pass `voicePartBytes` and parse as
   `ftyp`/`moov`/`mp4a` at 24 kHz mono (this needs Playwright's Firefox to start, which it did not on this Mac); the
   existing phone and web playback tests unchanged. Then Marty plays one Firefox-made line on his iPhone and on an
   Android 8 phone before release.

Phone side (ramifications): none. The phone receives the same `.m4a` it makes itself.
