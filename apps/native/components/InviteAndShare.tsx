/**
 * "Invite and share" on a listing or an event, beside the Share buttons (Marty, 3 Nov): one button that invites a friend and
 * brings them to that listing once they have joined. It makes an ordinary invite (the node makes the code), with the Vouch for
 * them choice of the People tab for someone who can vouch (None unless they choose), and hands the share sheet the listing's
 * title and `{community}/?invite={code}&post={id}` (utils/invite-and-share.ts).
 *
 * Drawn only where this member may invite: the community takes invites and its door lets them (an admin-only door asks their
 * role), and they are no guest. Where they can't, nothing: asking an admin is another slice. An invite works once, for one
 * person, and the line under the button says so. With no answer from the community no offline ticket is made, and the member
 * is told; a refusal says the community's own words, and nothing is shared: never a false success.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { INVITE_SHARE_WORDS, offersInviteVouch, t, type VouchLevel } from '@beanpool/core';
import { useStyles, useTheme, type ThemeContextType } from '../app/ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { onlyAdminsInvite, type InviteRole } from '../utils/invite-entries';
import { inviteLink } from '../utils/names-invite';
import { makeInviteForShare, offersInviteAndShare } from '../utils/invite-and-share';
import { InviteVouchChoice } from './InviteVouchChoice';
import type { BeanPoolIdentity } from '../utils/identity';

export function InviteAndShareButton({ post }: { post: { id: string; title: string } }) {
    const styles = useStyles(makeStyles);
    const { colors } = useTheme();
    const profile = useNodeProfile();
    const features = profile?.features;
    const adminsOnly = onlyAdminsInvite(features);
    const vouchHere = features?.inviteVouch === true;
    const [who, setWho] = useState<{ anchor: string; identity: BeanPoolIdentity; guest: boolean } | null>(null);
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [canVouch, setCanVouch] = useState(false);
    const [open, setOpen] = useState(false);
    const [vouchLevel, setVouchLevel] = useState<VouchLevel | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    // Who is asking, and what the community says of them: each time the button is drawn for a listing. Nothing is asked of a
    // community that takes no invites, and a role only where only admins invite.
    useEffect(() => {
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
                if (adminsOnly) {
                    const { askNodeRole, readPersistedNodeRole } = await import('../utils/node-admin');
                    const heard = await askNodeRole(anchor, identity);
                    const last = heard ? heard.role : await readPersistedNodeRole(anchor, identity.publicKey);
                    if (alive) setRole(last);
                }
                if (vouchHere) {
                    const { askCanVouch } = await import('../utils/db');
                    const can = await askCanVouch(identity.publicKey).catch(() => false);
                    if (alive) setCanVouch(can);
                }
            } catch {
                if (alive) setWho(null);
            }
        })();
        return () => { alive = false; };
    }, [post.id, adminsOnly, vouchHere]);

    if (!who || !offersInviteAndShare({ features, role, guest: who.guest, postId: post.id })) return null;
    const offersVouch = offersInviteVouch(features, canVouch);

    const make = async () => {
        setBusy(true);
        setNote(null);
        try {
            const made = await makeInviteForShare(who.anchor, who.identity, offersVouch ? vouchLevel : null, features);
            if (!made.ok) {
                setNote(made.message);
                return;
            }
            setVouchLevel(null);
            setOpen(false);
            await Share.share({ message: `${post.title}\n${inviteLink(who.anchor, made.code, post.id)}`, title: post.title });
        } catch (e: any) {
            setNote(e?.message || t(INVITE_SHARE_WORDS.notMade));
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.block} testID="invite-and-share">
            <Pressable onPress={() => { setOpen(o => !o); setNote(null); }} style={styles.btn} accessibilityRole="button"
                accessibilityState={{ expanded: open }} testID="invite-and-share-button">
                <Text style={styles.btnText}>{t(INVITE_SHARE_WORDS.button)}</Text>
            </Pressable>
            <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="invite-and-share-line">{t(INVITE_SHARE_WORDS.line)}</Text>
            {open && (
                <View style={styles.panel} testID="invite-and-share-panel">
                    <Text style={styles.panelText} maxFontSizeMultiplier={1.3}>{t(INVITE_SHARE_WORDS.panel)}</Text>
                    {offersVouch && <InviteVouchChoice value={vouchLevel} onChange={setVouchLevel} colors={colors} />}
                    <Pressable onPress={make} disabled={busy} style={[styles.make, busy && { opacity: 0.6 }]} accessibilityRole="button"
                        accessibilityState={{ disabled: busy }} testID="invite-and-share-make">
                        <Text style={styles.makeText}>{t(INVITE_SHARE_WORDS.make)}</Text>
                    </Pressable>
                </View>
            )}
            {note && (
                <Text style={styles.warn} accessibilityRole="alert" maxFontSizeMultiplier={1.3} testID="invite-and-share-note">{note}</Text>
            )}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    block: { gap: 6 },
    btn: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    line: { color: colors.text.secondary, fontSize: 13, lineHeight: 18 },
    panel: { borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, backgroundColor: colors.surface.card, padding: 12 },
    panelText: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginBottom: 12 },
    make: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
    makeText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    warn: { color: colors.feedback.danger.fg, fontSize: 14, lineHeight: 20, fontWeight: '600' },
});
