import React, { useEffect } from 'react';
import { View, ActivityIndicator, Text, DeviceEventEmitter } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { colors } from '../../constants/colors';

/**
 * Instagram OAuth Return Callback Route (The Pulse, Phase 5).
 *
 * Catches the redirect from Instagram OAuth on Web and Android App Links,
 * completes the auth session, and broadcasts SSO_AUTH_CALLBACK for listeners.
 */
export default function InstagramAuthCallbackScreen() {
    const router = useRouter();
    const url = Linking.useURL();

    useEffect(() => {
        try {
            if (url) {
                DeviceEventEmitter.emit('SSO_AUTH_CALLBACK', url);
            }
            WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
        } catch (e) {
            console.warn('[Instagram Auth Callback] Error completing auth session:', e);
        }
        const timer = setTimeout(() => {
            if (router.canGoBack()) {
                router.back();
            } else {
                router.replace('/channels');
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [router, url]);

    return (
        <View
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.app }}
            accessibilityRole="progressbar"
            accessibilityLabel="Completing Instagram Creator connection..."
            accessibilityLiveRegion="polite"
        >
            <ActivityIndicator size="large" color={colors.brand.primary} />
            <Text style={{ marginTop: 16, color: colors.text.secondary, fontSize: 14 }}>
                Completing Instagram Creator connection...
            </Text>
        </View>
    );
}
