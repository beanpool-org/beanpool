import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    HOME_DECIDE_CHOICES, HOME_SEARCH_KMS, HOME_SEARCH_MAX_CHARS, readDecideSettings, readSearchSettings, readSkySettings, searchFromSheet, t,
    type HomeDecideShow, type HomeSearchKind, type SkySettings,
} from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { SEARCH_KIND_CHIPS, SKY_PLACE_CHIPS, cardName, timeAgoInWords } from '../../utils/home-cards';
import { CHAT_CARD_WORDS, CHAT_PICK_FILTER_AFTER, chatSettingsOf, filterChatChoices, type ChatChoice } from '../../utils/home-chat';
import { POST_CATEGORIES, categoryLabel } from '../../constants/categories';
import { HOME_TARGET_DP, homeStyles } from './HomeParts';
import { sheetStyles } from './sheet-parts';
import { chatCardStyles } from './chat-parts';
import { useModalKeyboardLift } from '../useModalKeyboardLift';
import { useScrollFieldIntoView } from '../useScrollFieldIntoView';

/**
 * A card's settings sheet (CARD-FRAME §1.2, §1.3): the picker opens it on Add for a type with settings (its last button
 * is Add to Home), and the card's "…" → Settings… opens it again with Save, keeping the card where it is. Sun and moon
 * asks one thing: whose place, the community's or the member's own. Decide asks one too: what it shows (a summary, every open
 * Decision, or only the votes that are the member's), with a line under the chosen one. The saved search (CARD-FRAME §4)
 * asks its words, then Offers or Needs or both, a category, and a distance. The
 * distance chips show only where the node has a point to measure from (the member's area, or the phone's place on the
 * global community); without one the node ignores the distance, so the sheet doesn't offer it, and a kept one stays.
 *
 * A chat card (DESIGN-home-chosen-chat-fable.md §2) asks one thing: which chat. The member's chats are read once as the
 * sheet opens (the screen hands them in: groups then people, never a request waiting); a filter box shows past 8 rows; a
 * chat another chat card holds says "On Home" and can't be picked again. The choice is stored as its id, kind and name.
 *
 * Keyboard: lifted by useModalKeyboardLift from the root provider's state, as Create a Group and Invite people are (the
 * Modal's window doesn't shrink for the keyboard, which at 320 dp covered this whole sheet: review of #1699, finding 3).
 * Never a nested KeyboardProvider inside the Modal.
 */
export function CardSettingsSheet({ visible, type, settings, mode, hasPoint = false, chats, colors, onDone, onClose }: {
    visible: boolean;
    type: string | null;
    /** The card's settings now (Settings…), or none (a new card). */
    settings?: Record<string, unknown>;
    /** `add`: from the picker, the button says Add to Home. `save`: from the card's "…". */
    mode: 'add' | 'save';
    /** The node has a point to measure a distance from: the distance chips show. */
    hasPoint?: boolean;
    /** A chat card's list: the member's chats (null while they are read), whether the read failed, and the chats on Home. */
    chats?: { rows: ChatChoice[] | null; failed: boolean; onHome: ReadonlySet<string> };
    colors: AppColors;
    onDone: (settings: Record<string, unknown>) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8);
    const fieldScroll = useScrollFieldIntoView();
    const [q, setQ] = useState('');
    const [kind, setKind] = useState<HomeSearchKind>('any');
    const [category, setCategory] = useState<string | null>(null);
    const [km, setKm] = useState<number | null>(null);
    const [place, setPlace] = useState<SkySettings['place']>('community');
    const [show, setShow] = useState<HomeDecideShow>('counts');
    const [chatId, setChatId] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    useEffect(() => {
        if (!visible) return;
        setChatId(typeof settings?.conversationId === 'string' ? settings.conversationId : null);
        setFilter('');
        setPlace(readSkySettings(settings).place);
        setShow(readDecideSettings(settings).show);
        const start = readSearchSettings(settings);
        setQ(start.q);
        setKind(start.kind);
        setCategory(start.category ?? null);
        setKm(start.km ?? null);
    }, [visible, settings]);
    if (!type) return null;
    const name = cardName(type);
    const sky = type === 'sky';
    const decide = type === 'decide';
    const chat = type === 'chat';
    const words = q.trim();
    const chosen = chat ? (chats?.rows ?? []).find(r => r.conversationId === chatId && !chats?.onHome.has(r.conversationId)) ?? null : null;
    const ready = sky || decide || (chat ? !!chosen : !!words);
    const done = () => {
        if (chat) { if (chosen) onDone(chatSettingsOf(chosen)); return; }
        onDone(sky ? { place } : decide ? { show } : searchFromSheet(settings, { q: words, kind, category, km }));
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={sheetStyles.backdrop}>
                <View style={[sheetStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24, maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID="card-settings-sheet">
                    <View style={sheetStyles.head}>
                        <Text style={[sheetStyles.title, { color: colors.text.heading }]} accessibilityRole="header">{name}</Text>
                        <Pressable onPress={onClose} style={sheetStyles.done} accessibilityRole="button" accessibilityLabel={t('Cancel')} testID="card-settings-cancel">
                            <Text style={[sheetStyles.doneText, { color: colors.text.link }]}>{t('Cancel')}</Text>
                        </Pressable>
                    </View>
                    <ScrollView style={sheetStyles.list} {...fieldScroll.scrollProps} keyboardShouldPersistTaps="handled" testID="card-settings-scroll">
                        {chat ? (
                            <ChatPickList chats={chats} chosen={chatId} filter={filter} onFilter={setFilter} onChoose={setChatId} colors={colors} inputProps={fieldScroll.inputProps} />
                        ) : sky ? (
                            <SettingChips label={t('Whose place')} id="place" colors={colors} value={place} onPick={setPlace}
                                options={SKY_PLACE_CHIPS.map(p => ({ value: p.place, label: t(p.label) }))} />
                        ) : decide ? (<>
                            <SettingChips label={t('Show')} id="show" colors={colors} value={show} onPick={setShow}
                                options={HOME_DECIDE_CHOICES.map(c => ({ value: c.show, label: t(c.label) }))} />
                            <Text style={[settingsStyles.note, { color: colors.text.secondary }]} testID="card-settings-show-note">
                                {t(HOME_DECIDE_CHOICES.find(c => c.show === show)!.note)}
                            </Text>
                        </>) : (<>
                            <Text style={[settingsStyles.label, { color: colors.text.body }]} nativeID="card-settings-words-label">{t('Words to look for')}</Text>
                            <TextInput
                                {...fieldScroll.inputProps}
                                value={q}
                                onChangeText={setQ}
                                maxLength={HOME_SEARCH_MAX_CHARS}
                                placeholder={t('eggs', undefined, 'an example of words to look for')}
                                placeholderTextColor={colors.text.muted}
                                style={[settingsStyles.input, { color: colors.text.body, borderColor: colors.border.strong, backgroundColor: colors.surface.app }]}
                                accessibilityLabel={t('Words to look for')}
                                accessibilityLabelledBy="card-settings-words-label"
                                returnKeyType="done"
                                onSubmitEditing={() => { if (words) done(); }}
                                testID="card-settings-words"
                            />
                            <SettingChips label={t('Show')} id="kind" colors={colors} value={kind} onPick={setKind}
                                options={SEARCH_KIND_CHIPS.map(k => ({ value: k.kind, label: t(k.label) }))} />
                            <SettingChips label={t('Category')} id="category" colors={colors} value={category} onPick={setCategory}
                                options={[{ value: null, label: t('Any category') }, ...POST_CATEGORIES.map(c => ({ value: c.id as string | null, label: `${c.emoji} ${categoryLabel(c.id)}` }))]} />
                            {hasPoint && (
                                <SettingChips label={t('Distance')} id="km" colors={colors} value={km} onPick={setKm}
                                    options={[{ value: null, label: t('Any distance') }, ...HOME_SEARCH_KMS.map(k => ({ value: k as number | null, label: t('{distance} km', { distance: k }) }))]} />
                            )}
                        </>)}
                        <Pressable
                            disabled={!ready}
                            onPress={done}
                            style={[settingsStyles.button, { backgroundColor: ready ? colors.brand.fill : colors.surface.subtle }]}
                            accessibilityRole="button"
                            accessibilityLabel={mode === 'add' ? t('Add {card} to Home', { card: name }) : t('Save {card}', { card: name })}
                            accessibilityState={{ disabled: !ready }}
                            testID="card-settings-done"
                        >
                            <Text style={[settingsStyles.buttonText, { color: ready ? colors.text.inverse : colors.text.secondary }]}>{mode === 'add' ? t('Add to Home') : t('Save')}</Text>
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** The chats a chat card can pin: 48dp rows of name and when it last spoke, a filter past 8, "On Home" for one taken. */
function ChatPickList({ chats, chosen, filter, onFilter, onChoose, colors, inputProps }: {
    chats?: { rows: ChatChoice[] | null; failed: boolean; onHome: ReadonlySet<string> };
    chosen: string | null;
    filter: string;
    onFilter: (q: string) => void;
    onChoose: (id: string) => void;
    colors: AppColors;
    inputProps: Record<string, unknown>;
}) {
    const rows = chats?.rows ?? null;
    if (!rows) {
        return <Text style={[settingsStyles.note, { color: colors.text.secondary }]} testID="card-settings-chats-note">{chats?.failed ? t(CHAT_CARD_WORDS.failed) : t('Loading…')}</Text>;
    }
    if (!rows.length) return <Text style={[settingsStyles.note, { color: colors.text.secondary }]} testID="card-settings-chats-note">{t(CHAT_CARD_WORDS.none)}</Text>;
    const shown = filterChatChoices(rows, filter);
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={t(CHAT_CARD_WORDS.pick)} testID="card-settings-chats">
            {rows.length > CHAT_PICK_FILTER_AFTER && (
                <TextInput
                    {...inputProps}
                    value={filter}
                    onChangeText={onFilter}
                    placeholder={t(CHAT_CARD_WORDS.filter)}
                    placeholderTextColor={colors.text.muted}
                    style={[settingsStyles.input, { color: colors.text.body, borderColor: colors.border.strong, backgroundColor: colors.surface.app, marginBottom: 8 }]}
                    accessibilityLabel={t(CHAT_CARD_WORDS.filter)}
                    testID="card-settings-chats-filter"
                />
            )}
            {shown.map(r => {
                const taken = chats!.onHome.has(r.conversationId);
                const on = !taken && r.conversationId === chosen;
                const when = timeAgoInWords(r.at);
                const right = taken ? t('On Home') : when;
                const label = [r.emoji, r.name].join(' ');
                return (
                    <Pressable key={r.conversationId} disabled={taken} onPress={() => onChoose(r.conversationId)}
                        style={[chatCardStyles.pickRow, { borderColor: on ? colors.brand.fill : colors.border.default, backgroundColor: on ? colors.surface.subtle : 'transparent' }]}
                        accessibilityRole="radio" accessibilityState={{ selected: on, checked: on, disabled: taken }}
                        accessibilityLabel={right ? [label, right].join(', ') : label}
                        testID={`card-settings-chat-${r.conversationId}`}>
                        <Text style={[chatCardStyles.pickName, { color: taken ? colors.text.secondary : colors.text.body }]} numberOfLines={2}>{label}</Text>
                        {!!right && <Text style={[chatCardStyles.pickWhen, { color: colors.text.secondary }]} numberOfLines={1}>{right}</Text>}
                    </Pressable>
                );
            })}
        </View>
    );
}

/** One row of chips under its label; the chosen one is filled, and a screen reader hears it as selected. */
function SettingChips<T>({ label, id, colors, options, value, onPick }: {
    label: string; id: string; colors: AppColors; options: ReadonlyArray<{ value: T; label: string }>; value: T; onPick: (v: T) => void;
}) {
    const s = homeStyles(colors);
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} testID={`card-settings-${id}`}>
            <Text style={[settingsStyles.label, { color: colors.text.body, marginTop: 14 }]}>{label}</Text>
            <View style={s.chips}>
                {options.map(o => {
                    const on = o.value === value;
                    return (
                        <Pressable key={String(o.value)} onPress={() => onPick(o.value)} style={[s.chip, on && s.chipOn]}
                            accessibilityRole="radio" accessibilityState={{ selected: on, checked: on }} accessibilityLabel={o.label}
                            testID={`card-settings-${id}-${String(o.value)}`}>
                            <Text style={[s.chipText, on && s.chipTextOn]}>{o.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

const settingsStyles = StyleSheet.create({
    label: { fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 6 },
    note: { fontSize: 13, marginTop: 10 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
    button: { marginTop: 16, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 15, fontWeight: '700' },
});
