/**
 * The sheets of Your shop (app/shop/mine.tsx; DESIGN-shops-and-tools-fable.md §8 and Marty's additions of 19 Oct 2026;
 * slice S4′): one field at a time (its name, what it is, how I deal), its category, Close for now (and when it is back), Close
 * my shop (its Offers kept on their own, or ended), and "Add my live Offers". Each says what will happen before the tap,
 * shows the node's refusal in the node's own words, and with open deals offers the way to them. One column, every target
 * at least 48 dp, colours from the central tokens. Keyboard: lifted by useModalKeyboardLift from the root provider; never
 * a KeyboardProvider here.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHOP_BLURB_LIMIT, SHOP_CATEGORIES, SHOP_HOW_TO_DEAL_LIMIT, SHOP_NAME_LIMIT, t, type ShopCategory } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HOME_TARGET_DP, homeStyles } from '../home/HomeParts';
import { editHomeStyles } from '../home/EditHomeSheet';
import { useModalKeyboardLift } from '../useModalKeyboardLift';
import { backOnChoices, shopCategoryLabel, type BackOnChoice, type ShopListing } from '../../utils/shop';

/** A refusal as a sheet shows it: the node's sentence, and its code (open deals offer the way to them). */
export interface ShopSheetRefusal { message: string; code?: string }

function Sheet({ visible, title, colors, onClose, testID, children }: {
    visible: boolean;
    title: string;
    colors: AppColors;
    onClose: () => void;
    testID: string;
    children: React.ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8);
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24, maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID={testID}>
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{title}</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel={t('Cancel')} testID={`${testID.replace(/-sheet$/, '')}-cancel`}>
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>{t('Cancel')}</Text>
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={editHomeStyles.list} keyboardShouldPersistTaps="handled">{children}</ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** The sheet's one action: at least 48 dp, its words never shrunk; greyed while it can't go. */
function Go({ text, onPress, disabled, colors, testID }: { text: string; onPress: () => void; disabled?: boolean; colors: AppColors; testID: string }) {
    return (
        <Pressable
            onPress={disabled ? undefined : onPress}
            disabled={disabled}
            style={[sheet.go, { backgroundColor: disabled ? colors.surface.subtle : colors.brand.fill }]}
            accessibilityRole="button"
            accessibilityLabel={text}
            accessibilityState={{ disabled: !!disabled }}
            testID={testID}
        >
            <Text style={[sheet.goText, { color: disabled ? colors.text.secondary : colors.text.onBrand }]}>{text}</Text>
        </Pressable>
    );
}

/** The node's refusal under the sheet's action; with open deals, the way to them. */
function Refused({ refusal, colors, testID, onDeals }: { refusal: ShopSheetRefusal | null; colors: AppColors; testID: string; onDeals?: () => void }) {
    const s = homeStyles(colors);
    if (!refusal) return null;
    return (
        <View style={sheet.refused}>
            <Text style={[s.note, { color: colors.feedback.danger.fg }]} testID={`${testID}-error`}>{refusal.message}</Text>
            {refusal.code === 'shop_deals_open' && onDeals ? (
                <Pressable onPress={onDeals} style={s.button} accessibilityRole="button" accessibilityLabel={t('Open your deals')} testID={`${testID}-deals`}>
                    <Text style={s.buttonText}>{t('Open your deals')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

/** One choice of a few: a row with its mark, heard as a radio. */
function Choice({ text, on, onPress, colors, testID }: { text: string; on: boolean; onPress: () => void; colors: AppColors; testID: string }) {
    return (
        <Pressable onPress={onPress} style={[sheet.choice, { borderColor: on ? colors.brand.primary : colors.border.default }]}
            accessibilityRole="radio" accessibilityState={{ checked: on, selected: on }} accessibilityLabel={text} testID={testID}>
            <View style={[sheet.dot, { borderColor: on ? colors.brand.primary : colors.border.strong }]}>
                {on ? <View style={[sheet.dotOn, { backgroundColor: colors.brand.primary }]} /> : null}
            </View>
            <Text style={[sheet.choiceText, { color: colors.text.body }]}>{text}</Text>
        </Pressable>
    );
}

// ── one field ────────────────────────────────────────────────────────────────────────────────────

export type ShopTextField = 'name' | 'blurb' | 'howToDeal';

/** Each field's words and bound (core text-limits.ts, the node's own). */
function fieldWords(field: ShopTextField, defaultName: string): { title: string; note: string; limit: number; multiline: boolean } {
    if (field === 'name') return { title: t("Your shop's name"), note: t('Leave it empty and it is called "{name}".', { name: defaultName }), limit: SHOP_NAME_LIMIT.chars, multiline: false };
    if (field === 'blurb') return { title: t('About your shop'), note: t('What it is, in a few words.'), limit: SHOP_BLURB_LIMIT.chars, multiline: true };
    return { title: t('How I deal'), note: t('Where to pick up, and when things come back.'), limit: SHOP_HOW_TO_DEAL_LIMIT.chars, multiline: true };
}

export function ShopTextSheet({ field, value, defaultName, busy, refusal, colors, onSave, onClose }: {
    /** The field being written, or null when the sheet is closed. */
    field: ShopTextField | null;
    value: string;
    /** "<their name>'s shop": what an empty name is called. */
    defaultName: string;
    busy: boolean;
    refusal: ShopSheetRefusal | null;
    colors: AppColors;
    /** The words as typed, or null to clear the field. */
    onSave: (text: string | null) => void;
    onClose: () => void;
}) {
    const s = homeStyles(colors);
    const [text, setText] = useState(value);
    useEffect(() => { if (field) setText(value); }, [field, value]);
    const w = fieldWords(field ?? 'name', defaultName);
    return (
        <Sheet visible={!!field} title={w.title} colors={colors} onClose={onClose} testID="shop-text-sheet">
            <TextInput
                value={text}
                onChangeText={setText}
                maxLength={w.limit}
                multiline={w.multiline}
                textAlignVertical={w.multiline ? 'top' : 'center'}
                style={[sheet.input, w.multiline && sheet.inputTall, { color: colors.text.body, borderColor: colors.border.strong, backgroundColor: colors.surface.app }]}
                accessibilityLabel={w.title}
                testID="shop-text-input"
            />
            <Text style={[s.note, { marginTop: 8 }]}>{w.note}</Text>
            <Go text={busy ? t('Saving…') : t('Save')} onPress={() => onSave(text.trim() ? text.trim() : null)} disabled={busy} colors={colors} testID="shop-text-save" />
            <Refused refusal={refusal} colors={colors} testID="shop-text" />
        </Sheet>
    );
}

// ── its category ─────────────────────────────────────────────────────────────────────────────────

/** The Market's categories (core SHOP_CATEGORIES), each with the emoji and words its listings show, and None. */
export function ShopCategorySheet({ visible, category, busy, refusal, colors, onPick, onClose }: {
    visible: boolean;
    category: ShopCategory | null;
    busy: boolean;
    refusal: ShopSheetRefusal | null;
    colors: AppColors;
    onPick: (category: ShopCategory | null) => void;
    onClose: () => void;
}) {
    const s = homeStyles(colors);
    const pick = (c: ShopCategory | null) => { if (!busy) onPick(c); };
    const chip = (id: string, label: string, on: boolean, value: ShopCategory | null) => (
        <Pressable key={id} onPress={() => pick(value)} style={[s.chip, on && s.chipOn]} accessibilityRole="radio"
            accessibilityState={{ selected: on, checked: on }} accessibilityLabel={label} testID={`shop-category-pick-${id}`}>
            <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
        </Pressable>
    );
    return (
        <Sheet visible={visible} title={t('Category')} colors={colors} onClose={onClose} testID="shop-category-sheet">
            <Text style={s.note}>{t('It helps neighbours find you, and picks the tools shown. It changes nothing else.')}</Text>
            <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={t('Category')}>
                {SHOP_CATEGORIES.map((c) => chip(c, shopCategoryLabel(c), category === c, c))}
                {chip('none', t('None'), category === null, null)}
            </View>
            <Refused refusal={refusal} colors={colors} testID="shop-category" />
        </Sheet>
    );
}

// ── close for now ────────────────────────────────────────────────────────────────────────────────

export function ShopPauseSheet({ visible, busy, refusal, colors, onPause, onClose, onDeals }: {
    visible: boolean;
    busy: boolean;
    refusal: ShopSheetRefusal | null;
    colors: AppColors;
    /** The day it says it is back (YYYY-MM-DD), or null for none said. */
    onPause: (backOn: string | null) => void;
    onClose: () => void;
    onDeals: () => void;
}) {
    const s = homeStyles(colors);
    const [back, setBack] = useState<BackOnChoice>('none');
    useEffect(() => { if (visible) setBack('none'); }, [visible]);
    const choices = backOnChoices(new Date());
    return (
        <Sheet visible={visible} title={t('Close for now')} colors={colors} onClose={onClose} testID="shop-pause-sheet">
            <Text style={s.note}>{t('Its Offers come off the Market and wait. Nothing goes in while it is closed. One tap reopens it.')}</Text>
            <Text style={[sheet.label, { color: colors.text.body }]}>{t('Say when you are back')}</Text>
            <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={t('Say when you are back')}>
                {choices.map((c) => {
                    const on = back === c.id;
                    return (
                        <Pressable key={c.id} onPress={() => setBack(c.id)} style={[s.chip, on && s.chipOn]} accessibilityRole="radio"
                            accessibilityState={{ selected: on, checked: on }} accessibilityLabel={c.label} testID={`shop-back-${c.id}`}>
                            <Text style={[s.chipText, on && s.chipTextOn]}>{c.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
            <Go text={t('Close for now')} onPress={() => onPause(choices.find((c) => c.id === back)?.day ?? null)} disabled={busy} colors={colors} testID="shop-pause-go" />
            <Refused refusal={refusal} colors={colors} testID="shop-pause" onDeals={onDeals} />
        </Sheet>
    );
}

// ── close my shop ────────────────────────────────────────────────────────────────────────────────

export function ShopCloseSheet({ visible, busy, refusal, colors, onCloseShop, onClose, onDeals }: {
    visible: boolean;
    busy: boolean;
    refusal: ShopSheetRefusal | null;
    colors: AppColors;
    onCloseShop: (endOffers: boolean) => void;
    onClose: () => void;
    onDeals: () => void;
}) {
    const s = homeStyles(colors);
    const [end, setEnd] = useState(false);
    useEffect(() => { if (visible) setEnd(false); }, [visible]);
    return (
        <Sheet visible={visible} title={t('Close my shop')} colors={colors} onClose={onClose} testID="shop-close-sheet">
            <Text style={s.note}>{t('Your shop goes. You can open a new one any time.')}</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel={t('Its Offers')}>
                <Choice text={t('Keep its Offers in the Market, on their own')} on={!end} onPress={() => setEnd(false)} colors={colors} testID="shop-close-keep" />
                <Choice text={t('End its Offers too')} on={end} onPress={() => setEnd(true)} colors={colors} testID="shop-close-end" />
            </View>
            <Text style={[s.note, { marginTop: 8 }]}>{t('Your private tool lists stay on this phone.')}</Text>
            <Go text={t('Close my shop')} onPress={() => onCloseShop(end)} disabled={busy} colors={colors} testID="shop-close-go" />
            <Refused refusal={refusal} colors={colors} testID="shop-close" onDeals={onDeals} />
        </Sheet>
    );
}

// ── add my live Offers ───────────────────────────────────────────────────────────────────────────

export function ShopAddOffersSheet({ visible, offers, busy, refusal, colors, onAdd, onClose }: {
    visible: boolean;
    /** The member's Offers that can go in (utils/shop.ts offersToAdd); undefined while read, null when they couldn't be. */
    offers: ShopListing[] | null | undefined;
    busy: boolean;
    refusal: ShopSheetRefusal | null;
    colors: AppColors;
    onAdd: (postIds: string[]) => void;
    onClose: () => void;
}) {
    const s = homeStyles(colors);
    const [picked, setPicked] = useState<string[]>([]);
    useEffect(() => { if (visible) setPicked([]); }, [visible]);
    const flip = (id: string) => setPicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]));
    return (
        <Sheet visible={visible} title={t('Add my live Offers')} colors={colors} onClose={onClose} testID="shop-add-sheet">
            {offers === undefined ? <Text style={s.note}>{t('Reading your Offers…')}</Text> : null}
            {offers === null ? <Text style={s.note} testID="shop-add-unread">{t("Your Offers couldn't be read just now. Try again.")}</Text> : null}
            {offers && offers.length === 0 ? <Text style={s.note} testID="shop-add-empty">{t('Every live Offer of yours for everyone here is in your shop already.')}</Text> : null}
            {offers && offers.length > 0 ? (
                <>
                    <Text style={s.note}>{t('Tick the Offers to put in your shop. Only Offers for everyone here can go in.')}</Text>
                    {offers.map((o) => {
                        const on = picked.includes(o.id);
                        return (
                            <Pressable key={o.id} onPress={() => flip(o.id)} style={[sheet.pick, { borderBottomColor: colors.border.default }]}
                                accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={o.title} testID={`shop-add-${o.id}`}>
                                <View style={[sheet.box, { borderColor: on ? colors.brand.primary : colors.border.strong, backgroundColor: on ? colors.brand.fill : colors.surface.card }]}>
                                    {on ? <Text style={[sheet.tick, { color: colors.text.onBrand }]} importantForAccessibility="no">✓</Text> : null}
                                </View>
                                <Text style={[sheet.pickText, { color: colors.text.body }]} numberOfLines={2}>{o.title}</Text>
                            </Pressable>
                        );
                    })}
                </>
            ) : null}
            <Go text={t('Put them in my shop')} onPress={() => onAdd(picked)} disabled={busy || picked.length === 0} colors={colors} testID="shop-add-go" />
            <Refused refusal={refusal} colors={colors} testID="shop-add" />
        </Sheet>
    );
}

const sheet = StyleSheet.create({
    label: { fontSize: 14, fontWeight: '700', marginTop: 12, marginBottom: 6 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
    inputTall: { minHeight: 110 },
    go: { marginTop: 16, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10 },
    goText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
    refused: { marginTop: 10 },
    choice: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, padding: 12, gap: 12, marginTop: 8 },
    dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    dotOn: { width: 10, height: 10, borderRadius: 5 },
    choiceText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20 },
    pick: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP, paddingVertical: 8, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    tick: { fontSize: 15, fontWeight: '800' },
    pickText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20 },
});
