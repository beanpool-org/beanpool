// The iOS permission pop-ups in each language the build declares (translation index: "Phone permission texts").
//
// iOS reads NSLocationWhenInUseUsageDescription, NSCameraUsageDescription, NSContactsUsageDescription (private contacts C3)
// and NSFaceIDUsageDescription from the app's Info.plist, in the phone's language, before any app code runs, so they cannot
// go through t(). Expo's `locales` config
// writes one <lang>.lproj/InfoPlist.strings per language (@expo/config-plugins ios/Locales.js); this builds that config.
//
//   English  `ios.infoPlist` in app.json: the source, and what every language shows until it is translated.
//   Other    apps/native/words/<lang>.json, under the English sentence as its key: the same place the translation pass
//            writes every other sentence of the phone app (constants/ios-permission-words.ts marks them so it sees them).
//   Beside   app.json's own `locales` (apps/native/infoplist-words/<lang>.json, the Local Network sentence): each language's
//            file is read and kept under these, never replaced by them (before C3 this config dropped those files, so the
//            Local Network question showed in English in every language).
//
// One entry for every language withAppLanguages.js declares (APP_LANGUAGES, core's LANGS), under `ios` so Android's strings
// are not touched. Plain CommonJS: Expo loads app.config.js with require() at build time.
const fs = require('fs');
const path = require('path');
const { APP_LANGUAGES } = require('./withAppLanguages');

const IOS_PERMISSION_KEYS = ['NSLocationWhenInUseUsageDescription', 'NSCameraUsageDescription', 'NSContactsUsageDescription', 'NSFaceIDUsageDescription'];

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

/** The `ios` part of app.json's own locale for a language: its file (a path from the app's folder) or object; {} for none. */
function ownIos(own, root) {
  let value = own;
  if (typeof own === 'string') {
    try {
      value = JSON.parse(fs.readFileSync(path.resolve(root, own), 'utf8'));
    } catch {
      return {};
    }
  }
  const ios = value && typeof value === 'object' && !Array.isArray(value) ? value.ios : null;
  if (!ios || typeof ios !== 'object' || Array.isArray(ios)) return {};
  // Written into the .strings file as the catalog's are: escaped.
  const out = {};
  for (const [key, text] of Object.entries(ios)) if (typeof text === 'string' && text !== '') out[key] = stringsValue(text);
  return out;
}

/**
 * Expo's `locales` for the permission texts: { <lang>: { ios: { <Info.plist key>: <text> } } } for every declared
 * language, the catalog's sentence where the language has one and the English where it has not, beside what app.json's own
 * locale for that language holds under `ios` (`own`: app.json's `locales`, files read from `root`).
 * `infoPlist`: app.json's `ios.infoPlist`. `wordsDir`: the phone app's catalogs.
 */
function iosPermissionLocales(infoPlist, wordsDir = path.join(__dirname, '..', 'words'), own = {}, root = path.join(__dirname, '..')) {
  const locales = {};
  for (const lang of APP_LANGUAGES) {
    const catalog = lang === 'en' ? {} : readCatalog(wordsDir, lang);
    const ios = { ...ownIos(own && own[lang], root) };
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
