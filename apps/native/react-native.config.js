// Autolinking overrides for the native build.
//
// @thoughtbot/react-native-social-auth is linked on Android ONLY. Android's Google sign-in goes through it
// (Credential Manager, which carries the node's nonce); the iPhone uses Google's web sign-in page instead,
// because the library's iOS side does not pass the nonce yet (utils/sso-signin.ts, `signInWithGoogle`).
//
// Linking it on iOS would also break `pod install`: its podspec wants GoogleSignIn ~> 8.0 and
// @react-native-google-signin/google-signin (kept installed until the later cleanup) wants ~> 9.0, and
// CocoaPods cannot satisfy both. The JS never loads it on iOS, so there is nothing to link.
module.exports = {
    dependencies: {
        '@thoughtbot/react-native-social-auth': {
            platforms: { ios: null },
        },
    },
};
