/**
 * The List sheet (scratch/tools/DESIGN-tool-template-fable.md §1.5; round 1 §2.2 generalised; slice T0.2): what a tool's
 * `offerDoor` opens. It asks only what a listing needs that the tool can't know (the fee: Free · Beans per day · Beans
 * per week · a fixed number of Beans, hidden where Beans are off, which lists at 0), says what will happen ("It shows in
 * the Market as an Offer"), and hands the draft to the map's own composer, where the member checks it and taps Post.
 *
 * Never a false success: nothing is posted here, so nothing is said to be. What would stop the post is said before the
 * member goes on (the community asks for a profile photo first; an unfinished post on the map would be replaced), and the
 * node's own refusals (probation, the day limit) are the composer's, in the node's words. "Put this in your shop" joins
 * the sheet with slice S1. Keyboard: lifted by useModalKeyboardLift from the root provider; never a KeyboardProvider here.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, TextInput, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, type ToolOfferDraft } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { HOME_TARGET_DP, homeStyles } from '../components/home/HomeParts';
import { editHomeStyles } from '../components/home/EditHomeSheet';
import { useModalKeyboardLift } from '../components/useModalKeyboardLift';
import type { ToolListFee } from './doors';

/** The fee choices, in the order shown. */
export const TOOL_FEE_KINDS: ReadonlyArray<ToolListFee['kind']> = ['free', 'daily', 'weekly', 'fixed'];

/** The most Beans the composer takes (its price box holds five digits). */
const MAX_BEANS = 99_999;

/** The fee a tool's draft starts the sheet on: its own credits and price type when it set them, else Free. */
export function startingFee(draft: ToolOfferDraft): ToolListFee {
    const beans = Math.max(0, Math.min(MAX_BEANS, Math.floor(Number(draft.credits) || 0)));
    if (beans === 0) return { kind: 'free', beans: 0 };
    const kind = draft.priceType === 'daily' || draft.priceType === 'weekly' ? draft.priceType : 'fixed';
    return { kind, beans };
}

/** Whether the member can go on: free, or a fee with a number of Beans. */
export const feeReady = (fee: ToolListFee) => fee.kind === 'free' || fee.beans > 0;

export function ToolListSheet({ draft, beans, needsProfilePhoto, unfinishedPost, colors, onList, onClose }: {
    /** The tool's draft, or null when the sheet is closed. */
    draft: ToolOfferDraft | null;
    /** Beans are on in this community: the fee shows. Off: the listing is at 0 and the fee isn't asked. */
    beans: boolean;
    /** The community asks for a profile photo before posting, and the member has none yet. */
    needsProfilePhoto: boolean;
    /** The member has an unfinished post on the map that going on would replace. */
    unfinishedPost: boolean;
    colors: AppColors;
    onList: (fee: ToolListFee) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8);
    const s = homeStyles(colors);
    const [fee, setFee] = useState<ToolListFee>({ kind: 'free', beans: 0 });
    useEffect(() => { if (draft) setFee(beans ? startingFee(draft) : { kind: 'free', beans: 0 }); }, [draft, beans]);
    const ready = !needsProfilePhoto && (!beans || feeReady(fee));
    const feeWords: Record<ToolListFee['kind'], string> = {
        free: t('Free'), daily: t('Beans per day'), weekly: t('Beans per week'), fixed: t('A fixed number of Beans'),
    };
    return (
        <Modal visible={!!draft} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24, maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID="tool-list-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{t('List it in the Market')}</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel={t('Cancel')} testID="tool-list-cancel">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>{t('Cancel')}</Text>
                        </Pressable>
                    </View>
                    <ScrollView style={editHomeStyles.list} keyboardShouldPersistTaps="handled">
                        {/* What the member wrote, as written. */}
                        <Text style={[s.rowLine, s.rowStrong]} numberOfLines={2} testID="tool-list-title">{draft?.title ?? ''}</Text>
                        {beans ? (
                            <View accessibilityRole="radiogroup" accessibilityLabel={t('Fee')} testID="tool-list-fee">
                                <Text style={[list.label, { color: colors.text.body }]}>{t('Fee')}</Text>
                                <View style={s.chips}>
                                    {TOOL_FEE_KINDS.map((kind) => {
                                        const on = fee.kind === kind;
                                        return (
                                            <Pressable key={kind} onPress={() => setFee({ kind, beans: kind === 'free' ? 0 : fee.beans })} style={[s.chip, on && s.chipOn]}
                                                accessibilityRole="radio" accessibilityState={{ selected: on, checked: on }} accessibilityLabel={feeWords[kind]} testID={`tool-list-fee-${kind}`}>
                                                <Text style={[s.chipText, on && s.chipTextOn]}>{feeWords[kind]}</Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                                {fee.kind !== 'free' ? (
                                    <>
                                        <Text style={[list.label, { color: colors.text.body }]} nativeID="tool-list-beans-label">{t('How many Beans')}</Text>
                                        <TextInput
                                            value={fee.beans ? String(fee.beans) : ''}
                                            onChangeText={(v) => setFee({ ...fee, beans: Math.min(MAX_BEANS, Math.max(0, Math.floor(Number(v.replace(/[^0-9]/g, '')) || 0))) })}
                                            keyboardType="number-pad"
                                            maxLength={5}
                                            placeholder="0"
                                            placeholderTextColor={colors.text.muted}
                                            style={[list.input, { color: colors.text.body, borderColor: colors.border.strong, backgroundColor: colors.surface.app }]}
                                            accessibilityLabel={t('How many Beans')}
                                            accessibilityLabelledBy="tool-list-beans-label"
                                            testID="tool-list-beans"
                                        />
                                    </>
                                ) : null}
                            </View>
                        ) : null}
                        <Text style={[s.note, { marginTop: 12 }]}>{t('It shows in the Market as an Offer.')}</Text>
                        <Text style={s.note}>{t('Next you check it and tap Post. Nothing is posted before that.')}</Text>
                        {unfinishedPost ? (
                            <Text style={[s.note, { color: colors.feedback.warning.fg }]} testID="tool-list-replaces">{t('You have an unfinished post on the map. Going on replaces it.')}</Text>
                        ) : null}
                        {needsProfilePhoto ? (
                            <View testID="tool-list-photo">
                                <Text style={[s.note, { color: colors.feedback.warning.fg }]}>{t('Your community asks for a profile photo before you post.')}</Text>
                                <Pressable onPress={() => { onClose(); router.push('/profile-setup'); }} style={s.button} accessibilityRole="button" accessibilityLabel={t('Set up profile')} testID="tool-list-profile">
                                    <Text style={s.buttonText}>{t('Set up profile')}</Text>
                                </Pressable>
                            </View>
                        ) : null}
                        <Pressable
                            disabled={!ready}
                            onPress={() => onList(beans ? fee : { kind: 'free', beans: 0 })}
                            style={[list.button, { backgroundColor: ready ? colors.brand.fill : colors.surface.subtle }]}
                            accessibilityRole="button"
                            accessibilityLabel={t('Go on to post')}
                            accessibilityState={{ disabled: !ready }}
                            testID="tool-list-go"
                        >
                            <Text style={[list.buttonText, { color: ready ? colors.text.onBrand : colors.text.secondary }]}>{t('Go on to post')}</Text>
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

const list = StyleSheet.create({
    label: { fontSize: 14, fontWeight: '700', marginTop: 12, marginBottom: 6 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
    button: { marginTop: 16, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    buttonText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
