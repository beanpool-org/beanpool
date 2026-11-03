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
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { INVITE_ASK_WORDS, PEEK_WORDS as W, shareSays, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { useShareRole } from '../utils/use-share-role';
import { useNodeStatus } from '../app/NodeStatusContext';
import { eventLink } from '../utils/event-extras';
import { makePeekLink, peekStopsHere } from '../utils/peek';
import { InviteAndShareButton } from './InviteAndShare';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * Whether a post may be offered for sharing outside: one everyone here sees, on the board, and not an event that has
 * ended or was cancelled (an ended event stays 'active' until the 30-day scrub; the node refuses it all the same). The
 * node decides in the end (apps/server engine/peek-tickets.ts visitorsPost).
 */
export function shareableOutside(post: any, now = Date.now()): boolean {
    const scope = post?.audience_scope ?? post?.audienceScope ?? 'public';
    const active = post?.active === undefined || post?.active === true || post?.active === 1;
    if (post?.type === 'event') {
        const endAt = post?.eventEndAt ?? post?.event_end_at;
        if ((post?.eventState ?? post?.event_state) === 'cancelled' || (typeof endAt === 'string' && Date.parse(endAt) <= now)) return false;
    }
    return scope === 'public' && active && (post?.status === 'active' || post?.status === 'pending');
}

/** A link made for `postId` but not handed over, and how many stops there had been then (utils/peek.ts peekStopsHere). */
export type UnsentPeekLink = { postId: string; link: string; stops: number };

/**
 * Ask, then make the link and hand it to the share sheet. Exported for the event's own Share row.
 *
 * The node makes the link before the sheet opens, so a sheet the member closes (iOS says so; Android's never does) or
 * one that fails leaves a live link: seven days, one of the member's 50. With `unsent` (the button's own, so it goes
 * with the screen) that link is kept and the next Share hands it over, rather than making a second; never one made
 * before a Stop sharing since, which may be that one.
 */
export function confirmShareOutside(
    post: { id: string; title: string }, onBusy?: (busy: boolean) => void, unsent?: { current: UnsentPeekLink | null },
    // What the confirmation says: the same note the button carries (one note for the privacy and the 7 days).
    body: string = t(W.shareOutsideLine),
): void {
    Alert.alert(t(W.shareOutside), body, [
        { text: t('Cancel'), style: 'cancel' },
        {
            text: t('Share'),
            onPress: async () => {
                onBusy?.(true);
                const kept = unsent?.current;
                let link = kept && kept.postId === post.id && kept.stops === peekStopsHere() ? kept.link : null;
                const keep = (made: string) => { if (unsent) unsent.current = { postId: post.id, link: made, stops: peekStopsHere() }; };
                try {
                    if (!link) link = (await makePeekLink(post.id)).link;
                    const shared = await Share.share({ message: `${post.title}\n${link}`, title: post.title });
                    if (shared?.action === Share.dismissedAction) keep(link);
                    else if (unsent) unsent.current = null;
                } catch (e: any) {
                    if (link) keep(link);
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
    const unsent = useRef<UnsentPeekLink | null>(null);
    const says = shareSays(profile?.features, undefined, post?.type === 'event' ? 'event' : 'listing');
    if (!says.showShareOutside || !shareableOutside(post)) return null;
    return (
        <View style={styles.outsideBlock}>
            <Pressable onPress={() => confirmShareOutside({ id: post.id, title: post.title }, setBusy, unsent, says.outsideLine ? t(says.outsideLine) : undefined)} disabled={busy}
                style={[styles.btn, busy && { opacity: 0.6 }]} accessibilityRole="button" testID="share-outside-button">
                <Text style={styles.btnText}>{t(W.shareOutside)}</Text>
            </Pressable>
            {/* ONE note before the tap: how long anyone with the link can read it, no names or faces, that it can be stopped, and
                (where joining is on) that they can then ask to join. */}
            {says.outsideLine && (
                <Text style={styles.note} testID="share-outside-line">
                    {t(says.outsideLine)}
                </Text>
            )}
        </View>
    );
}

/**
 * "Ask an admin to invite someone", under the line "only admins invite here" (core shareSays showAskAdmin). It opens the ONE ask
 * form People → Invites uses (components/InviteAsks.tsx AskSheet), loaded on the tap so a share sheet that never asks carries
 * none of it. Once the node has taken the ask the member is told so; a failure to start says the community could not be reached.
 */
export function AskAdminButton() {
    const styles = useStyles(makeStyles);
    const [form, setForm] = useState<{ anchorUrl: string; identity: BeanPoolIdentity; Sheet: typeof import('./InviteAsks').AskSheet } | null>(null);
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

    const openForm = async () => {
        setNote(null);
        try {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            const { loadIdentity } = await import('../utils/identity');
            const identity = await loadIdentity();
            if (!anchorUrl || !identity) throw new Error('no identity');
            const { AskSheet } = await import('./InviteAsks');
            setForm({ anchorUrl, identity, Sheet: AskSheet });
            setOpen(true);
        } catch {
            setNote({ text: t(INVITE_ASK_WORDS.unreachable), ok: false });
        }
    };

    return (
        <View style={styles.outsideBlock} testID="share-ask-admin">
            <Pressable onPress={() => void openForm()} style={styles.btn} accessibilityRole="button" testID="share-ask-admin-button">
                <Text style={styles.btnText}>{t(INVITE_ASK_WORDS.button)}</Text>
            </Pressable>
            {note && (
                <Text style={note.ok ? styles.note : styles.noteWarn} accessibilityLiveRegion="polite" testID="share-ask-admin-note">{note.text}</Text>
            )}
            {form && (
                <form.Sheet anchorUrl={form.anchorUrl} identity={form.identity} open={open}
                    onClose={() => setOpen(false)}
                    onSent={() => { setOpen(false); setNote({ text: t(INVITE_ASK_WORDS.waiting), ok: true }); }} />
            )}
        </View>
    );
}

/** A listing's two shares: the members' link, and outside where the community allows it. */
export function SharePostButtons({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const profile = useNodeProfile();
    const role = useShareRole(profile?.features);
    // Invite and share is a member's: a guest here, or one the node has not yet recognised, is not offered it.
    const { recognition } = useNodeStatus();
    const says = shareSays(profile?.features, role, post?.type === 'event' ? 'event' : 'listing');
    const showInvite = says.showInviteButton && recognition === 'member';
    // Where only admins invite and this member is none: the same member-only gate, then "Ask an admin to invite someone".
    const showAsk = says.showAskAdmin && recognition === 'member';

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
            {says.membersLine && (
                <Text style={styles.note} testID="share-members-note">
                    {t(says.membersLine)}
                </Text>
            )}
            {says.showShareOutside && <ShareOutsideButton post={post} />}
            {/* ONE invite action (share-one-flow): Invite and share, where this member may invite and the line above does not
                say only admins do. Where only admins invite and this member is none, the line stands and one more button,
                "Ask an admin to invite someone", opens the ask form of People → Invites (#2775). Never both. */}
            {showInvite && <InviteAndShareButton post={post} />}
            {showAsk && <AskAdminButton />}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    column: { gap: 10, marginTop: 12, marginBottom: 4 },
    outsideBlock: { gap: 6 },
    btn: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    note: { color: colors.text.secondary, fontSize: 13, lineHeight: 18 },
    noteWarn: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 18 },
});
