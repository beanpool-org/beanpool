// Dynamic Expo config. Expo prefers app.config.js over app.json and passes the
// static app.json config in as `config`; we spread it and inject secrets from the
// environment so they are never committed to source control.
//
// GOOGLE_MAPS_API_KEY — the Android Google Maps key. Set it in your build
// environment (an EAS secret for cloud builds, and a local .env for local builds).
// Without it, Android maps will not render. iOS uses Apple Maps and needs no key.
//
// EXPO_PUBLIC_BEANPOOL_VAULT_URL, _TICKET_KEYS and _DEPOSIT_KEYS — BeanPool's key vault for this build
// (utils/vault-config.ts; apps/native/.env.example). All three, or none. With none, members' sign-in copies stay at
// their community, as before the vault; with all three, well formed, at the vault. Some but not all is a mistake that
// would quietly give a community build to someone who meant a vault build, so the build stops here instead.
const VAULT_VARS = ['EXPO_PUBLIC_BEANPOOL_VAULT_URL', 'EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS', 'EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS'];

function checkVaultVars(env) {
  const set = VAULT_VARS.filter((name) => (env[name] || '').trim() !== '');
  if (set.length !== 0 && set.length !== VAULT_VARS.length) {
    const missing = VAULT_VARS.filter((name) => !set.includes(name));
    throw new Error(`Key vault build settings: set all three or none. Missing: ${missing.join(', ')}.`);
  }
}

module.exports = ({ config }) => {
  checkVaultVars(process.env);
  return withSecrets(config);
};

const withSecrets = (config) => ({
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
  extra: {
    ...(config.extra || {}),
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },
});
