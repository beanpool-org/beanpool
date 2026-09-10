import React from 'react';
import { View, Text, StyleSheet, Pressable, SafeAreaView, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../constants/colors';

export default function RecoverIdentityScreen() {
    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <ScrollView contentContainerStyle={styles.scroll}>
                <View style={styles.card}>
                    <Text style={styles.title} accessibilityRole="header">Restore Account</Text>
                    <Text style={styles.subtitle}>
                        Choose how you would like to restore your account on this device.
                    </Text>

                    <Pressable
                        style={styles.optionBtn}
                        onPress={() => router.replace({ pathname: '/welcome', params: { mode: 'ssoRecover' } })}
                        accessibilityRole="button"
                        // Must match the visible label so speech control can address it
                        // (WCAG 2.5.3). The description belongs in the hint, because
                        // accessibilityLabel on the parent hides the child Text.
                        accessibilityLabel="Recover with Sign-In"
                        accessibilityHint="Restore using Google, Apple, or other linked accounts"
                    >
                        <Text style={styles.optionIcon} importantForAccessibility="no" accessibilityElementsHidden={true}>🌐</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.optionTitle}>Recover with Sign-In</Text>
                            <Text style={styles.optionSub}>Restore using Google, Apple, or other linked accounts</Text>
                        </View>
                        <Text style={styles.chevron} importantForAccessibility="no" accessibilityElementsHidden={true}>›</Text>
                    </Pressable>

                    <Pressable
                        style={styles.optionBtn}
                        onPress={() => router.replace({ pathname: '/welcome', params: { mode: 'recover' } })}
                        accessibilityRole="button"
                        accessibilityLabel="Recover with 12 Words"
                        accessibilityHint="Type your 12-word recovery phrase"
                    >
                        <Text style={styles.optionIcon} importantForAccessibility="no" accessibilityElementsHidden={true}>🔑</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.optionTitle}>Recover with 12 Words</Text>
                            <Text style={styles.optionSub}>Type your 12-word recovery phrase</Text>
                        </View>
                        <Text style={styles.chevron} importantForAccessibility="no" accessibilityElementsHidden={true}>›</Text>
                    </Pressable>

                    <Pressable
                        style={styles.backBtn}
                        onPress={() => {
                            if (router.canGoBack()) router.back();
                            else router.replace('/welcome');
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Back to welcome"
                    >
                        <Text style={styles.backBtnText}>← Back to Welcome</Text>
                    </Pressable>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    card: {
        width: '100%',
        backgroundColor: colors.surface.card,
        padding: 24,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colors.border.default,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 10,
        elevation: 2,
    },
    title: { fontSize: 22, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.text.secondary, marginBottom: 24, lineHeight: 20 },
    optionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface.subtle,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 14,
        padding: 16,
        marginBottom: 14,
        gap: 12,
    },
    optionIcon: { fontSize: 24 },
    optionTitle: { fontSize: 16, fontWeight: '700', color: colors.text.heading, marginBottom: 2 },
    optionSub: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },
    chevron: { fontSize: 20, color: colors.text.muted, fontWeight: '300' },
    backBtn: { marginTop: 12, alignItems: 'center', justifyContent: 'center', padding: 12, minHeight: 44 },
    backBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
});

