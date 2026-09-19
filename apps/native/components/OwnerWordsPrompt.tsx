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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from '../app/IdentityContext';
import { useStyles } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { cachedNodeRole } from '../utils/node-admin';
import {
    OWNER_WORDS_COPY as COPY, cachedOwnerWordsStatus, readLaterRound, rememberLater, shouldPromptOwner,
    type OwnerWordsStatus,
} from '../utils/owner-words';
import { runLockOpenCheck } from '../utils/takeover-unlock';
import { ownerWordsStyleSpec } from '../utils/owner-words-style';

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
            <Text style={styles.promptTitle}>{status.wordsCheckedAt ? COPY.promptTitleRenew : COPY.promptTitleNever}</Text>
            <Text style={styles.promptBody}>{status.wordsCheckedAt ? COPY.promptBodyRenew : COPY.promptBodyNever}</Text>
            <View style={styles.buttonRow}>
                <Pressable style={styles.primaryBtn} onPress={() => router.push('/owner-words-check')} accessibilityRole="button">
                    <Text style={styles.primaryBtnText}>{COPY.checkNow}</Text>
                </Pressable>
                <Pressable style={styles.secondaryBtn} onPress={onLater} accessibilityRole="button" accessibilityHint="Hides this until your next check is due. Settings still has it.">
                    <Text style={styles.secondaryBtnText}>{COPY.later}</Text>
                </Pressable>
            </View>
        </View>
    );
}
