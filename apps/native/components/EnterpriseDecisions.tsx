/**
 * The "Decisions" block on an enterprise's or project's screen (DESIGN-group-decisions §4 row S2): its keepers' votes, each
 * card with its two tally states (turnout while open, Yes and No once closed), Yes / No for a keeper who hasn't voted,
 * and the propose form. The words and the form's checks are @beanpool/core scoped-decision.ts, shared with the PWA.
 *
 * Shown only to those the node answers (its keepers, and those on a vote's roll): anyone else gets a 404, and the block
 * draws nothing. A roll of one holds no vote, so then there is no propose button (canPropose).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    beansHeld, checkPayOutAmount, payOutFeeWords, rollChoices, scopedClosesWords, scopedEffectLabel, scopedEffectsFor, scopedEffectWords,
    scopedOutcomeWords, scopedTallyWords, SMALL_ROLL_BALLOT_NOTE, wageNoteWords,
    type RollPerson, type ScopedDecisionCard, type ScopedDecisionList, type ScopedEffect,
} from '@beanpool/core';
import { getEnterpriseDecisions, proposeEnterpriseDecision, voteEnterpriseDecision } from '../utils/db';
import { useTheme } from '../app/ThemeContext';
import { useModalKeyboardLift } from './useModalKeyboardLift';

export interface EnterpriseDecisionsProps {
    treasuryKey: string;
    myPubkey: string | null;
    /** The enterprise's keepers as its detail lists them; suspended ones are off the roll. */
    keepers: Array<{ publicKey: string; callsign?: string; role?: string; suspended?: boolean }>;
    /** What it holds now, in Beans. */
    balance: number;
    /** What it has earned above its costs (the detail's earnedSurplus): the most it can pay a keeper. Null when not known. */
    earnedSurplus?: number | null;
    lifecycle?: string | null;
    /** Bumped by the screen on focus or a pull, to read again. */
    refreshKey?: number;
}

export function EnterpriseDecisions({ treasuryKey, myPubkey, keepers, balance, earnedSurplus, lifecycle, refreshKey }: EnterpriseDecisionsProps) {
    const { colors } = useTheme();
    const [list, setList] = useState<ScopedDecisionList | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [proposing, setProposing] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async () => {
        const answer = await getEnterpriseDecisions(treasuryKey);
        setList(answer);
        setNow(Date.now());
    }, [treasuryKey]);
    useEffect(() => { void load(); }, [load, refreshKey]);

    const roll: RollPerson[] = useMemo(() => keepers.filter(k => !k.suspended)
        .map(k => ({ pubkey: k.publicKey, name: k.callsign || 'A keeper', role: k.role })), [keepers]);
    const nameOf = useCallback((pk: string) => keepers.find(k => k.publicKey === pk)?.callsign || (pk === treasuryKey ? 'this enterprise' : 'a member'), [keepers, treasuryKey]);

    if (!list) return null;
    const open = list.decisions.filter(d => d.status === 'open');
    const closed = list.decisions.filter(d => d.status !== 'open');
    if (list.decisions.length === 0 && !list.canPropose) return null;

    const vote = async (d: ScopedDecisionCard, support: boolean) => {
        setBusyId(d.id);
        try {
            await voteEnterpriseDecision(treasuryKey, d.id, support);
            await load();
        } catch (e: any) {
            Alert.alert('Your vote was not counted', e?.message || 'Try again in a moment.');
        } finally {
            setBusyId(null);
        }
    };

    const s = styles(colors);
    return (
        <View style={s.card} accessibilityLabel="Decisions">
            <Text style={s.label} accessibilityRole="header">DECISIONS</Text>
            <Text style={s.note}>Votes among this {lifecycle === 'bounded' ? "project's leader and collaborators" : "enterprise's keepers"}. More than half must vote. 7 days, or sooner once the answer can't change.</Text>
            {[...open, ...closed.slice(0, 5)].map(d => {
                const mine = d.myVote ? (d.myVote.support === true || d.myVote.support === 1 ? 'Yes' : 'No') : null;
                const isOpen = d.status === 'open';
                return (
                    <View key={d.id} style={s.decision}>
                        <Text style={s.title}>{d.title}</Text>
                        <Text style={s.effect}>{scopedEffectWords(d, nameOf, lifecycle)}</Text>
                        {!!d.description && <Text style={s.why}>{d.description}</Text>}
                        <Text style={s.meta}>Proposed by {nameOf(d.authorPubkey)} · {isOpen ? scopedClosesWords(d.closesAt, now) : scopedOutcomeWords(d)}</Text>
                        <Text style={s.tally}>{scopedTallyWords(d)}</Text>
                        {mine && <Text style={s.meta}>You voted {mine}.</Text>}
                        {isOpen && !mine && (
                            <View style={s.voteRow}>
                                <Pressable
                                    style={[s.voteBtn, { backgroundColor: colors.brand.primary }, busyId === d.id && { opacity: 0.5 }]}
                                    disabled={busyId === d.id} onPress={() => vote(d, true)}
                                    accessibilityRole="button" accessibilityLabel={`Vote Yes on ${d.title}`}
                                >
                                    <Text style={s.voteYesText}>Yes</Text>
                                </Pressable>
                                <Pressable
                                    style={[s.voteBtn, s.voteNo, busyId === d.id && { opacity: 0.5 }]}
                                    disabled={busyId === d.id} onPress={() => vote(d, false)}
                                    accessibilityRole="button" accessibilityLabel={`Vote No on ${d.title}`}
                                >
                                    <Text style={s.voteNoText}>No</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                );
            })}
            {list.decisions.length > 0 && list.rollSize <= 4 && <Text style={s.small}>{SMALL_ROLL_BALLOT_NOTE}</Text>}
            {list.canPropose && (
                <Pressable style={s.proposeBtn} onPress={() => setProposing(true)} accessibilityRole="button">
                    <Text style={s.proposeText}>Propose a vote</Text>
                </Pressable>
            )}
            {proposing && myPubkey && (
                <ProposeScopedDecision
                    treasuryKey={treasuryKey} me={myPubkey} roll={roll} balance={balance} earnedSurplus={earnedSurplus} lifecycle={lifecycle}
                    onClose={() => setProposing(false)} onDone={() => { setProposing(false); void load(); }}
                />
            )}
        </View>
    );
}

/** The propose form: the three effects (two in a project), the person from the roll, and for a pay-out the amount and its fee. */
function ProposeScopedDecision({ treasuryKey, me, roll, balance, earnedSurplus, lifecycle, onClose, onDone }: {
    treasuryKey: string; me: string; roll: RollPerson[]; balance: number; earnedSurplus?: number | null; lifecycle?: string | null;
    onClose: () => void; onDone: () => void;
}) {
    const { colors } = useTheme();
    const s = styles(colors);
    // Lifted by the keyboard's height, never a KeyboardAvoidingView inside this Modal: see components/useModalKeyboardLift.
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8, 0.92);
    const effects = scopedEffectsFor(lifecycle);
    const [effect, setEffect] = useState<ScopedEffect>('pay_out');
    const [who, setWho] = useState<string | null>(null);
    const [amountText, setAmountText] = useState('');
    const [title, setTitle] = useState('');
    const [why, setWhy] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const choices = rollChoices(effect, roll, me);
    const person = choices.find(p => p.pubkey === who) ?? null;
    // Everyone the form offers is a keeper on the roll, so every pay-out is a wage: capped at the earned surplus too.
    const wageSurplus = typeof earnedSurplus === 'number' && Number.isFinite(earnedSurplus) ? earnedSurplus : null;
    const amount = effect === 'pay_out' ? checkPayOutAmount(amountText, balance, wageSurplus) : null;
    const amountError = amount && 'error' in amount && amountText.trim() ? amount.error : null;
    const ready = !!person && title.trim().length > 0 && why.trim().length >= 10 && (effect !== 'pay_out' || (!!amount && 'amount' in amount));

    const send = async () => {
        if (!ready || !person) return;
        setBusy(true);
        setError(null);
        try {
            await proposeEnterpriseDecision(treasuryKey, effect === 'pay_out' && amount && 'amount' in amount
                ? { title: title.trim(), description: why.trim(), effect, params: { to: person.pubkey, amount: amount.amount } }
                : { title: title.trim(), description: why.trim(), effect, subject: person.pubkey });
            onDone();
        } catch (e: any) {
            setError(e?.message || 'The vote was not opened. Try again in a moment.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal visible transparent animationType="slide" onRequestClose={onClose}>
            <View style={[s.backdrop, { paddingTop: insets.top + 8 }]}>
                <View style={[s.sheet, { maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID="propose-scoped-sheet">
                    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
                        <Text style={s.sheetTitle} accessibilityRole="header">Propose a vote</Text>
                        <Text style={s.note}>Everyone on the roll votes. It runs 7 days, or ends sooner once the answer can't change.</Text>
                        <Text style={s.fieldLabel}>What should happen?</Text>
                        <View style={s.chips}>
                            {effects.map(e => (
                                <Pressable key={e} onPress={() => { setEffect(e); setWho(null); }}
                                    style={[s.chip, effect === e && s.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: effect === e }}>
                                    <Text style={[s.chipText, effect === e && s.chipTextOn]}>{scopedEffectLabel(e, lifecycle)}</Text>
                                </Pressable>
                            ))}
                        </View>
                        <Text style={s.fieldLabel}>{effect === 'pay_out' ? 'Pay whom?' : effect === 'remove_keeper' ? 'Remove whom?' : 'Who should lead?'}</Text>
                        {choices.length === 0
                            ? <Text style={s.note}>Nobody on the roll can be chosen for this.</Text>
                            : (
                                <View style={s.chips}>
                                    {choices.map(p => (
                                        <Pressable key={p.pubkey} onPress={() => setWho(p.pubkey)}
                                            style={[s.chip, who === p.pubkey && s.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: who === p.pubkey }}>
                                            <Text style={[s.chipText, who === p.pubkey && s.chipTextOn]}>{p.name}{p.pubkey === me ? ' (you)' : ''}</Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                        {effect === 'pay_out' && (
                            <>
                                <Text style={s.fieldLabel}>How many Beans?</Text>
                                <TextInput
                                    value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" placeholder="40"
                                    placeholderTextColor={colors.text.muted} style={s.input} accessibilityLabel="Amount in Beans"
                                />
                                <Text style={s.note}>It holds {beansHeld(balance)} Beans now.</Text>
                                {amountError && <Text style={s.error}>{amountError}</Text>}
                                {amount && 'amount' in amount && person && <Text style={s.fee}>{payOutFeeWords(amount.amount, person.name)}</Text>}
                                <Text style={s.note}>{wageNoteWords(wageSurplus, lifecycle)}</Text>
                            </>
                        )}
                        <Text style={s.fieldLabel}>Title</Text>
                        <TextInput value={title} onChangeText={setTitle} style={s.input} maxLength={120} placeholder="Pay Ali for the stall repairs"
                            placeholderTextColor={colors.text.muted} accessibilityLabel="Title" />
                        <Text style={s.fieldLabel}>Why?</Text>
                        <TextInput value={why} onChangeText={setWhy} style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]} multiline
                            placeholder="Say why, in a sentence or two." placeholderTextColor={colors.text.muted} accessibilityLabel="Why" />
                        {error && <Text style={s.error}>{error}</Text>}
                        <View style={s.voteRow}>
                            <Pressable style={[s.voteBtn, { backgroundColor: colors.brand.primary }, (!ready || busy) && { opacity: 0.5 }]}
                                disabled={!ready || busy} onPress={send} accessibilityRole="button" accessibilityState={{ disabled: !ready || busy, busy }}>
                                {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={s.voteYesText}>Open the vote</Text>}
                            </Pressable>
                            <Pressable style={[s.voteBtn, s.voteNo]} onPress={onClose} accessibilityRole="button">
                                <Text style={s.voteNoText}>Cancel</Text>
                            </Pressable>
                        </View>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

const styles = (colors: any) => StyleSheet.create({
    card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 14, marginTop: 12 },
    label: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, color: colors.text.secondary, marginBottom: 4 },
    note: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 6 },
    small: { fontSize: 12, color: colors.text.muted, lineHeight: 16, marginTop: 4 },
    decision: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 10, marginTop: 8 },
    title: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
    effect: { fontSize: 14, color: colors.text.body, marginTop: 2 },
    why: { fontSize: 14, color: colors.text.secondary, marginTop: 4, lineHeight: 19 },
    meta: { fontSize: 12, color: colors.text.secondary, marginTop: 4 },
    tally: { fontSize: 13, color: colors.text.body, marginTop: 4, fontWeight: '600' },
    voteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    voteBtn: { flexGrow: 1, minWidth: 96, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    voteNo: { borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.subtle },
    voteYesText: { color: colors.text.inverse, fontWeight: '700', fontSize: 15 },
    voteNoText: { color: colors.text.heading, fontWeight: '700', fontSize: 15 },
    proposeBtn: { marginTop: 12, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    proposeText: { color: colors.brand.primary, fontWeight: '700', fontSize: 15 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    // maxHeight comes from useModalKeyboardLift: 92% of the screen, or what is left above the keyboard.
    sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, flexShrink: 1 },
    sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
    fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.text.heading, marginTop: 10, marginBottom: 6 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { borderWidth: 1, borderColor: colors.border.default, borderRadius: 18, paddingHorizontal: 12, minHeight: 40, justifyContent: 'center', maxWidth: '100%' },
    chipOn: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
    chipText: { color: colors.text.body, fontSize: 14 },
    chipTextOn: { color: colors.text.inverse, fontWeight: '700' },
    input: { borderWidth: 1, borderColor: colors.border.default, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: colors.text.body, fontSize: 15, backgroundColor: colors.surface.subtle },
    fee: { fontSize: 13, color: colors.text.body, marginBottom: 6, lineHeight: 18 },
    error: { fontSize: 13, color: colors.feedback.danger.fg, marginBottom: 6 },
});
