// Google Play lists the app for devices without a portrait screen too (Play console, 1.4.6 340 and 1.4.7 341: "1 issue
// found"). The app itself turns with the screen (app.json "orientation": "default"), but ML Kit's barcode scanner, which
// expo-camera brings, declares its activity portrait (GmsBarcodeScanningDelegateActivity, android:screenOrientation
// portrait in the merged manifest). From that Play implies android.hardware.screen.portrait as REQUIRED and hides the app
// from devices that have no portrait (some Chromebooks and desktops, Android XR, landscape-only tablets). Declared here,
// not required, the implied requirement goes; nothing about how any screen turns changes.
// Check a build: `aapt2 dump badging <apk>` shows `uses-feature-not-required: name='android.hardware.screen.portrait'`
// and no `uses-implied-feature: name='android.hardware.screen.portrait'`; for an .aab,
// `bundletool dump manifest --bundle <aab> | grep screen.portrait` shows android:required="false".
const { withAndroidManifest } = require('expo/config-plugins');

const PORTRAIT = 'android.hardware.screen.portrait';

/** The manifest with <uses-feature android:name="android.hardware.screen.portrait" android:required="false"/>, once. */
function portraitNotRequired(manifest) {
  const features = manifest['uses-feature'] || (manifest['uses-feature'] = []);
  const declared = features.find((f) => f && f.$ && f.$['android:name'] === PORTRAIT);
  if (declared) declared.$['android:required'] = 'false';
  else features.push({ $: { 'android:name': PORTRAIT, 'android:required': 'false' } });
  return manifest;
}

module.exports = function withPortraitNotRequired(config) {
  return withAndroidManifest(config, (config) => {
    portraitNotRequired(config.modResults.manifest);
    return config;
  });
};
module.exports.portraitNotRequired = portraitNotRequired;
