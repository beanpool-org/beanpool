# iPhone permission sentences, per language

Expo's `locales` (app.json) turns each file here into that language's `InfoPlist.strings` at build time, so iOS asks for a
permission in the phone's language. Keys are Info.plist keys, nested under `"ios"`; a key missing from a language falls
back to the English in app.json `ios.infoPlist`.

Always under `"ios"`: Expo gives a file's top-level keys to Android too, as `res/values-b+<lang>/strings.xml`, and a string
that exists only in language folders (not in `res/values`) is lint's `ExtraTranslation`, fatal in an Android release
build. Under `"ios"`, Android gets empty files.

- `NSLocalNetworkUsageDescription` (lights-out H2, 4 Nov 2026): iOS asks it the first time the app reaches the hall
  laptop's number, at the member's tap on "Join the hall laptop", never at start. Machine draft (claude-opus-5-5,
  lights-out H2, 4 Nov 2026); no native speaker has checked it yet; meaning-check due.

`utils/__tests__/infoplist-words.test.ts` holds every language in core's LANGS to a file here with the sentence.
