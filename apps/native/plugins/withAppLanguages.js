// The languages this build is written in, declared to the phone and the stores (translation design, director
// amendment 1): one binary carries every language, and the build says which, so the App Store lists them and the
// phone's own per-app language setting (iOS; Android 13+) offers them.
//
//   iOS:     CFBundleLocalizations in Info.plist, CFBundleDevelopmentRegion en.
//   Android: res/xml/locales_config.xml and android:localeConfig on <application>.
//
// Right-to-left stays off until the RTL audit (design §2.5 rule 3): android:supportsRtl="false", so an Arabic, Urdu or
// Persian phone draws BeanPool left to right from its first launch (I18nManager.allowRTL(false) in app/_layout.tsx
// only takes effect from the next one).
//
// APP_LANGUAGES must equal core's LANGS (packages/beanpool-core/src/words.ts); utils/__tests__/language-choice.test.ts
// checks it. Plain CommonJS here because Expo loads config plugins with require() at build time.
const { withAndroidManifest, withDangerousMod, withInfoPlist } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const APP_LANGUAGES = ['en', 'es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru', 'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta', 'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko'];

function localesConfigXml(languages) {
  const rows = languages.map((tag) => `    <locale android:name="${tag}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n${rows}\n</locale-config>\n`;
}

/** The manifest's part: per-app languages, and right to left off. Pure, so a test can run it on a plain manifest. */
function applyAppLanguagesManifest(manifest) {
  const application = manifest.application && manifest.application[0];
  if (application) {
    application.$['android:localeConfig'] = '@xml/locales_config';
    application.$['android:supportsRtl'] = 'false';
  }
  return manifest;
}

function withAppLanguages(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.CFBundleDevelopmentRegion = 'en';
    config.modResults.CFBundleLocalizations = APP_LANGUAGES;
    return config;
  });
  config = withAndroidManifest(config, (config) => {
    applyAppLanguagesManifest(config.modResults.manifest);
    return config;
  });
  config = withDangerousMod(config, ['android', async (config) => {
    const dir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'locales_config.xml'), localesConfigXml(APP_LANGUAGES));
    return config;
  }]);
  return config;
}

module.exports = withAppLanguages;
module.exports.APP_LANGUAGES = APP_LANGUAGES;
module.exports.localesConfigXml = localesConfigXml;
module.exports.applyAppLanguagesManifest = applyAppLanguagesManifest;
