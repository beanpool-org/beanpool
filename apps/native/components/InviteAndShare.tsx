/**
 * "Invite and share" on a listing or an event (Marty, 3 Nov): one way in the Share sheet (components/SharePost.tsx ShareButton,
 * DESIGN-detail-pages-fable.md §2.5) that invites a friend and brings them to that listing once they have joined. It makes an
 * ordinary invite (the node makes the code), and hands the share sheet the listing's title and
 * `{community}/?invite={code}&post={id}` (utils/invite-and-share.ts).
 *
 * Offered only where this member may invite: the community takes invites and its door lets them (an admin-only door asks their
 * role), and they are no guest. Where they can't, nothing. An invite works once, for one person, and the line under the sheet's
 * item says so. A tap on the item opens the panel in the sheet; nothing is made until Make the invite and share. With no answer
 * from the community no offline ticket is made, and the member is told in the panel; a refusal says the community's own words,
 * and nothing is shared: never a false success.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { INVITE_SHARE_WORDS, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { onlyAdminsInvite, type InviteRole } from '../utils/invite-entries';
import { inviteLink } from '../utils/names-invite';
import { makeInviteForShare, offersInviteAndShare } from '../utils/invite-and-share';
import type { BeanPoolIdentity } from '../utils/identity';
import { askMyVouching, type MyVouching } from '../utils/vouchers';
import { VouchPresetChoice } from './VouchPresetChoice';

export interface InviteAndShare {
    /** This member may invite here: the sheet offers the way. */
    offered: boolean;
    busy: boolean;
    note: string | null;
    clearNote: () => void;
    /** Make the invite and hand it to the share sheet: true once it went to the share sheet, false when nothing was shared. */
    make: () => Promise<boolean>;
    myVouching?: MyVouching | null;
    vouchPreset?: number | null;
    setVouchPreset?: (v: number | null) => void;
}

/**
 * Who is asking, and what the community says of them: read when the Share button is drawn for a post, so the sheet's item is
 * there when it opens. Only where `enabled` (core shareSays offers Invite and share to this member, as the old button was only
 * drawn then): otherwise nothing is read or asked of the node. A role only where only admins invite.
 */
export function useInviteAndShare(post: { id: string; title: string }, enabled: boolean): InviteAndShare {
    const profile = useNodeProfile();
    const features = profile?.features;
    const adminsOnly = onlyAdminsInvite(features);
    const [who, setWho] = useState<{ anchor: string; identity: BeanPoolIdentity; guest: boolean } | null>(null);
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [myVouching, setMyVouching] = useState<MyVouching | null>(null);
    const [vouchPreset, setVouchPreset] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        (async () => {
            try {
                const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
                const { loadIdentity } = await import('../utils/identity');
                const identity = await loadIdentity();
                if (!anchor || !identity) { if (alive) setWho(null); return; }
                const { isGuestNode } = await import('../utils/nodes');
                const guest = await isGuestNode(anchor).catch(() => false);
                if (alive) setWho({ anchor, identity, guest });
                if (guest) return;
                askMyVouching(anchor, identity).then((mv) => { if (alive) setMyVouching(mv); }).catch(() => {});
                if (adminsOnly) {
                    const { askNodeRole, readPersistedNodeRole } = await import('../utils/node-admin');
                    const heard = await askNodeRole(anchor, identity);
                    const last = heard ? heard.role : await readPersistedNodeRole(anchor, identity.publicKey);
                    if (alive) setRole(last);
                }
            } catch {
                if (alive) setWho(null);
            }
        })();
        return () => { alive = false; };
    }, [post.id, adminsOnly, enabled]);

    const offered = enabled && !!who && offersInviteAndShare({ features, role, guest: who.guest, postId: post.id });

    const make = async (): Promise<boolean> => {
        if (!who) return false;
        setBusy(true);
        setNote(null);
        const chosenVouch = myVouching?.voucher ? vouchPreset : null;
        try {
            const made = await makeInviteForShare(who.anchor, who.identity, features, {}, chosenVouch !== null ? chosenVouch : undefined);
            if (!made.ok) {
                setNote(made.message);
                return false;
            }
            setVouchPreset(null);
            askMyVouching(who.anchor, who.identity).then(setMyVouching).catch(() => {});
            await Share.share({ message: `${post.title}\n${inviteLink(who.anchor, made.code, post.id)}`, title: post.title });
            return true;
        } catch (e: any) {
            setNote(e?.message || t(INVITE_SHARE_WORDS.notMade));
            return false;
        } finally {
            setBusy(false);
        }
    };

    return { offered, busy, note, clearNote: () => setNote(null), make, myVouching, vouchPreset, setVouchPreset };
}

/**
 * The panel the sheet's Invite and share item opens: what the invite does, and the one button. `held`:
 * another share is in flight (components/ShareSheet.tsx `holding`), so Make waits too.
 */
export function InviteAndSharePanel({ invite, onMake, held = false }: { invite: InviteAndShare; onMake: () => void; held?: boolean }) {
    const styles = useStyles(makeStyles);
    const off = invite.busy || held;
    return (
        <View style={styles.block} testID="invite-and-share">
            <View style={styles.panel} testID="invite-and-share-panel">
                <Text style={styles.panelText} maxFontSizeMultiplier={1.3}>{t(INVITE_SHARE_WORDS.panel)}</Text>
                {invite.myVouching?.voucher && invite.setVouchPreset && (
                    <VouchPresetChoice
                        value={invite.vouchPreset ?? null}
                        onChange={invite.setVouchPreset}
                        budgetLeft={invite.myVouching.budget?.left ?? 0}
                        budgetTotal={invite.myVouching.budget?.level ?? 0}
                    />
                )}
                <Pressable onPress={onMake} disabled={off} style={[styles.make, off && { opacity: 0.6 }]} accessibilityRole="button"
                    accessibilityState={{ disabled: off }} testID="invite-and-share-make">
                    <Text style={styles.makeText} maxFontSizeMultiplier={1.3}>{t(INVITE_SHARE_WORDS.make)}</Text>
                </Pressable>
            </View>
            {invite.note && (
                <Text style={styles.warn} accessibilityRole="alert" maxFontSizeMultiplier={1.3} testID="invite-and-share-note">{invite.note}</Text>
            )}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    block: { gap: 6, marginBottom: 8 },
    panel: { borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, backgroundColor: colors.surface.card, padding: 12 },
    panelText: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginBottom: 12 },
    make: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
    makeText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    warn: { color: colors.feedback.danger.fg, fontSize: 14, lineHeight: 20, fontWeight: '600' },
});
