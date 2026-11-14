/**
 * "＋ Add to my contacts" (scratch/fable-design/DESIGN-private-contacts-fable.md §3.7, slice C2): a text link on a member's
 * profile under Message / Add friend, and a row in a chat's ⋮ menu, each opening this sheet. The same words as the web's
 * AddToContacts: the member names the person (only they see the name), is told the other isn't told and how this differs
 * from Friends, and a typed name already in the list asks whether it is the same person. Nothing is sent: the change is
 * kept locked on the phone and saved after its wait (contacts-sync.ts `editContacts`).
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { CONTACTS_LIMITS, cleanContactName, formatCount, newContactId, putContact, t, type Contact, type ContactLink, type ContactLinkHow } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { contactsOf, useContacts } from '../utils/use-contacts';
import { editContacts } from '../utils/contacts-sync';
import type { ContactsAccount } from '../utils/contacts-store';

/** Who the list already holds for `pubkey`, if anyone. */
export function heldFor(people: readonly Contact[], pubkey: string): Contact | undefined {
    const key = pubkey.toLowerCase();
    return people.find((c) => c.links.some((l) => l.key === key));
}

/** The profile's link, or "In your contacts as …" when the list holds them. Nothing while the list is unread or can't be opened. */
export function AddToContactsLink({ account, pubkey, callsign }: { account: ContactsAccount; pubkey: string; callsign: string }) {
    const view = useContacts(account);
    const [open, setOpen] = useState(false);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        link: { minHeight: 44, justifyContent: 'center', alignSelf: 'center', paddingHorizontal: 12 },
        linkText: { fontSize: 14, fontWeight: '700', color: colors.accent.primary, textDecorationLine: 'underline' },
        held: { fontSize: 13, color: colors.text.muted, textAlign: 'center', marginTop: 12 },
    }));
    // The person is linked as met at the community in use: none when the phone only looks at one as a guest.
    if (!view || view.onPhone.kind === 'unreadable' || !view.anchor) return null;
    const held = heldFor(contactsOf(view), pubkey);
    if (held) return <Text style={styles.held} testID="in-your-contacts">{t('In your contacts as {name}', { name: held.name })}</Text>;
    return (
        <>
            <Pressable accessibilityRole="button" testID="add-to-contacts" style={styles.link} onPress={() => setOpen(true)}>
                <Text style={styles.linkText}>{t('＋ Add to my contacts')}</Text>
            </Pressable>
            {open && <AddToContactsSheet account={account} pubkey={pubkey} callsign={callsign} how="profile" onClose={() => setOpen(false)} />}
        </>
    );
}

export function AddToContactsSheet({ account, pubkey, callsign, how, onClose }: {
    account: ContactsAccount; pubkey: string; callsign: string; how: ContactLinkHow; onClose: () => void;
}) {
    const view = useContacts(account);
    const [name, setName] = useState(callsign);
    const [same, setSame] = useState<Contact | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => setName(callsign), [callsign]);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'flex-end' },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 12 },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
        field: { minHeight: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.app, marginBottom: 12 },
        text: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 16 },
        muted: { fontSize: 13, lineHeight: 19, color: colors.text.muted, marginBottom: 16 },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        go: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        goText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
        btn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center' },
        btnText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        danger: { fontSize: 13, color: colors.feedback.danger.fg, marginTop: 12 },
    }));
    const people = contactsOf(view);
    const held = view ? heldFor(people, pubkey) : undefined;
    const save = async (onto: Contact | null) => {
        if (!view?.anchor) return;
        const link: ContactLink = { key: pubkey.toLowerCase(), community: view.anchor, callsign, how, at: new Date().toISOString() };
        if (!onto && people.length >= CONTACTS_LIMITS.contacts) { setProblem(t('You can keep up to {max} contacts.', { max: formatCount(CONTACTS_LIMITS.contacts) })); return; }
        setBusy(true);
        try {
            await editContacts(account, (l) => putContact(l, onto
                ? { ...onto, links: [...onto.links, link] }
                : { id: newContactId(), name: cleanContactName(name) || callsign, phones: [], emails: [], note: '', links: [link], invite: null }));
            onClose();
        } catch {
            setProblem(t("Couldn't save your contacts on this phone. Try again."));
        } finally {
            setBusy(false);
        }
    };
    const add = () => {
        const typed = cleanContactName(name).toLowerCase();
        const match = typed ? people.find((c) => c.name.toLowerCase() === typed && c.links.length < CONTACTS_LIMITS.links) : undefined;
        if (match) setSame(match);
        else void save(null);
    };
    const unreadable = view?.onPhone.kind === 'unreadable';
    // Only a member is linked, as met at the community in use: a phone that only looks at one as a guest has none to offer.
    if (view && !view.anchor) return null;
    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('Close')}>
                    <Pressable style={styles.sheet} onPress={() => {}} testID="add-to-contacts-sheet">
                        <Text style={styles.title} accessibilityRole="header">{t('Add @{callsign} to your contacts', { callsign })}</Text>
                        {!view ? <Text style={styles.muted}>{t('Loading...')}</Text> : unreadable || held ? (
                            <>
                                <Text style={styles.text}>{held ? t('In your contacts as {name}', { name: held.name }) : t("The contacts list on this phone can't be opened.")}</Text>
                                <Pressable accessibilityRole="button" style={[styles.go, { alignSelf: 'flex-start' }]} onPress={onClose}><Text style={styles.goText}>{t('Got it')}</Text></Pressable>
                            </>
                        ) : same ? (
                            <>
                                <Text style={styles.text}>{t('{name} is already in your list. Add @{callsign} to that person?', { name: same.name, callsign })}</Text>
                                <View style={styles.row}>
                                    <Pressable accessibilityRole="button" style={styles.go} disabled={busy} onPress={() => void save(same)}><Text style={styles.goText}>{t('Yes, same person')}</Text></Pressable>
                                    <Pressable accessibilityRole="button" style={styles.btn} disabled={busy} onPress={() => void save(null)}><Text style={styles.btnText}>{t('No, a new contact')}</Text></Pressable>
                                </View>
                            </>
                        ) : (
                            <>
                                <Text style={styles.label}>{t('Name (only you see it)')}</Text>
                                <TextInput value={name} onChangeText={setName} maxLength={CONTACTS_LIMITS.nameChars} accessibilityLabel={t('Name (only you see it)')} autoCorrect={false} style={styles.field} />
                                <Text style={styles.muted}>{t("@{callsign} isn't told. This is different from Friends: a friend can see you added them.", { callsign })}</Text>
                                <View style={styles.row}>
                                    <Pressable accessibilityRole="button" style={styles.go} disabled={busy} onPress={add}><Text style={styles.goText}>{t('Add')}</Text></Pressable>
                                    <Pressable accessibilityRole="button" style={styles.btn} onPress={onClose}><Text style={styles.btnText}>{t('Cancel')}</Text></Pressable>
                                </View>
                            </>
                        )}
                        {problem && <Text style={styles.danger} accessibilityRole="alert">{problem}</Text>}
                    </Pressable>
                </Pressable>
            </KeyboardAvoidingView>
        </Modal>
    );
}
