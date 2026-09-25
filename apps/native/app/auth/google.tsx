import React, { useEffect } from 'react';
import { View, ActivityIndicator, Text, DeviceEventEmitter } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { colors } from '../../constants/colors';

/**
 * Where Google's return lands if Expo Router ever navigates to it. On a phone it does not:
 * `+native-intent.ts` passes `beanpool://auth/google` and the `https://beanpool.org/auth/google`
 * App Link to the waiting sign-in (utils/sso-signin.ts, `signInWithGoogleWebPage`) and stays on
 * the screen waiting for it (utils/auth-return.ts). This screen is for the web preview and any
 * form of the link that check misses, so the member never sees Expo Router's Unmatched Route.
 */
export default function GoogleAuthCallbackScreen() {
    const router = useRouter();
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
        const timer = setTimeout(() => {
            if (router.canGoBack()) {
                router.back();
            } else {
                router.replace('/');
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [router, url]);

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
