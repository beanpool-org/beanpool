/**
 * The DM screen's banner while the key behind the other person's name has changed (DESIGN-dm-peer-key-pin §3.5,
 * slice 2). It says what changed in plain words, shows the new key's code for the member to check with the person, and
 * offers "Continue with the new key" only once they tick that they did (pick 1). "Not now" changes nothing. Words and
 * styles live in utils/dm-key-change.ts, where the small-screen and contrast rules are tested.
 */
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { t } from '@beanpool/core';
import { useStyles } from '../../app/ThemeContext';
import { dmKeyChangeCopy, dmKeyChangeStyleSpec } from '../../utils/dm-key-change';
import { keyCodeOf, keyCodeSpoken } from '../../utils/key-code';
import type { DmKeyChange } from '../../utils/db';

export interface DmKeyChangedBannerProps {
    peerName?: string | null;
    change: DmKeyChange;
    /** The member continues with `peer` (the key whose code they checked). Resolves when the pin has moved, or not. */
    onContinue: (peer: string) => Promise<void> | void;
    onNotNow: () => void;
}

export function DmKeyChangedBanner({ peerName, change, onContinue, onNotNow }: DmKeyChangedBannerProps) {
    const styles = useStyles(({ colors }) => dmKeyChangeStyleSpec(colors));
    const [checked, setChecked] = useState(false);
    const [busy, setBusy] = useState(false);
    const code = keyCodeOf(change.offeredPeer);
    const copy = dmKeyChangeCopy({ peerName, code, firstSight: change.firstSight, afterReset: change.afterReset, rekeyedAt: change.rekeyedAt });
    const canContinue = !!code && checked && !busy;

    const handleContinue = async () => {
        if (!canContinue || !change.offeredPeer) return;
        setBusy(true);
        try {
            await onContinue(change.offeredPeer);
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.banner} accessibilityRole="alert">
            <Text style={styles.title} accessibilityRole="header">{copy.title}</Text>
            <Text style={styles.body}>{copy.body}</Text>
            {code && (
                <View style={styles.codeBox}>
                    <Text style={styles.code} accessibilityLabel={t('Key code: {code}', { code: keyCodeSpoken(code) })} selectable>{code}</Text>
                </View>
            )}
            {copy.dateLine && <Text style={styles.dateLine}>{copy.dateLine}</Text>}
            {copy.confirm && (
                <Pressable
                    style={styles.confirmRow}
                    onPress={() => setChecked(c => !c)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={copy.confirm}
                >
                    <View style={styles.confirmBox}>{checked && <Text style={styles.confirmTick}>✓</Text>}</View>
                    <Text style={styles.confirmText}>{copy.confirm}</Text>
                </Pressable>
            )}
            <View style={styles.buttons}>
                {copy.continueLabel && (
                    <Pressable
                        style={[styles.continueBtn, !canContinue && styles.continueBtnOff]}
                        onPress={handleContinue}
                        disabled={!canContinue}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canContinue }}
                        accessibilityLabel={copy.continueLabel}
                    >
                        <Text style={[styles.continueText, !canContinue && styles.continueTextOff]}>{copy.continueLabel}</Text>
                    </Pressable>
                )}
                <Pressable style={styles.notNowBtn} onPress={onNotNow} accessibilityRole="button" accessibilityLabel={copy.notNowLabel}>
                    <Text style={styles.notNowText}>{copy.notNowLabel}</Text>
                </Pressable>
            </View>
        </View>
    );
}
