import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { t, WAY_BACK_WORDS } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { oneWayBackSchedule, readOneWayBack, wordsSaidWrittenDown } from '../utils/one-way-back';
import { vaultSignInCopyKnown } from '../utils/vault';

/**
 * The bell sheet's quiet last line about the way back (DESIGN-notify-and-backup-asks-fable.md §5.2 "After ×", amend2 slice
 * B1): "No way back in yet. Keep one ›", once Home's "Your way back in" card has been put away, until a way back is kept
 * (core way-back-schedule.ts `bell`). A standing line, never an ask: Keep one opens Settings' Account Protection, where the
 * card's own section lives. Nothing where the account has no reminder, or keeps a way back (a sign-in added, the words
 * said written down, a sign-in's copy at the key vault). Read each time the sheet opens.
 */
export function WayBackBellLine({ publicKey, colors, onOpen }: { publicKey: string | null | undefined; colors: AppColors; onOpen?: () => void }) {
    const [up, setUp] = useState(false);
    useEffect(() => {
        let live = true;
        if (!publicKey) { setUp(false); return; }
        void Promise.all([
            readOneWayBack(publicKey),
            vaultSignInCopyKnown(publicKey).catch(() => false),
            wordsSaidWrittenDown(publicKey).catch(() => false),
        ]).then(([record, vault, paper]) => {
            if (live) setUp(!!oneWayBackSchedule(record, Date.now(), { kept: vault || paper })?.bell);
        }).catch(() => { if (live) setUp(false); });
        return () => { live = false; };
    }, [publicKey]);
    if (!up) return null;
    const keep = t(WAY_BACK_WORDS.bellKeep);
    return (
        <View style={s.row} testID="bell-way-back">
            <Text style={[s.words, { color: colors.text.secondary }]}>{t(WAY_BACK_WORDS.bell)}</Text>
            <Pressable
                onPress={() => {
                    onOpen?.();
                    router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } });
                }}
                style={({ pressed }) => [s.link, pressed && { backgroundColor: colors.surface.subtle }]}
                accessibilityRole="button"
                accessibilityLabel={keep}
                testID="bell-way-back-keep"
            >
                <Text style={[s.linkText, { color: colors.text.link }]}>{keep} ›</Text>
            </Pressable>
        </View>
    );
}

const s = StyleSheet.create({
    // As the notifications line beside it (NotificationsOffLine): wraps onto its own rows at 320 dp and 1.3x text, a 44 dp touch floor.
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingTop: 4 },
    words: { fontSize: 13, textAlign: 'center' },
    link: { minHeight: 44, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    linkText: { fontSize: 14, fontWeight: '700' },
});
