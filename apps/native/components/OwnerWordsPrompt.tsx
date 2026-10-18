/**
 * The gentle prompt on the home tab: "Your 12 words aren't checked … [Check now] [Later]" (sealed-keys.md §7).
 *
 * Owners only, and only on the design's cadence: when they first become an owner, then 12 months after their last
 * check. "Later" puts it away for that round, stored as the round name only (utils/owner-words.ts), and the Settings
 * row is always there. Nothing is withheld either way.
 *
 * Costs a non-owner nothing new: the owner question goes through the header's in-memory role cache (one request per
 * ten minutes, shared), and only an owner's app asks for the words status, itself cached in memory.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { t, word } from '@beanpool/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from '../app/IdentityContext';
import { useStyles } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { cachedNodeRole } from '../utils/node-admin';
import {
    cachedOwnerWordsStatus, readLaterRound, rememberLater, shouldPromptOwner,
    type OwnerWordsStatus,
} from '../utils/owner-words';
import { runLockOpenCheck } from '../utils/takeover-unlock';
import { ownerWordsStyleSpec } from '../utils/owner-words-style';

// The prompt's words as word() keys, here and not in utils/owner-words.ts: that file is on the 12 words' key path, which
// never reaches the words layer (core recovery-path-files.test.ts). The English is OWNER_WORDS_COPY's, unchanged.
const PROMPT = {
    titleNever: word("Your 12 words aren't checked"),
    bodyNever: word("If you lose this phone you couldn't take over the server or open a backup."),
    titleRenew: word('Time to check your 12 words'),
    bodyRenew: word("It's a year since you last checked them. If you lose this phone, they're how you'd take over the server or open a backup."),
    checkNow: word('Check now'),
    later: word('Later'),
} as const;

export function OwnerWordsPrompt() {
    const { identity } = useIdentity();
    const styles = useStyles(({ colors }) => StyleSheet.create(ownerWordsStyleSpec(colors)));
    const [status, setStatus] = useState<OwnerWordsStatus | null>(null);
    const [show, setShow] = useState(false);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) setShow(false); return; }
                const role = await cachedNodeRole(url, identity);
                if (role.role !== 'owner') { if (!cancelled) setShow(false); return; }
                // The silent open check (slice 6): once in a while, confirm this phone still opens the current lock.
                void runLockOpenCheck(url, identity, AsyncStorage);
                const got = await cachedOwnerWordsStatus(url, identity);
                const later = await readLaterRound(AsyncStorage, identity.publicKey);
                if (cancelled) return;
                setStatus(got);
                setShow(shouldPromptOwner(got, later));
            })().catch(() => { if (!cancelled) setShow(false); });
            return () => { cancelled = true; };
        }, [identity])
    );

    if (!show || !status || !identity) return null;

    const onLater = () => {
        setShow(false);
        void rememberLater(AsyncStorage, identity.publicKey, status);
    };

    return (
        <View style={styles.promptCard} accessibilityRole="summary">
            <Text style={styles.promptTitle}>{status.wordsCheckedAt ? t(PROMPT.titleRenew) : t(PROMPT.titleNever)}</Text>
            <Text style={styles.promptBody}>{status.wordsCheckedAt ? t(PROMPT.bodyRenew) : t(PROMPT.bodyNever)}</Text>
            <View style={styles.buttonRow}>
                <Pressable style={styles.primaryBtn} onPress={() => router.push('/owner-words-check')} accessibilityRole="button">
                    <Text style={styles.primaryBtnText}>{t(PROMPT.checkNow)}</Text>
                </Pressable>
                <Pressable style={styles.secondaryBtn} onPress={onLater} accessibilityRole="button" accessibilityHint={t('Hides this until your next check is due. Settings still has it.')}>
                    <Text style={styles.secondaryBtnText}>{t(PROMPT.later)}</Text>
                </Pressable>
            </View>
        </View>
    );
}
