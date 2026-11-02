/**
 * Settings → "Confirmed by an admin · step back", for a confirmed member only, with the rule under it
 * (scratch/fable-design/DESIGN-balance-rule-fable.md §2). Draws nothing for anyone else, on an older node, or offline.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { KNOWN_RULE_WORDS, t, yourRuleLine } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { memberRule, type MemberRule } from '../utils/known-rule';
import type { BeanPoolIdentity } from '../utils/identity';
import { StepBackSheet } from './StepBackSheet';

export function ConfirmedSettingsRow() {
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const [held, setHeld] = useState<MemberRule | null>(null);
    const [asking, setAsking] = useState(false);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            (async () => {
                const url = await anchorUrl().catch(() => null);
                const answer = url && identity?.publicKey && identity.privateKey ? await memberRule(url, identity as BeanPoolIdentity) : null;
                if (live) setHeld(answer);
            })();
            return () => { live = false; };
        }, [identity]),
    );

    if (!held?.me.confirmed) return null;
    return (
        <View style={styles.card}>
            <Pressable style={styles.row} onPress={() => setAsking(true)} accessibilityRole="button" testID="confirmed-settings-row">
                <Text style={styles.rowText}>{t(KNOWN_RULE_WORDS.settingsRow)}</Text>
            </Pressable>
            <Text style={styles.rule}>{yourRuleLine(held.rule)}</Text>
            <StepBackSheet visible={asking} onClose={() => setAsking(false)} onSteppedBack={() => { setAsking(false); setHeld(null); }} />
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8, marginBottom: 16, backgroundColor: colors.surface.card, borderColor: colors.border.default },
    row: { minHeight: 48, justifyContent: 'center' },
    rowText: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text.link },
    rule: { fontSize: 14, lineHeight: 20, color: colors.text.body, paddingBottom: 8 },
});
