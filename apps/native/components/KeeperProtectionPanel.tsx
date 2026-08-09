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
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';

export function KeeperProtectionPanel({ protection }: { protection: Protection }): React.JSX.Element {
    if (protection.state === 'covered') {
        return (
            <View style={[styles.panel, styles.covered]}>
                <Text style={styles.heading} accessibilityRole="header">🛡️ You're covered</Text>
                {/*
                  "Any three of them" is true and useless when there are exactly three — any three
                  IS all three, and a member reading it believes they have slack they do not have.
                  Everyone has exactly three at signup, and anyone without a Google or Apple
                  account stays there.
                */}
                <Text style={styles.body}>
                    {protection.spare > 0
                        ? 'Your account has been split into pieces, and these are holding one each. Any three of them can bring you back if you lose this phone.'
                        : 'Your account has been split into three pieces, and these are holding one each. It takes all three to bring you back — so keep your 12 words below, in case one of them ever goes missing.'}
                </Text>
                {protection.holding.map((label, i) => (
                    <View key={`${label}-${i}`} style={styles.row} accessible accessibilityLabel={`${label}: holding a piece`}>
                        <Text style={styles.tick}>✅</Text>
                        <Text style={styles.rowLabel}>{label}</Text>
                    </View>
                ))}
                {/*
                  Principle 7, and it does double duty. A member who taps a sign-in button during
                  setup WILL tap it on a new phone expecting to be logged in — so this line has to
                  say what a piece is, not just reassure. Nothing here logs anyone into anything.
                */}
                <Text style={styles.footnote}>
                    None of them can open your account on their own — it takes three.
                </Text>
            </View>
        );
    }

    if (protection.state === 'almost') {
        return (
            <View style={[styles.panel, styles.almost]}>
                <Text style={styles.heading} accessibilityRole="header">🔑 Your words are the way back</Text>
                {/*
                  NOT "almost covered, 2 of 3 ✅". Below three keepers nothing has been split, so
                  nobody is holding anything, and ticking two of them would claim a protection
                  that does not exist. What is true is that the pieces are ready to be handed out
                  and one keeper short of being worth handing.
                */}
                <Text style={styles.body}>
                    You're one keeper short of splitting your account into pieces, so for now
                    these 12 words are how you get back in. Keep them somewhere safe.
                </Text>
                <Text style={styles.footnote}>
                    Once you add one more keeper, the pieces get handed out and you won't need to
                    rely on the words.
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.panel, styles.wordsOnly]}>
            <Text style={styles.heading} accessibilityRole="header">🔑 Write these down</Text>
            <Text style={styles.body}>
                Right now these 12 words are the only way back into your account. No email, no
                password reset — nobody, including your hub, can restore it for you.
            </Text>
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
});
