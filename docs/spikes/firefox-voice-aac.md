# Spike: AAC voice messages from Firefox (in progress)

Measured so far (14 Nov 2026): Firefox 160.0 on macOS (Apple M4 Pro) has WebCodecs `AudioEncoder`, but every AAC
config is refused by `isConfigSupported` and a real `configure` + `encode` fails with NotSupportedError; it encodes Opus
and Vorbis only. MediaRecorder: `audio/mp4` false, Opus in WebM/Ogg true. Raw output:
`firefox-voice-aac/probe-firefox160-macos.json`. Report follows.
