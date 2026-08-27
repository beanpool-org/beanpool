import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';

export default function FacebookAuthCallbackScreen() {
    const router = useRouter();

    useEffect(() => {
        try {
            WebBrowser.maybeCompleteAuthSession();
        } catch (e) {
            console.warn('[Facebook Auth Callback] Error completing auth session:', e);
        }
        const timer = setTimeout(() => {
            router.replace('/');
        }, 300);
        return () => clearTimeout(timer);
    }, [router]);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' }}>
            <ActivityIndicator size="large" color="#10b981" />
        </View>
    );
}
