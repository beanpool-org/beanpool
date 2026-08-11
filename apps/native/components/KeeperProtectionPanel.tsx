/**
 * Step 3's opening — what a new member is told about getting back into their account.
 *
 * Deliberately thin. Every decision it renders comes from `protectionFrom` in
 * `utils/protection-state.ts`, which is tested; this file chooses words and spacing. The split
 * matters because the failure worth guarding against here is a member being told they are
 * covered when they are not, and that is a logic bug wearing a screen's clothes.
 *
 * The copy follows one rule: **it may understate what a member has and may never overstate it.**
 */

import React from 'react';
import { StyleSheet, Text, View, Platform, TouchableOpacity } from 'react-native';
import { TWO_LAYER_THRESHOLD } from '@beanpool/core';
import { colors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';

export function KeeperProtectionPanel({ 
    protection,
    onProtectSso,
    onProtectFriends,
}: { 
    protection: Protection;
    onProtectSso?: () => void;
    onProtectFriends?: () => void;
}): React.JSX.Element {
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
                        Neither of them can open your account alone — it takes both.
                    </Text>
                    {onProtectFriends && (
                        <TouchableOpacity
                            onPress={onProtectFriends}
                            accessibilityRole="button"
                            accessibilityLabel="Add a trusted friend for extra protection"
                            style={{ marginTop: 12 }}
                        >
                            <Text style={styles.offer}>
                                Want extra protection? Add a trusted friend — then you can recover without Apple too.
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
                    {/* The hub fragment A is XOR-mandatory and is NEVER counted in a threshold */}
                    <Text style={styles.footnote}>
                        No single piece can open your account — it takes the hub plus any {TWO_LAYER_THRESHOLD} friends.
                    </Text>
                </View>
            );
        }
    }

    if (protection.state === 'almost') {
        return (
            <View style={[styles.panel, styles.almost]}>
                <Text style={styles.heading} accessibilityRole="header">🔑 Almost there</Text>
                {/*
                  NOT "almost covered, 2 of 3 ✅". Below threshold nothing has been split, so
                  nobody is holding anything, and ticking keepers would claim a protection
                  that does not exist.
                */}
                <Text style={styles.body}>
                    You need one more keeper before your account can be split. Until then, these 12 words are how you get back in.
                </Text>
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
                {Platform.OS === 'ios' && onProtectSso && (
                    <View style={styles.actionBlock}>
                        <TouchableOpacity style={styles.buttonSecondary} onPress={onProtectSso} accessibilityRole="button">
                            <Text style={styles.buttonSecondaryText}>Protect with Apple sign-in</Text>
                        </TouchableOpacity>
                        <Text style={styles.actionNote}>This is not a login — your account stays your own key.</Text>
                    </View>
                )}
                {onProtectFriends && (
                    <View style={styles.actionBlock}>
                        <TouchableOpacity style={styles.buttonSecondary} onPress={onProtectFriends} accessibilityRole="button">
                            <Text style={styles.buttonSecondaryText}>Protect with trusted friends</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    panel: { borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1 },
    // Semantic tokens rather than raw palette steps (CR) — `colors.feedback` is the layer that
    // survives a theme change, and reaching past it into palette.green50 is how a panel ends up
    // the only thing on screen still light when everything around it is not.
    covered: { backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border },
    almost: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
    wordsOnly: { backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    tick: { fontSize: 15, marginRight: 8 },
    // Wraps rather than truncating: these are names, and a long one on a 320dp screen at 1.3×
    // font must still be readable rather than trailing off into an ellipsis.
    rowLabel: { flex: 1, fontSize: 14, color: colors.text.body, flexWrap: 'wrap' },
    footnote: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 10 },
    offer: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 12 },
    buttonContainer: { marginTop: 16 },
    actionBlock: { marginBottom: 12 },
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
        fontSize: 13,
        lineHeight: 18,
        color: colors.text.secondary,
        marginTop: 6,
        textAlign: 'center',
    },
});
