import React from 'react';
import { StyleSheet, Text, View, Platform, TouchableOpacity } from 'react-native';
import { TWO_LAYER_THRESHOLD } from '@beanpool/core';
import { colors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';
import { GoogleButton, AppleButton, FacebookButton, GitHubButton } from './SsoButton';
import type { SsoProvider } from '../utils/sso-signin';

const PROVIDER_NAMES: Record<SsoProvider, string> = {
    apple: 'Apple',
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
};

export function KeeperProtectionPanel({ 
    protection,
    onProtectSso,
    onDisconnectSso,
    onProtectFriends,
}: { 
    protection: Protection;
    onProtectSso?: (provider: SsoProvider) => void;
    onDisconnectSso?: (provider: SsoProvider) => void;
    onProtectFriends?: () => void;
}): React.JSX.Element {
    const enrolledSso = protection.enrolledSso ?? [];
    const allProviders: SsoProvider[] = Platform.OS === 'ios'
        ? ['apple', 'google', 'facebook', 'github']
        : ['google', 'facebook', 'github'];

    const renderSsoProviders = () => {
        if (Platform.OS === 'web' || !onProtectSso) return null;

        return (
            <View style={styles.ssoGroup}>
                <Text style={styles.ssoGroupTitle}>Sign-In Recovery Providers (1-of-N)</Text>
                <Text style={styles.ssoGroupSubtitle}>
                    Connect multiple accounts for redundant backup. Any single connected account can restore your 12 words.
                </Text>

                {allProviders.map((prov) => {
                    const isConnected = enrolledSso.includes(prov);
                    if (isConnected) {
                        return (
                            <View key={prov} style={styles.providerConnectedRow}>
                                <View style={styles.providerInfo}>
                                    <Text style={styles.tick}>✅</Text>
                                    <Text style={styles.providerName}>{PROVIDER_NAMES[prov]} Connected</Text>
                                </View>
                                {onDisconnectSso && (
                                    <TouchableOpacity
                                        style={styles.disconnectBtn}
                                        onPress={() => onDisconnectSso(prov)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Disconnect ${PROVIDER_NAMES[prov]}`}
                                    >
                                        <Text style={styles.disconnectText}>Disconnect</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                        );
                    }

                    if (prov === 'apple') {
                        return (
                            <AppleButton
                                key="apple"
                                title="Protect with Apple"
                                onPress={() => onProtectSso('apple')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    if (prov === 'google') {
                        return (
                            <GoogleButton
                                key="google"
                                title="Protect with Google"
                                onPress={() => onProtectSso('google')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    if (prov === 'facebook') {
                        return (
                            <FacebookButton
                                key="facebook"
                                title="Protect with Facebook"
                                onPress={() => onProtectSso('facebook')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    return (
                        <GitHubButton
                            key="github"
                            title="Protect with GitHub"
                            onPress={() => onProtectSso('github')}
                            style={{ marginTop: 8 }}
                        />
                    );
                })}
                <Text style={styles.actionNote}>This is not a login — your account stays your own key.</Text>
            </View>
        );
    };

    if (protection.state === 'covered') {
        if (protection.tier === 'sso') {
            return (
                <View style={[styles.panel, styles.covered]}>
                    <Text style={styles.heading} accessibilityRole="header">🛡️ You're covered</Text>
                    {protection.holding.map((label, i) => (
                        <View key={`${label}-${i}`} style={styles.row} accessible accessibilityLabel={`${label}: holding a piece`}>
                            <Text style={styles.tick}>✅</Text>
                            <Text style={styles.rowLabel}>{label}</Text>
                        </View>
                    ))}
                    <Text style={styles.footnote}>
                        {enrolledSso.length > 1
                            ? `Protected by ${enrolledSso.length} sign-in accounts + your community hub. Any single account can recover your seed.`
                            : 'Neither of them can open your account alone — it takes both.'}
                    </Text>

                    {renderSsoProviders()}

                    {onProtectFriends && (
                        <TouchableOpacity
                            onPress={onProtectFriends}
                            accessibilityRole="button"
                            accessibilityLabel="Add a trusted friend for extra protection"
                            style={{ marginTop: 14 }}
                        >
                            <Text style={styles.offer}>
                                Want extra protection? Add a trusted friend — then you can recover without sign-in accounts too.
                            </Text>
                        </TouchableOpacity>
                    )}
                </View>
            );
        }

        if (protection.tier === 'friends') {
            return (
                <View style={[styles.panel, styles.covered]}>
                    <Text style={styles.heading} accessibilityRole="header">🛡️ You're covered</Text>
                    {protection.holding.map((label, i) => (
                        <View key={`${label}-${i}`} style={styles.row} accessible accessibilityLabel={`${label}: holding a piece`}>
                            <Text style={styles.tick}>✅</Text>
                            <Text style={styles.rowLabel}>{label}</Text>
                        </View>
                    ))}
                    <Text style={styles.footnote}>
                        No single piece can open your account — it takes the hub plus any {TWO_LAYER_THRESHOLD} friends.
                    </Text>
                    {renderSsoProviders()}
                </View>
            );
        }
    }

    if (protection.state === 'almost') {
        return (
            <View style={[styles.panel, styles.almost]}>
                <Text style={styles.heading} accessibilityRole="header">🔑 Almost there</Text>
                <Text style={styles.body}>
                    You need one more keeper before your account can be split. Until then, these 12 words are how you get back in.
                </Text>
                {renderSsoProviders()}
            </View>
        );
    }

    return (
        <View style={[styles.panel, styles.wordsOnly]}>
            <Text style={styles.heading} accessibilityRole="header">🔑 Your 12 words are the only way back</Text>
            <Text style={styles.body}>
                Right now these 12 words are the only way back into your account. No email, no
                password reset — nobody, including your hub, can restore it for you.
            </Text>

            <View style={styles.buttonContainer}>
                {renderSsoProviders()}
                {onProtectFriends && (
                    <View style={[styles.actionBlock, { marginTop: 12 }]}>
                        <TouchableOpacity
                            style={styles.buttonSecondary}
                            onPress={onProtectFriends}
                            accessibilityRole="button"
                            accessibilityLabel="Protect with trusted friends"
                        >
                            <Text style={styles.buttonSecondaryText}>🛡️ Protect with trusted friends</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    panel: { borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1 },
    covered: { backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border },
    almost: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
    wordsOnly: { backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    tick: { fontSize: 15, marginRight: 8 },
    rowLabel: { flex: 1, fontSize: 14, color: colors.text.body, flexWrap: 'wrap' },
    footnote: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 10, marginBottom: 4 },
    offer: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 8 },
    buttonContainer: { marginTop: 12 },
    actionBlock: { marginBottom: 8 },
    ssoGroup: {
        marginTop: 14,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 255, 255, 0.1)',
    },
    ssoGroupTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.text.heading,
        marginBottom: 4,
    },
    ssoGroupSubtitle: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginBottom: 10,
    },
    providerConnectedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surface.card,
        borderWidth: 1,
        borderColor: colors.feedback.success.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginTop: 8,
    },
    providerInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    providerName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.text.heading,
    },
    disconnectBtn: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.feedback.error.border,
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
    disconnectText: {
        fontSize: 12,
        fontWeight: '600',
        color: colors.feedback.error.text,
    },
    buttonSecondary: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: colors.text.secondary,
        paddingVertical: 12,
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonSecondaryText: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.text.heading,
    },
    actionNote: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginTop: 8,
        textAlign: 'center',
    },
});
