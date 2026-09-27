// The expo package's own sub-export, so the plugin always gets the config-plugins version the SDK ships
// (expo-doctor flags a direct @expo/config-plugins dependency).
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidLargeHeap(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;
    if (androidManifest.application && androidManifest.application[0]) {
      androidManifest.application[0].$['android:largeHeap'] = 'true';
    }
    return config;
  });
};
