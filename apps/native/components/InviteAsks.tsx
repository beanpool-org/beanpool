/**
 * A member asks an admin to invite someone (Marty, 3 Nov), on People → Invites; the web's components/InviteAsks.tsx is the
 * same. `AskAnAdmin`: for a member where only admins invite, a small button and a short sheet, and what they've asked.
 * `InviteAsksToAnswer`: for an owner or admin, each ask with Send invite and No. The node decides each (core offersInviteAsk
 * says what to show). A small button, no banner: nobody is hassled.
 *
 * What someone typed is always in `Fenced`, as plain text in its own box, and never put into one of the app's sentences.
 * Every control is at least 44 dp tall and wraps at 320 dp with 1.3× text.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    INVITE_ASK_LIMITS, INVITE_ASK_WORDS, formatDate, inviteAskAnswerWords, inviteAskReady, t,
    type InviteAskAnswer, type InviteAskToAnswer, type InviteAskWaiting,
} from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import { useModalKeyboardLift } from './useModalKeyboardLift';
import { useScrollFieldIntoView } from './useScrollFieldIntoView';
import { askAnAdmin, readAsksToAnswer, readMyAsks, sayNoToAsk, sendInviteForAsk, takeBackAsk } from '../utils/invite-asks';
import { askMyVouching, type MyVouching } from '../utils/vouchers';
import { VouchPresetChoice } from './VouchPresetChoice';
import type { BeanPoolIdentity } from '../utils/identity';

const askedWords = (iso: string) => t(INVITE_ASK_WORDS.asked, { date: formatDate(new Date(iso), 'day-month-year') });

function useAskStyles() {
    return useStyles(({ colors }) => StyleSheet.create({
        section: { marginTop: 16 },
        heading: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginTop: 16, marginBottom: 8 },
        help: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 10 },
        card: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 14, padding: 14, marginBottom: 10 },
        meta: { fontSize: 12, color: colors.text.muted },
        line: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 6 },
        who: { fontSize: 15, fontWeight: '800', color: colors.text.heading },
        fence: { borderLeftWidth: 3, borderLeftColor: colors.border.strong, paddingLeft: 10, marginTop: 8 },
        fenceName: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        fenceText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        code: { fontSize: 16, fontWeight: '800', letterSpacing: 1, color: colors.text.heading, marginTop: 8 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
        quiet: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        quietText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        strong: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        strongText: { fontSize: 15, fontWeight: '800', color: colors.text.onBrand },
        field: { minHeight: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.subtle, marginTop: 6, marginBottom: 12 },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        refusal: { fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg, marginBottom: 10 },
        note: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 10 },
        backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay.scrim },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 16 },
        sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
    }));
}

/** Words a person typed, set apart: never read as the app's own, never as markup. */
function Fenced({ name, line }: { name?: string; line: string }) {
    const styles = useAskStyles();
    return (
        <View style={styles.fence} testID="invite-ask-fence">
            {!!name && <Text style={styles.fenceName}>{name}</Text>}
            <Text style={styles.fenceText}>{line}</Text>
        </View>
    );
}

function Button({ label, onPress, strong, disabled, testID }: { label: string; onPress: () => void; strong?: boolean; disabled?: boolean; testID?: string }) {
    const styles = useAskStyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !!disabled }}
            disabled={disabled}
            onPress={onPress}
            testID={testID}
            style={[strong ? styles.strong : styles.quiet, disabled && { opacity: 0.6 }]}
        >
            <Text style={strong ? styles.strongText : styles.quietText}>{label}</Text>
        </Pressable>
    );
}

function Waiting({ ask, busy, onTakeBack }: { ask: InviteAskWaiting; busy: boolean; onTakeBack: () => void }) {
    const styles = useAskStyles();
    return (
        <View style={styles.card} testID={`invite-ask-waiting-${ask.id}`}>
            <Text style={styles.meta}>{askedWords(ask.askedAt)}</Text>
            <Text style={styles.meta}>{t(INVITE_ASK_WORDS.waiting)}</Text>
            <Fenced name={ask.firstName} line={ask.howKnown} />
            <View style={styles.actions}>
                <Button label={t(INVITE_ASK_WORDS.takeBack)} onPress={onTakeBack} disabled={busy} testID={`invite-ask-take-back-${ask.id}`} />
            </View>
        </View>
    );
}

function Answered({ answer, onShare }: { answer: InviteAskAnswer; onShare: (code: string) => void }) {
    const styles = useAskStyles();
    return (
        <View style={styles.card} testID={`invite-ask-answer-${answer.id}`}>
            <Text style={styles.meta}>{askedWords(answer.askedAt)}</Text>
            <Text style={styles.line}>{inviteAskAnswerWords(answer)}</Text>
            {!!answer.reason && <Fenced line={answer.reason} />}
            {!!answer.code && (
                <>
                    <Text style={styles.code} selectable>{answer.code}</Text>
                    <View style={styles.actions}>
                        <Button label={t('📋 Copy')} onPress={() => { void Clipboard.setStringAsync(answer.code!); }} />
                        <Button label={t('📤 Share')} strong onPress={() => onShare(answer.code!)} />
                    </View>
                </>
            )}
        </View>
    );
}

/**
 * The short ask form (Their first name, How you know them, Send to the admins). ONE form: People → Invites and the Share
 * sheet's "Ask an admin to invite someone" both open this one. `onSent` runs after the node took the ask.
 */
export function AskSheet({ anchorUrl, identity, open, onClose, onSent }: {
    anchorUrl: string; identity: BeanPoolIdentity; open: boolean; onClose: () => void; onSent: () => void;
}) {
    const { colors } = useTheme();
    const styles = useAskStyles();
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8);
    const fieldScroll = useScrollFieldIntoView();
    const [firstName, setFirstName] = useState('');
    const [howKnown, setHowKnown] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);

    const close = () => { setRefusal(null); onClose(); };
    const send = async () => {
        setBusy(true);
        const r = await askAnAdmin(anchorUrl, identity, firstName, howKnown);
        setBusy(false);
        if (!r.ok) { setRefusal(r.message ?? t(INVITE_ASK_WORDS.unreachable)); return; }
        setFirstName('');
        setHowKnown('');
        setRefusal(null);
        onSent();
    };
    return (
        <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
            <View style={[styles.backdrop, { paddingTop: insets.top + 8 }]}>
                <View style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID="invite-ask-sheet">
                    <ScrollView {...fieldScroll.scrollProps} keyboardShouldPersistTaps="handled">
                        <Text style={styles.sheetTitle} accessibilityRole="header">{t(INVITE_ASK_WORDS.button)}</Text>
                        <Text style={styles.help}>{t(INVITE_ASK_WORDS.help)}</Text>
                        <Text style={styles.label}>{t(INVITE_ASK_WORDS.firstName)}</Text>
                        <TextInput
                            {...fieldScroll.inputProps}
                            style={styles.field}
                            value={firstName}
                            onChangeText={setFirstName}
                            maxLength={INVITE_ASK_LIMITS.firstName}
                            accessibilityLabel={t(INVITE_ASK_WORDS.firstName)}
                            autoCapitalize="words"
                            autoCorrect={false}
                            placeholderTextColor={colors.text.muted}
                            testID="invite-ask-first-name"
                        />
                        <Text style={styles.label}>{t(INVITE_ASK_WORDS.howKnown)}</Text>
                        <TextInput
                            {...fieldScroll.inputProps}
                            style={styles.field}
                            value={howKnown}
                            onChangeText={setHowKnown}
                            maxLength={INVITE_ASK_LIMITS.howKnown}
                            accessibilityLabel={t(INVITE_ASK_WORDS.howKnown)}
                            // One line to the node (it closes up line breaks), wrapped here so all of it shows at 320 dp.
                            multiline
                            textAlignVertical="top"
                            placeholderTextColor={colors.text.muted}
                            testID="invite-ask-how-known"
                        />
                        {!!refusal && <Text style={styles.refusal} accessibilityLiveRegion="polite">{refusal}</Text>}
                        <View style={[styles.actions, { marginTop: 0 }]}>
                            <Button label={t(INVITE_ASK_WORDS.send)} strong onPress={() => void send()} disabled={busy || !inviteAskReady(firstName, howKnown)} testID="invite-ask-send" />
                            <Button label={t('Cancel')} onPress={close} />
                        </View>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** For a member where only admins invite: the small button, the short sheet, and what they've asked. */
export function AskAnAdmin({ anchorUrl, identity, onShare }: { anchorUrl: string; identity: BeanPoolIdentity; onShare: (code: string) => void }) {
    const styles = useAskStyles();
    const [mine, setMine] = useState<{ waiting: InviteAskWaiting[]; answers: InviteAskAnswer[] } | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);

    const load = useCallback(async () => {
        const read = await readMyAsks(anchorUrl, identity);
        if (read) setMine(read);
    }, [anchorUrl, identity]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const takeBack = async (id: string) => {
        setBusy(true);
        const r = await takeBackAsk(anchorUrl, identity, id);
        setBusy(false);
        setRefusal(r.ok ? null : r.message ?? t(INVITE_ASK_WORDS.unreachable));
        void load();
    };

    const shown = (mine?.waiting.length ?? 0) + (mine?.answers.length ?? 0) > 0;
    return (
        <View style={styles.section} testID="invite-ask">
            <Button label={t(INVITE_ASK_WORDS.button)} onPress={() => setOpen(true)} testID="invite-ask-open" />
            {!open && !!refusal && <Text style={[styles.refusal, { marginTop: 10 }]} accessibilityLiveRegion="polite">{refusal}</Text>}
            {shown && <Text style={styles.heading} accessibilityRole="header">{t(INVITE_ASK_WORDS.mine)}</Text>}
            {mine?.waiting.map(ask => <Waiting key={ask.id} ask={ask} busy={busy} onTakeBack={() => void takeBack(ask.id)} />)}
            {mine?.answers.map(answer => <Answered key={answer.id} answer={answer} onShare={onShare} />)}
            <AskSheet anchorUrl={anchorUrl} identity={identity} open={open} onClose={() => setOpen(false)} onSent={() => { setOpen(false); void load(); }} />
        </View>
    );
}

function AskCard({ ask, busy, myVouching, onSend, onNo }: {
    ask: InviteAskToAnswer; busy: boolean; myVouching: MyVouching | null;
    onSend: (vouch?: number) => void; onNo: (reason: string) => void;
}) {
    const { colors } = useTheme();
    const styles = useAskStyles();
    const [saying, setSaying] = useState(false);
    const [reason, setReason] = useState('');
    const [vouchPreset, setVouchPreset] = useState<number | null>(null);
    return (
        <View style={styles.card} testID={`invite-ask-${ask.id}`}>
            <Text style={styles.who}>{t(INVITE_ASK_WORDS.askedBy, { name: ask.askerCallsign })}</Text>
            <Text style={styles.meta}>{askedWords(ask.askedAt)}</Text>
            <Fenced name={ask.firstName} line={ask.howKnown} />
            {myVouching?.voucher && (
                <View style={{ marginTop: 8 }}>
                    <VouchPresetChoice
                        value={vouchPreset}
                        onChange={setVouchPreset}
                        budgetLeft={myVouching.budget?.left ?? 0}
                        budgetTotal={myVouching.budget?.level ?? 0}
                    />
                </View>
            )}
            {saying ? (
                <>
                    <Text style={[styles.label, { marginTop: 12 }]}>{t(INVITE_ASK_WORDS.reason)}</Text>
                    <TextInput
                        style={styles.field}
                        value={reason}
                        onChangeText={setReason}
                        maxLength={INVITE_ASK_LIMITS.reason}
                        accessibilityLabel={t(INVITE_ASK_WORDS.reason)}
                        multiline
                        textAlignVertical="top"
                        placeholderTextColor={colors.text.muted}
                        testID={`invite-ask-reason-${ask.id}`}
                    />
                    <View style={[styles.actions, { marginTop: 0 }]}>
                        <Button label={t(INVITE_ASK_WORDS.say)} strong onPress={() => onNo(reason)} disabled={busy} testID={`invite-ask-send-no-${ask.id}`} />
                        <Button label={t('Cancel')} onPress={() => setSaying(false)} disabled={busy} />
                    </View>
                </>
            ) : (
                <View style={styles.actions}>
                    <Button label={t(INVITE_ASK_WORDS.sendInvite)} strong onPress={() => onSend(vouchPreset ?? undefined)} disabled={busy} testID={`invite-ask-invite-${ask.id}`} />
                    <Button label={t(INVITE_ASK_WORDS.say)} onPress={() => setSaying(true)} disabled={busy} testID={`invite-ask-no-${ask.id}`} />
                </View>
            )}
        </View>
    );
}

/** For an owner or admin: the asks waiting, oldest first. The node answers anyone else 403, and there is no section. */
export function InviteAsksToAnswer({ anchorUrl, identity }: { anchorUrl: string; identity: BeanPoolIdentity }) {
    const { colors } = useTheme();
    const styles = useAskStyles();
    const [asks, setAsks] = useState<InviteAskToAnswer[] | null>(null);
    const [myVouching, setMyVouching] = useState<MyVouching | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);

    const load = useCallback(async () => {
        setAsks(await readAsksToAnswer(anchorUrl, identity));
        // A failed read keeps what is shown: askMyVouching's null is "could not read", not "not a voucher".
        askMyVouching(anchorUrl, identity).then((mv) => { if (mv) setMyVouching(mv); }).catch(() => {});
    }, [anchorUrl, identity]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const answer = async (id: string, go: () => ReturnType<typeof sendInviteForAsk>, done: string) => {
        setBusy(id);
        const r = await go();
        setBusy(null);
        setNote(r.ok ? done : null);
        setRefusal(r.ok ? null : r.message ?? t(INVITE_ASK_WORDS.unreachable));
        void load();
    };

    if (busy && !asks) return <ActivityIndicator color={colors.brand.primary} />;
    if (!asks?.length && !note && !refusal) return null;
    return (
        <View testID="invite-asks-to-answer">
            <Text style={[styles.heading, { fontSize: 20, marginTop: 0 }]} accessibilityRole="header">{t(INVITE_ASK_WORDS.toAnswer)}</Text>
            <Text style={styles.help}>{t(INVITE_ASK_WORDS.toAnswerHelp)}</Text>
            {!!note && <Text style={styles.note} accessibilityLiveRegion="polite">{note}</Text>}
            {!!refusal && <Text style={styles.refusal} accessibilityLiveRegion="polite">{refusal}</Text>}
            {asks?.map(ask => (
                <AskCard
                    key={ask.id}
                    ask={ask}
                    busy={busy !== null}
                    myVouching={myVouching}
                    onSend={vouch => void answer(ask.id, () => sendInviteForAsk(anchorUrl, identity, ask.id, vouch), t(INVITE_ASK_WORDS.sent))}
                    onNo={reason => void answer(ask.id, () => sayNoToAsk(anchorUrl, identity, ask.id, reason), t(INVITE_ASK_WORDS.told))}
                />
            ))}
        </View>
    );
}
