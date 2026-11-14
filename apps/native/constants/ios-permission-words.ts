/**
 * The sentences iOS shows in its own permission pop-ups (location, camera, contacts, Face ID), marked so the translation pass
 * sees them like any other sentence of the phone app and writes each language's version into apps/native/words/<lang>.json.
 *
 * Nothing in the app calls t() on these: iOS reads them from the app's Info.plist, in the language of the phone, before any
 * app code runs. The build puts each language's version there (plugins/ios-permission-locales.js, wired by app.config.js: one
 * `<lang>.lproj/InfoPlist.strings` per language the build declares, as Expo's `locales` does), and a language with no
 * translation yet gets the English. The English the build reads is `ios.infoPlist` in app.json; this table repeats it word
 * for word so the extractor can see it, and utils/__tests__/ios-permission-locales.test.ts fails when the two differ.
 */
import { word } from '@beanpool/core';

export const IOS_PERMISSION_WORDS = {
    NSLocationWhenInUseUsageDescription: word('BeanPool uses your location while you use the app, to centre the map and show communities, listings and events near you. You can type your town instead.'),
    NSCameraUsageDescription: word('BeanPool uses your camera to scan device pairing QR codes and community invites.'),
    // Private contacts C3 (DESIGN-private-contacts-fable.md §3.4): asked only at the tap on "From this phone's contacts".
    NSContactsUsageDescription: word('BeanPool reads your contacts only when you tap Import contacts, to show you a list to choose from. What you import is locked so only you can read it.'),
    NSFaceIDUsageDescription: word("BeanPool asks for Face ID before sensitive steps, such as opening your community's admin settings or showing your recovery phrase."),
} as const;
