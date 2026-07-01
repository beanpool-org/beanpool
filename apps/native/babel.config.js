module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-worklets/plugin powers react-native-reanimated (used by
    // react-native-keyboard-controller). It MUST be the last plugin listed.
    plugins: ['react-native-worklets/plugin'],
  };
};
