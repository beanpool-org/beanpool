import React, { useEffect } from 'react';
import { View, ActivityIndicator, Text, DeviceEventEmitter } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { colors } from '../../constants/colors';
import { useLeaveAuthReturn } from '../../components/useLeaveAuthReturn';

/**
 * Where Google's web page returns when it reaches the app as a link rather than inside an auth
 * session (utils/sso-signin.ts, `signInWithGoogleWebPage`): `beanpool://auth/google` from the
 * bounce page, or on Android the `https://beanpool.org/auth/google` App Link. Without a screen here
 * the member is left on Expo Router's Unmatched Route after signing in. It goes back to the screen
 * waiting for the sign-in (utils/auth-return.ts).
 */
export default function GoogleAuthCallbackScreen() {
    const url = Linking.useURL();

    useEffect(() => {
        try {
            if (url) {
                DeviceEventEmitter.emit('SSO_AUTH_CALLBACK', url);
            }
            // Web-only (@platform web); the broadcast above is what completes the sign-in natively.
            WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
        } catch (e) {
            console.warn('[Google Auth Callback] Error completing auth session:', e);
        }
    }, [url]);
    useLeaveAuthReturn(url);

    return (
        <View
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.app }}
            accessibilityRole="progressbar"
            accessibilityLabel="Completing Google sign-in..."
            accessibilityLiveRegion="polite"
        >
            <ActivityIndicator size="large" color={colors.brand.primary} />
            <Text style={{ marginTop: 16, color: colors.text.secondary, fontSize: 14 }}>
                Completing Google sign-in...
            </Text>
        </View>
    );
}
