// The iOS permission pop-ups in each language the build declares (translation index: "Phone permission texts").
//
// iOS reads NSLocationWhenInUseUsageDescription, NSCameraUsageDescription and NSFaceIDUsageDescription from the app's
// Info.plist, in the phone's language, before any app code runs, so they cannot go through t(). Expo's `locales` config
// writes one <lang>.lproj/InfoPlist.strings per language (@expo/config-plugins ios/Locales.js); this builds that config.
//
//   English  `ios.infoPlist` in app.json: the source, and what every language shows until it is translated.
//   Other    apps/native/words/<lang>.json, under the English sentence as its key: the same place the translation pass
//            writes every other sentence of the phone app (constants/ios-permission-words.ts marks the three so it sees them).
//
// One entry for every language withAppLanguages.js declares (APP_LANGUAGES, core's LANGS), under `ios` so Android's strings
// are not touched. Plain CommonJS: Expo loads app.config.js with require() at build time.
const fs = require('fs');
const path = require('path');
const { APP_LANGUAGES } = require('./withAppLanguages');

const IOS_PERMISSION_KEYS = ['NSLocationWhenInUseUsageDescription', 'NSCameraUsageDescription', 'NSFaceIDUsageDescription'];

/**
 * A value as a .strings file reads it. Expo writes `key = "<value>";` as it is given, so a backslash, a double quote or a
 * line break inside a translation would end the string early or break the file: each is escaped here.
 */
function stringsValue(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/** One language's catalog as a plain object, or {} when it is missing or unreadable (the English shows, never a failed build). */
function readCatalog(wordsDir, lang) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(wordsDir, `${lang}.json`), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Expo's `locales` for the three permission texts: { <lang>: { ios: { <Info.plist key>: <text> } } } for every declared
 * language, the catalog's sentence where the language has one and the English where it has not.
 * `infoPlist`: app.json's `ios.infoPlist`. `wordsDir`: the phone app's catalogs.
 */
function iosPermissionLocales(infoPlist, wordsDir = path.join(__dirname, '..', 'words')) {
  const locales = {};
  for (const lang of APP_LANGUAGES) {
    const catalog = lang === 'en' ? {} : readCatalog(wordsDir, lang);
    const ios = {};
    for (const key of IOS_PERMISSION_KEYS) {
      const english = infoPlist && infoPlist[key];
      if (typeof english !== 'string' || english === '') continue;
      const said = catalog[english];
      ios[key] = stringsValue(typeof said === 'string' && said.trim() !== '' ? said : english);
    }
    locales[lang] = { ios };
  }
  return locales;
}

module.exports = { iosPermissionLocales, stringsValue, IOS_PERMISSION_KEYS };
