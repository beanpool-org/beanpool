import React, { useEffect } from 'react';
import { View, ActivityIndicator, Text, DeviceEventEmitter } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { colors } from '../../constants/colors';
import { useLeaveAuthReturn } from '../../components/useLeaveAuthReturn';

/**
 * Where Facebook's page returns when it reaches the app as a link: on Android the
 * `https://beanpool.org/auth/facebook` App Link. It goes back to the screen waiting for the sign-in
 * (utils/auth-return.ts).
 */
export default function FacebookAuthCallbackScreen() {
    const url = Linking.useURL();

    useEffect(() => {
        try {
            if (url) {
                DeviceEventEmitter.emit('SSO_AUTH_CALLBACK', url);
            }
            // Web-only (@platform web), and it never accepted a `url` — that argument was being
            // silently dropped. On Android the broadcast above is what completes the sign-in.
            WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
        } catch (e) {
            console.warn('[Facebook Auth Callback] Error completing auth session:', e);
        }
    }, [url]);
    useLeaveAuthReturn(url);

    return (
        <View
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.app }}
            accessibilityRole="progressbar"
            accessibilityLabel="Completing Facebook sign-in..."
            accessibilityLiveRegion="polite"
        >
            <ActivityIndicator size="large" color={colors.brand.primary} />
            <Text style={{ marginTop: 16, color: colors.text.secondary, fontSize: 14 }}>
                Completing Facebook sign-in...
            </Text>
        </View>
    );
}
