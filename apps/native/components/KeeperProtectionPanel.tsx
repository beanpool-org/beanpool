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
import { colors, palette } from '../constants/colors';
import type { Protection } from '../utils/protection-state';

export function KeeperProtectionPanel({ protection }: { protection: Protection }): React.JSX.Element {
    if (protection.state === 'covered') {
        return (
            <View style={[styles.panel, styles.covered]}>
                <Text style={styles.heading}>🛡️ You're covered</Text>
                <Text style={styles.body}>
                    Your account has been split into pieces, and these are holding one each. Any
                    three of them can bring you back if you lose this phone.
                </Text>
                {protection.holding.map(label => (
                    <View key={label} style={styles.row} accessible accessibilityLabel={`${label}: holding a piece`}>
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
                <Text style={styles.heading}>🔑 Your words are the way back</Text>
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
            <Text style={styles.heading}>🔑 Write these down</Text>
            <Text style={styles.body}>
                Right now these 12 words are the only way back into your account. No email, no
                password reset — nobody, including your hub, can restore it for you.
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    panel: { borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1 },
    covered: { backgroundColor: palette.green50, borderColor: palette.green600 },
    almost: { backgroundColor: palette.amber50, borderColor: palette.amber600 },
    wordsOnly: { backgroundColor: palette.blue50, borderColor: palette.blue600 },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    tick: { fontSize: 15, marginRight: 8 },
    // Wraps rather than truncating: these are names, and a long one on a 320dp screen at 1.3×
    // font must still be readable rather than trailing off into an ellipsis.
    rowLabel: { flex: 1, fontSize: 14, color: colors.text.body, flexWrap: 'wrap' },
    footnote: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 10 },
});
