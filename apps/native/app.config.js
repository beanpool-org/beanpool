// Dynamic Expo config. Expo prefers app.config.js over app.json and passes the
// static app.json config in as `config`; we spread it and inject secrets from the
// environment so they are never committed to source control.
//
// GOOGLE_MAPS_API_KEY — the Android Google Maps key. Set it in your build
// environment (an EAS secret for cloud builds, and a local .env for local builds).
// Without it, Android maps will not render. iOS uses Apple Maps and needs no key.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    config: {
      ...(config.android && config.android.config),
      googleMaps: {
        ...(config.android && config.android.config && config.android.config.googleMaps),
        apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      },
    },
  },
});
