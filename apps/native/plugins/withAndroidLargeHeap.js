let withAndroidManifest;
try {
  withAndroidManifest = require('@expo/config-plugins').withAndroidManifest;
} catch (err) {
  try {
    const resolved = require.resolve('@expo/config-plugins', { paths: [process.cwd(), __dirname, __dirname + '/../node_modules', __dirname + '/../../node_modules'] });
    withAndroidManifest = require(resolved).withAndroidManifest;
  } catch (err2) {
    const { withAndroidManifest: wam } = require('expo/config-plugins');
    withAndroidManifest = wam;
  }
}

module.exports = function withAndroidLargeHeap(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;
    if (androidManifest.application && androidManifest.application[0]) {
      androidManifest.application[0].$['android:largeHeap'] = 'true';
    }
    return config;
  });
};
