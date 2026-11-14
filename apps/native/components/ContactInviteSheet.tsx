/**
 * Invite from a contact, on the phone (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, slice C5; the web's twin is
 * apps/pwa/src/components/ContactInviteSheet.tsx, the words core's contacts-invite.ts):
 *
 *   Invite Dee to Riverside
 *   One invite, for one person. It works once, for 30 days.
 *   Dee's name and number are not sent to the server.
 *   [ Share… ]  [ Text message ]  [ Copy ]
 *
 * A tap makes the community's ordinary invite with NO note (utils/invite-and-share.ts: its body is the maker's key alone),
 * keeps "this code was for Dee" inside the locked list, and hands today's invite message to the member's own app: the share
 * sheet, the phone's text app with the number filled in (only when there is one), or the clipboard. Nothing is made before
 * the tap. A refusal (a paused account, the daily limit) is the server's own sentence, and nothing is shared.
 *
 * Where the member can't invite, the existing words: invites off (the global community) offers its plain link; an admins-only
 * door offers the existing ask, empty, with one line more ("The admins will see the first name you type here").
 */
import React, { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
    contactInviteLines, contactInviteTitle, contactInviteWords, contactSmsLink, inviteAndShareLink, inviteShareText, putContact, shareAddress, t,
    withContactInvite, type Contact,
} from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { makeInviteForShare } from '../utils/invite-and-share';
import { ADMINS_ONLY_FALLBACK, communityLinkMessage, invitesOffFallback, mayInviteHere, onlyAdminsInvite, type InviteRole } from '../utils/invite-entries';
import { invitesOn } from '../utils/node-profile';
import { useNodeProfile } from '../utils/use-node-profile';
import { editContacts } from '../utils/contacts-sync';
import type { BeanPoolIdentity } from '../utils/identity';
import { AskSheet } from './InviteAsks';

type How = 'share' | 'text' | 'copy';

export function ContactInviteSheet({ contact, anchor, community, identity, onClose }: {
    contact: Contact; anchor: string; community: string; identity: BeanPoolIdentity; onClose: () => void;
}) {
    const styles = useStyles(makeStyles);
    // The community in use's features (its invites switch and its door), as People reads them.
    const features = useNodeProfile()?.features;
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);
    const adminsOnly = onlyAdminsInvite(features);
    // The member's role, only where only admins invite (as People asks it). Not heard yet counts as before: the node decides.
    useEffect(() => {
        if (!adminsOnly) return;
        let alive = true;
        void (async () => {
            const { askNodeRole, readPersistedNodeRole } = await import('../utils/node-admin');
            const heard = await askNodeRole(anchor, identity).catch(() => null);
            const last = heard ? heard.role : await readPersistedNodeRole(anchor, identity.publicKey);
            if (alive) setRole(last);
        })();
        return () => { alive = false; };
    }, [adminsOnly, anchor, identity.publicKey]);

    const phone = contact.phones.find((p) => contactSmsLink(p, '', Platform.OS) !== null);
    const go = async (how: How) => {
        setBusy(true);
        setNote(null);
        try {
            const made = await makeInviteForShare(anchor, identity, features);
            if (!made.ok) { setNote(made.message); return; }
            // Kept in the locked list only. The invite stands even if this phone couldn't save the change: it is still shared.
            await editContacts(identity, (l) => {
                const held = l.contacts.find((c) => c.id === contact.id);
                return held ? putContact(l, withContactInvite(held, made.code, anchor)) : l;
            }).catch(() => {});
            const message = inviteShareText({ name: community, link: inviteAndShareLink(anchor, made.code), code: made.code, address: shareAddress(anchor) });
            if (how === 'copy') {
                await Clipboard.setStringAsync(message);
                setNote(contactInviteWords.copied());
                return;
            }
            if (how === 'text' && phone) await Linking.openURL(contactSmsLink(phone, message, Platform.OS)!);
            else await Share.share({ message });
            onClose();
        } catch {
            setNote(t('The invite was not made.'));
        } finally {
            setBusy(false);
        }
    };

    const button = (label: string, onPress: () => void, strong = false, testID?: string) => (
        <Pressable accessibilityRole="button" style={[strong ? styles.go : styles.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={onPress} testID={testID}>
            <Text style={strong ? styles.goText : styles.btnText} maxFontSizeMultiplier={1.3}>{label}</Text>
        </Pressable>
    );
    let body: React.ReactNode;
    if (!invitesOn(features)) {
        body = <>
            <Text style={styles.text}>{invitesOffFallback(features)}</Text>
            <View style={styles.row}>{button(t('📤 Share the link'), () => { Share.share({ message: communityLinkMessage(anchor) }).catch(() => {}); onClose(); }, true)}</View>
        </>;
    } else if (!mayInviteHere(features, role)) {
        body = <>
            <Text style={styles.text}>{t(ADMINS_ONLY_FALLBACK)}</Text>
            <View style={styles.row}>{button(contactInviteWords.askAdmin(contact.name), () => setAsking(true), true, 'contact-invite-ask')}</View>
        </>;
    } else {
        const [once, kept] = contactInviteLines(contact);
        body = <>
            <Text style={styles.title} accessibilityRole="header">{contactInviteTitle(contact.name, community)}</Text>
            <Text style={styles.text}>{once}</Text>
            <Text style={styles.text}>{kept}</Text>
            <View style={styles.row}>
                {button(contactInviteWords.share(), () => void go('share'), true)}
                {!!phone && button(contactInviteWords.text(), () => void go('text'))}
                {button(contactInviteWords.copy(), () => void go('copy'))}
            </View>
        </>;
    }
    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose}>
            <View style={styles.scrim}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('Close')} />
                <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetBody} testID="contact-invite-sheet">
                    {body}
                    {!!note && <Text style={styles.note} accessibilityLiveRegion="polite">{note}</Text>}
                    {button(t('Close'), onClose)}
                </ScrollView>
            </View>
            <AskSheet anchorUrl={anchor} identity={identity} open={asking} line={contactInviteWords.askLine()}
                onClose={() => setAsking(false)} onSent={() => { setAsking(false); onClose(); }} />
        </Modal>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'center', padding: 16 },
    sheet: { maxHeight: '90%', backgroundColor: colors.surface.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default },
    sheetBody: { padding: 16, gap: 10 },
    title: { fontSize: 18, fontWeight: '800', color: colors.text.heading },
    text: { fontSize: 15, lineHeight: 21, color: colors.text.body },
    note: { fontSize: 14, lineHeight: 20, color: colors.text.body },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    btn: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
    go: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
    goText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
});
