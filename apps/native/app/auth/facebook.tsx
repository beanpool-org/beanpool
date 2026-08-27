import React, { useEffect } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { colors } from '../../constants/colors';

export default function FacebookAuthCallbackScreen() {
    const router = useRouter();

    useEffect(() => {
        try {
            WebBrowser.maybeCompleteAuthSession();
        } catch (e) {
            console.warn('[Facebook Auth Callback] Error completing auth session:', e);
        }
        const timer = setTimeout(() => {
            if (router.canGoBack()) {
                router.back();
            } else {
                router.replace('/');
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [router]);

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
