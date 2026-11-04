/**
 * Share a post (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C, §3.4): **Share with members**,
 * the community's own link to it (`?post=<id>`, which opens it for a member and the community's doors for anyone else),
 * and, where the community lets members share outside (`features.shareOutside`) and the post is one everyone here sees,
 * **Share outside the community**: the community makes a link for this post alone (utils/peek.ts), which anyone may open
 * for seven days and read the post without names or faces. It is listed under Settings → Shared outside, to stop it.
 *
 * ONE Share button (DESIGN-detail-pages-fable.md §2.5, slice DP2; Marty, 4 Nov: "All Fable's picks", question 3): `🔗 Share`
 * opens a sheet (components/ShareSheet.tsx) with the ways this member has, each with its sentence (core shareSays) under its
 * name, so every sentence still shows before the tap that shares: Share with members, Share outside the community, Invite and
 * share, Ask an admin to invite someone. The sheet is not the share: nothing is made, asked or handed over until an item is
 * tapped. The item with its sentence is the confirmation for sharing outside, so the phone asks no second question (the web
 * never did). A listing and an event draw the same button (SharePostButtons; components/EventExtras.tsx EventShareAndCalendar).
 *
 * Each hands the link to the phone's share sheet. A refusal says the node's own words, and nothing is shared: never a
 * false success.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share, Alert, Platform, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { INVITE_ASK_WORDS, INVITE_SHARE_WORDS, PEEK_WORDS as W, shareSays, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { useShareRole } from '../utils/use-share-role';
import { useNodeStatus } from '../app/NodeStatusContext';
import { eventLink } from '../utils/event-extras';
import { makePeekLink, peekStopsHere } from '../utils/peek';
import { InviteAndSharePanel, useInviteAndShare } from './InviteAndShare';
import { ShareSheet, type ShareSheetItem } from './ShareSheet';
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
 * Make the link and hand it to the share sheet: after a question, or with `confirmed` straight away (the Share sheet's item,
 * whose sentence is the question). Confirmed, the promise settles once the share sheet has answered; asked, at once.
 *
 * The node makes the link before the sheet opens, so a sheet the member closes (iOS says so; Android's never does) or
 * one that fails leaves a live link: seven days, one of the member's 50. With `unsent` (the button's own, so it goes
 * with the screen) that link is kept and the next Share hands it over, rather than making a second; never one made
 * before a Stop sharing since, which may be that one.
 */
export function confirmShareOutside(
    post: { id: string; title: string }, onBusy?: (busy: boolean) => void, unsent?: { current: UnsentPeekLink | null },
    // What the question says: the same note the way carries (one note for the privacy and the 7 days).
    body: string = t(W.shareOutsideLine),
    { confirmed = false }: { confirmed?: boolean } = {},
): Promise<void> {
    const share = async () => {
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
    };
    if (confirmed) return share();
    Alert.alert(t(W.shareOutside), body, [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Share'), onPress: share },
    ]);
    return Promise.resolve();
}

/**
 * "Ask an admin to invite someone", the sheet's last way where only admins invite (core shareSays showAskAdmin). It opens the
 * ONE ask form People → Invites uses (components/InviteAsks.tsx AskSheet), loaded on the tap so a sheet that never asks carries
 * none of it. Once the node has taken the ask the member is told so under the Share button; a failure to start says the
 * community could not be reached.
 */
function useAskAdmin() {
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

    const sheet = form ? (
        <form.Sheet anchorUrl={form.anchorUrl} identity={form.identity} open={open}
            onClose={() => setOpen(false)}
            onSent={() => { setOpen(false); setNote({ text: t(INVITE_ASK_WORDS.waiting), ok: true }); }} />
    ) : null;
    return { openForm, note, sheet };
}

/**
 * The one Share button and its sheet, for a listing or an event. `onShareMembers` hands the members' link to the share sheet
 * (the listing's and the event's words differ); the rest is the same for both. A tap that shares keeps the sheet open until
 * the share sheet has answered, then closes it (on iOS a share sheet presented while the Modal is still going would not show).
 * Until then Cancel, every way, the backdrop and Back do nothing (ShareSheet `holding`): one share at a time, and only its own
 * answer closes the sheet. A community that does not answer ends the hold at the request's time limit, with its words.
 */
export function ShareButton({ post, onShareMembers, accessibilityLabel, style, buttonStyle, textStyle, oneLine }: {
    post: any;
    onShareMembers: () => Promise<void>;
    accessibilityLabel: string;
    /** The block's own place (a row's share of the width on an event). */
    style?: StyleProp<ViewStyle>;
    buttonStyle?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
    /** On one line, shrinking to fit (a row of two). */
    oneLine?: boolean;
}) {
    const styles = useStyles(makeStyles);
    const profile = useNodeProfile();
    const role = useShareRole(profile?.features);
    // Invite and share and the ask are a member's: a guest here, or one the node has not yet recognised, is offered neither.
    const { recognition } = useNodeStatus();
    const says = shareSays(profile?.features, role, post?.type === 'event' ? 'event' : 'listing');
    // ONE invite action (share-one-flow): Invite and share, where this member may invite and the line does not say only admins
    // do. Where only admins invite and this member is none, the line stands and the ask is offered instead (#2775). Never both.
    // Nothing is read for it where it is not offered.
    const invite = useInviteAndShare(post, says.showInviteButton && recognition === 'member');
    const ask = useAskAdmin();
    const showOutside = says.showShareOutside && shareableOutside(post);
    const showInvite = invite.offered;
    const showAsk = says.showAskAdmin && recognition === 'member';

    const [open, setOpen] = useState(false);
    const [panel, setPanel] = useState(false);
    const [busy, setBusy] = useState<'members' | 'outside' | null>(null);
    const unsent = useRef<UnsentPeekLink | null>(null);
    // What to open once the sheet has gone: on iOS a Modal cannot open while another is still closing.
    const afterClose = useRef<(() => void) | null>(null);

    const close = (then?: () => void) => {
        setOpen(false);
        setPanel(false);
        invite.clearNote();
        if (!then) return;
        if (Platform.OS === 'ios') afterClose.current = then;
        else then();
    };
    const dismissed = () => {
        const then = afterClose.current;
        afterClose.current = null;
        then?.();
    };

    const shareMembers = async () => {
        setBusy('members');
        try {
            await onShareMembers();
        } finally {
            setBusy(null);
            close();
        }
    };
    const shareOutside = () => confirmShareOutside(
        { id: post.id, title: post.title },
        (on) => { setBusy(on ? 'outside' : null); if (!on) close(); },
        unsent, says.outsideLine ? t(says.outsideLine) : undefined, { confirmed: true },
    );
    const makeInvite = async () => {
        if (await invite.make()) close();
    };
    // A share in flight (the link or the invite being made, or the phone's share sheet up): the sheet ignores Cancel, every
    // way, the backdrop and Back until it has answered, then closes itself. Closed sooner, the share would still open after it
    // (Android) or never answer (iOS, presented while the sheet fades), leaving its item dimmed and a made link unkept; a second
    // way started meanwhile would close the sheet under the first, or make a second link. The link and the invite each stop
    // waiting at their time limit (utils/peek.ts makePeekLink, utils/invite-and-share.ts makeInviteForShare), so this ends.
    const holding = busy !== null || invite.busy;

    const items: ShareSheetItem[] = [{
        key: 'members', label: t(W.shareWithMembers), line: says.membersLine ? t(says.membersLine) : null,
        onPress: () => void shareMembers(), busy: busy === 'members', testID: 'share-members-button', lineTestID: 'share-members-note',
    }];
    if (showOutside) items.push({
        key: 'outside', label: t(W.shareOutside), line: says.outsideLine ? t(says.outsideLine) : null,
        onPress: () => void shareOutside(), busy: busy === 'outside', testID: 'share-outside-button', lineTestID: 'share-outside-line',
    });
    if (showInvite) items.push({
        key: 'invite', label: t(INVITE_SHARE_WORDS.button), line: t(INVITE_SHARE_WORDS.line),
        onPress: () => { setPanel((p) => !p); invite.clearNote(); }, expanded: panel,
        testID: 'invite-and-share-button', lineTestID: 'invite-and-share-line',
    });
    if (showAsk) items.push({
        key: 'ask', label: t(INVITE_ASK_WORDS.button), onPress: () => close(() => void ask.openForm()), testID: 'share-ask-admin-button',
    });

    return (
        <View style={style}>
            <Pressable onPress={() => setOpen(true)} style={buttonStyle ?? styles.btn} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
                testID="share-open-button">
                <Text style={textStyle ?? styles.btnText} maxFontSizeMultiplier={1.3}
                    {...(oneLine ? { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.7 } : {})}>{t('🔗 Share')}</Text>
            </Pressable>
            {ask.note && (
                <Text style={ask.note.ok ? styles.note : styles.noteWarn} accessibilityLiveRegion="polite" testID="share-ask-admin-note">{ask.note.text}</Text>
            )}
            <ShareSheet
                visible={open}
                onClose={() => close()}
                holding={holding}
                onDismiss={dismissed}
                // The invite panel takes the other ways' place; its own way stays above it, a tap away from the list.
                items={panel ? items.filter((i) => i.key === 'invite') : items}
                body={panel && showInvite ? <InviteAndSharePanel invite={invite} held={holding} onMake={() => void makeInvite()} /> : null}
            />
            {ask.sheet}
        </View>
    );
}

/** A listing's Share: the one button, and the members' link with the listing's title. */
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
            <ShareButton post={post} onShareMembers={shareWithMembers} accessibilityLabel={t('Share')} />
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    column: { gap: 10, marginTop: 12, marginBottom: 4 },
    btn: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    note: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 6 },
    noteWarn: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 18, marginTop: 6 },
});
