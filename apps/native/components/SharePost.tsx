/**
 * Share a post (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C, §3.4): **Share with members**,
 * the community's own link to it (`?post=<id>`, which opens it for a member and the community's doors for anyone else),
 * and, where the community lets members share outside (`features.shareOutside`) and the post is one everyone here sees,
 * **Share outside the community**: the community makes a link for this post alone (utils/peek.ts), which anyone may open
 * for seven days and read the post without names or faces. It is listed under Settings → Shared outside, to stop it.
 *
 * Each hands the link to the phone's share sheet. A refusal says the node's own words, and nothing is shared: never a
 * false success.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PEEK_WORDS as W, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { shareOutsideOn } from '../utils/node-profile';
import { eventLink } from '../utils/event-extras';
import { makePeekLink } from '../utils/peek';

/** Whether a post may be offered for sharing outside: one everyone here sees, on the board. The node decides in the end. */
export function shareableOutside(post: any): boolean {
    const scope = post?.audience_scope ?? post?.audienceScope ?? 'public';
    const active = post?.active === undefined || post?.active === true || post?.active === 1;
    return scope === 'public' && active && (post?.status === 'active' || post?.status === 'pending');
}

/** Ask, then make the link and hand it to the share sheet. Exported for the event's own Share row. */
export function confirmShareOutside(post: { id: string; title: string }, onBusy?: (busy: boolean) => void): void {
    Alert.alert(t(W.shareOutside), t(W.shareOutsideNote), [
        { text: t('Cancel'), style: 'cancel' },
        {
            text: t('Share'),
            onPress: async () => {
                onBusy?.(true);
                try {
                    const { link } = await makePeekLink(post.id);
                    await Share.share({ message: `${post.title}\n${link}`, title: post.title });
                } catch (e: any) {
                    Alert.alert(t(W.notShared), e?.message || t('Please try again.'));
                } finally {
                    onBusy?.(false);
                }
            },
        },
    ]);
}

/** "Share outside the community", where the community allows it and the post may go: otherwise nothing at all. */
export function ShareOutsideButton({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const profile = useNodeProfile();
    const [busy, setBusy] = useState(false);
    if (!shareOutsideOn(profile?.features) || !shareableOutside(post)) return null;
    return (
        <Pressable onPress={() => confirmShareOutside({ id: post.id, title: post.title }, setBusy)} disabled={busy}
            style={[styles.btn, busy && { opacity: 0.6 }]} accessibilityRole="button" testID="share-outside-button">
            <Text style={styles.btnText}>{t(W.shareOutside)}</Text>
        </Pressable>
    );
}

/** A listing's two shares: the members' link, and outside where the community allows it. */
export function SharePostButtons({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const shareWithMembers = async () => {
        try {
            const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!anchor) throw new Error(t('You are currently offline.'));
            const link = eventLink(anchor, post.id);
            await Share.share({ message: `${post.title}\n${link}`, title: post.title });
        } catch (e: any) {
            Alert.alert(t(W.notShared), e?.message || t('Please try again.'));
        }
    };
    return (
        <View style={styles.column} testID="share-post">
            <Pressable onPress={shareWithMembers} style={styles.btn} accessibilityRole="button" testID="share-members-button">
                <Text style={styles.btnText}>{t(W.shareWithMembers)}</Text>
            </Pressable>
            <ShareOutsideButton post={post} />
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    column: { gap: 10, marginTop: 12, marginBottom: 4 },
    btn: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
