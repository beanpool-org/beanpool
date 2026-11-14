/**
 * Import on the phone (scratch/fable-design/DESIGN-private-contacts-fable.md §3.4, slice C3): the three ways in, the
 * phone's answer to the contacts question in the design's words, "Choose who to bring" and "Done", in the web
 * ContactsPage's words and rules (apps/pwa, slice C4) with "this phone" for "this device". The logic is
 * utils/contacts-import.ts; app/contacts.tsx holds which of these shows.
 *
 * The contacts question is asked only by the press on "From this phone's contacts", and nothing is read into the list or
 * sent anywhere before Import (§3.4). In an app built without the two native parts (an older dev client) their rows are
 * not offered: Type one in still is.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CONTACTS_LIMITS, formatCount, t, tn, type ContactCandidate, type ContactsList } from '@beanpool/core';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import {
    askForPhoneContacts, contactsPickerModules, phoneContactsModule, pickContactsFile, readPhoneContacts, reviewRows,
} from '../utils/contacts-import';

/** What an import read: who was found, and how (a file can be cut off or hold more than is read). */
export interface ImportRead {
    candidates: ContactCandidate[];
    more: number;
    cutOff: boolean;
    fromPhone: boolean;
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    body: { padding: 16, paddingBottom: 40 },
    text: { fontSize: 15, lineHeight: 21, color: colors.text.body, marginBottom: 12 },
    muted: { fontSize: 14, lineHeight: 20, color: colors.text.muted, marginBottom: 12 },
    small: { fontSize: 13, lineHeight: 19, color: colors.text.muted, marginTop: 6 },
    choice: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 12, marginBottom: 10, minHeight: 44 },
    choiceTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
    choiceText: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 4 },
    card: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 12, marginBottom: 10 },
    btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
    btn: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
    go: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
    goText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
    link: { minHeight: 44, justifyContent: 'center' },
    linkText: { fontSize: 15, fontWeight: '700', color: colors.accent.primary },
    bold: { fontWeight: '800' },
    danger: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg, marginBottom: 12 },
    field: { minHeight: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border.default },
    rowName: { fontSize: 16, fontWeight: '700', color: colors.text.body },
    rowSub: { fontSize: 13, color: colors.text.muted, marginTop: 2 },
    bar: { padding: 12, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
});

/** "Import contacts" (design §3.4): from this phone's contacts, from a contacts file, or by hand. */
export function ImportScreen({ full, onRead, onTypeOne, onBack }: {
    full: boolean; onRead: (r: ImportRead) => void; onTypeOne: () => void; onBack: () => void;
}) {
    const styles = useStyles(makeStyles);
    const { colors } = useTheme();
    const [answer, setAnswer] = useState<'denied' | 'blocked' | null>(null);
    const [reading, setReading] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [help, setHelp] = useState(false);
    // Looked up once: whether this build carries each native part (requiring one asks nothing).
    const [phone] = useState(() => phoneContactsModule());
    const [picker] = useState(() => contactsPickerModules());

    const fromPhone = async () => {
        if (!phone || reading) return;
        setProblem(null);
        setAnswer(null);
        // The system question comes straight after this tap, never earlier (memory permissions-only-when-asked).
        const said = await askForPhoneContacts(phone);
        if (said !== 'granted') { setAnswer(said); return; }
        setReading(true);
        try {
            onRead({ candidates: await readPhoneContacts(phone), more: 0, cutOff: false, fromPhone: true });
        } catch (e) {
            console.warn('[Contacts] The phone\'s contacts were not read', e);
            setProblem(t("Couldn't read your phone's contacts. Try again."));
        } finally {
            setReading(false);
        }
    };
    const fromFile = async () => {
        if (!picker || reading) return;
        setProblem(null);
        setAnswer(null);
        setReading(true);
        try {
            const r = await pickContactsFile(picker);
            if (r.kind === 'refused') setProblem(t(r.words));
            if (r.kind === 'read') onRead({ candidates: r.candidates, more: r.more, cutOff: r.cutOff, fromPhone: false });
        } catch (e) {
            console.warn('[Contacts] The file picker failed', e);
            setProblem(t("Couldn't read that file. Try again."));
        } finally {
            setReading(false);
        }
    };
    const cards: Array<[string, string]> = [
        [t('Android phone'), t('1. Open the Contacts app. 2. Look for **Export**: it is often under Organise, under Manage contacts, or in the ⋮ menu. 3. Save the file. It ends in .vcf.')],
        [t('iPhone'), t('1. Open Contacts and tap **Lists**. 2. Press and hold **All Contacts**, then tap **Export**. 3. Save it to Files. It ends in .vcf.')],
        [t('Google Contacts on a computer'), t('1. Open contacts.google.com. 2. Click **Export**. 3. Choose **vCard** and click Export.')],
    ];
    return (
        <FlatList data={[]} renderItem={null} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} ListHeaderComponent={<>
            <Text style={styles.text}>{t("Choose where your contacts are. WhatsApp uses your phone's contacts, so this brings those too.")}</Text>
            {/* What a tap brought (reading, a file refused, the phone's answer) above the choices: at 320 dp and 1.3x text anything
                under them starts below the fold, out of sight of the finger that tapped. */}
            {reading && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}><ActivityIndicator color={colors.text.muted} /><Text style={styles.muted}>{t('Loading...')}</Text></View>}
            {problem && <Text style={styles.danger} accessibilityRole="alert">{problem}</Text>}
            {answer === 'denied' && (
                <View style={styles.card} testID="import-said-no" accessibilityLiveRegion="polite">
                    <Text style={styles.text}>{t("No problem. BeanPool can't see your phone's contacts. You can pick a contacts file instead, or add people by hand.")}</Text>
                    <View style={styles.btnRow}>
                        {picker && <Pressable accessibilityRole="button" style={styles.go} onPress={() => void fromFile()}><Text style={styles.goText}>{t('Pick a file')}</Text></Pressable>}
                        <Pressable accessibilityRole="button" style={styles.btn} onPress={onBack}><Text style={styles.btnText}>{t('Back')}</Text></Pressable>
                    </View>
                </View>
            )}
            {answer === 'blocked' && (
                <View style={styles.card} testID="import-blocked" accessibilityLiveRegion="polite">
                    <Text style={styles.text}>{t("Your phone is set not to let BeanPool see contacts. To change it, open your phone's Settings, then BeanPool, then Contacts.")}</Text>
                    <View style={styles.btnRow}>
                        <Pressable accessibilityRole="button" style={styles.go} onPress={() => { void Linking.openSettings(); }}><Text style={styles.goText}>{t('Open Settings')}</Text></Pressable>
                        {picker && <Pressable accessibilityRole="button" style={styles.btn} onPress={() => void fromFile()}><Text style={styles.btnText}>{t('Pick a file instead')}</Text></Pressable>}
                    </View>
                </View>
            )}
            {phone && (
                <Pressable accessibilityRole="button" testID="import-from-phone" style={styles.choice} disabled={reading} onPress={() => void fromPhone()}>
                    <Text style={styles.choiceTitle}>{t("From this phone's contacts")}</Text>
                    <Text style={styles.choiceText}>{t('BeanPool asks your phone for permission now, reads names, numbers and emails, and shows them to you first.')}</Text>
                    <Text style={styles.small}>{t("Contacts you saved only inside WhatsApp aren't in your phone's contacts. Save them to your phone in WhatsApp first.")}</Text>
                </Pressable>
            )}
            {picker && (
                <Pressable accessibilityRole="button" testID="import-from-file" style={styles.choice} disabled={reading} onPress={() => void fromFile()}>
                    <Text style={styles.choiceTitle}>{t('From a contacts file (.vcf)')}</Text>
                    <Text style={styles.choiceText}>{t('No permission needed. Pick a file you exported or were sent.')}</Text>
                </Pressable>
            )}
            {!full && (
                <Pressable accessibilityRole="button" style={styles.choice} onPress={onTypeOne}>
                    <Text style={styles.choiceTitle}>{t('Type one in')}</Text>
                    <Text style={styles.choiceText}>{t('Add a person by hand.')}</Text>
                </Pressable>
            )}
            {picker && (
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: help }} style={styles.link} onPress={() => setHelp(!help)}>
                    <Text style={styles.linkText}>{t('How do I export a contacts file? ›')}</Text>
                </Pressable>
            )}
            {help && cards.map(([title, steps]) => (
                <View key={title} style={styles.card}>
                    <Text style={styles.choiceTitle}>{title}</Text>
                    {/* The steps with their **bold** parts bold (the button names, as the web's BoldWords). Written here, on this
                        screen's own table, so the contrast check (e2e/button-contrast.check.ts) reads them on the card's ground. */}
                    <Text style={styles.choiceText}>{steps.split('**').map((part, i) => (i % 2 ? <Text key={i} style={styles.bold}>{part}</Text> : part))}</Text>
                </View>
            ))}
        </>} />
    );
}

/** "Choose who to bring" (design §3.4, Q3): everyone ticked but who is already in the list or has no number or email. */
export function ReviewScreen({ list, read, busy, onImport }: {
    list: ContactsList; read: ImportRead; busy: boolean; onImport: (chosen: ContactCandidate[]) => void;
}) {
    const styles = useStyles(makeStyles);
    const { colors } = useTheme();
    const rows = useMemo(() => reviewRows(list, read.candidates).map((r) => ({
        ...r, sub: r.c.phones[0] ?? r.c.emails[0] ?? '', hay: [r.name, ...r.c.phones, ...r.c.emails].join('\n').toLowerCase(),
    })), [list, read.candidates]);
    const [ticked, setTicked] = useState(() => new Set(rows.filter((r) => !r.had && !r.bare).map((r) => r.i)));
    const [q, setQ] = useState('');
    const typed = q.trim().toLowerCase();
    const shown = useMemo(() => (typed ? rows.filter((r) => r.hay.includes(typed)) : rows), [rows, typed]);
    const n = ticked.size;
    const over = list.contacts.length + n - CONTACTS_LIMITS.contacts;
    const flip = (i: number) => setTicked((s) => { const next = new Set(s); if (next.has(i)) next.delete(i); else next.add(i); return next; });
    const top = (
        <>
            <Text style={[styles.text, { fontWeight: '700' }]}>{tn(rows.length, 'Found {n} contact. Nothing has left your phone yet.', 'Found {n} contacts. Nothing has left your phone yet.')}</Text>
            {read.cutOff && <Text style={styles.muted}>{t('The file ended part way through a contact. That one was left out.')}</Text>}
            {read.more > 0 && <Text style={styles.muted}>{tn(read.more, 'Only the first {max} were read: {n} more is in the file.', 'Only the first {max} were read: {n} more are in the file.', { max: formatCount(read.candidates.length) })}</Text>}
            <TextInput value={q} onChangeText={setQ} placeholder={t('Search')} placeholderTextColor={colors.text.muted} accessibilityLabel={t('Search the contacts found')} style={styles.field} />
            <View style={[styles.btnRow, { alignItems: 'center', marginBottom: 8 }]}>
                <Text style={[styles.muted, { marginBottom: 0 }]}>{tn(n, '{n} ticked', '{n} ticked')}</Text>
                {n > 0
                    ? <Pressable accessibilityRole="button" style={styles.btn} onPress={() => setTicked(new Set())}><Text style={styles.btnText}>{t('Untick all')}</Text></Pressable>
                    : <Pressable accessibilityRole="button" style={styles.btn} onPress={() => setTicked(new Set(rows.filter((r) => !r.had).map((r) => r.i)))}><Text style={styles.btnText}>{t('Tick all')}</Text></Pressable>}
            </View>
        </>
    );
    return (
        <View style={{ flex: 1 }}>
            <FlatList
                data={shown}
                extraData={ticked}
                keyExtractor={(r) => String(r.i)}
                contentContainerStyle={styles.body}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={15}
                maxToRenderPerBatch={20}
                windowSize={7}
                ListHeaderComponent={top}
                renderItem={({ item: r }) => {
                    const on = ticked.has(r.i);
                    return (
                        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on }} testID="import-row" style={styles.row} onPress={() => flip(r.i)}>
                            <MaterialCommunityIcons name={on ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={on ? colors.brand.fill : colors.text.muted} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                                <Text style={styles.rowSub} numberOfLines={2}>
                                    {[r.sub, r.had ? t('(already in your list)') : r.bare ? t('(no number or email)') : ''].filter(Boolean).join(' · ')}
                                </Text>
                            </View>
                        </Pressable>
                    );
                }}
            />
            <View style={styles.bar}>
                {over > 0 && <Text style={styles.danger} accessibilityRole="alert">{tn(over, 'You can keep up to {max} contacts. Untick {n} to continue.', 'You can keep up to {max} contacts. Untick {n} to continue.', { max: formatCount(CONTACTS_LIMITS.contacts) })}</Text>}
                <Pressable accessibilityRole="button" testID="import-go" style={[styles.go, (busy || n === 0 || over > 0) && { opacity: 0.5 }]} disabled={busy || n === 0 || over > 0}
                    onPress={() => onImport(rows.filter((r) => ticked.has(r.i)).map((r) => r.c))}>
                    <Text style={styles.goText}>{tn(n, 'Import {n} contact', 'Import {n} contacts')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

/** "Done" (design §3.4): how many, where they will be kept, and, after the phone's contacts, that it read them once. */
export function DoneScreen({ added, fromPhone, places, onDone }: { added: number; fromPhone: boolean; places: string | null; onDone: () => void }) {
    const styles = useStyles(makeStyles);
    return (
        <View style={styles.body} testID="import-done">
            <Text style={[styles.text, { fontWeight: '700', fontSize: 16 }]}>
                {places
                    ? tn(added, "{n} contact added. It's locked with your key and will be kept at: {places}.", "{n} contacts added. They're locked with your key and will be kept at: {places}.", { places })
                    : tn(added, '{n} contact added.', '{n} contacts added.')}
            </Text>
            {!places && <Text style={styles.muted}>{t('Kept on this phone only. Save a copy as a file to keep it safe.')}</Text>}
            {fromPhone && <Text style={styles.muted}>{t("BeanPool read your phone's contacts once, just now. It doesn't watch them. To bring new ones later, tap Import again.")}</Text>}
            <Pressable accessibilityRole="button" style={[styles.go, { alignSelf: 'flex-start' }]} onPress={onDone}><Text style={styles.goText}>{t('Done')}</Text></Pressable>
        </View>
    );
}
