import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
    View, Text, Pressable, Modal, ScrollView, TextInput, StyleSheet, BackHandler,
} from 'react-native';
import { KeyboardAvoidingView, KeyboardController } from 'react-native-keyboard-controller';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    FREE_TAGS_MAX, FREE_TAG_TOO_SHORT, LIBRARY_ASK_MS, POST_TAGS_MAX, TAG_COMMA, TOO_MANY_TAGS, TYPED_TAG_WORDS, communityTagsFor,
    didYouMeanTag, enterTypedTags, exactLibraryTag, lastTagOff, mergedInto, suggestTags, tagChildren, tagIndex, t, tn, typedTag,
    type CommunityTag, type LibraryElsewhere, type RefusedTag,
} from '@beanpool/core';
import { loadCommunityTags, loadLibraryTagFor } from '../utils/community-tags';
import { useTheme, useStyles } from '../app/ThemeContext';
import { hapticTick, hapticWarning } from '../utils/haptics';
import { dismissKeyboardWithin } from '../utils/keyboard-dismiss';

/**
 * How long the field has been still when a Backspace is a fresh press. React Native's key press has no repeat flag, and a
 * composing Android keyboard changes the text first and sends the key after, so stillness is all the phone can tell by. Past
 * a held key's first repeat, about 500 ms, so a hold from an empty field takes one chip; a second deliberate press this
 * soon does nothing, and the chip's own × is there. A chip lost has no undo.
 */
const BACKSPACE_STILL_MS = 600;

export interface TagPickerProps {
    value?: string[];
    tags?: string[];
    onChange: (tags: string[]) => void;
    /** The tags the member typed, as stored, and what takes them. Without it the picker holds the library's tags only. */
    freeTags?: string[];
    onFreeTagsChange?: (freeTags: string[]) => void;
    category?: string;
    title?: string;
    description?: string;
    testID?: string;
    /** Where this community's typed tags come from (GET /api/free-tags); read once each time the sheet opens. */
    communityTags?: () => Promise<CommunityTag[]>;
    /** The library tag a word is the label of in another language (GET /api/free-tags?q=, slice F5), or null. */
    libraryTagFor?: (text: string) => Promise<string | null>;
}

export function TagPicker({
    value,
    tags,
    onChange,
    freeTags = [],
    onFreeTagsChange,
    category,
    title = '',
    description = '',
    testID = 'tag-picker',
    communityTags = loadCommunityTags,
    libraryTagFor = loadLibraryTagFor,
}: TagPickerProps) {
    const selectedTags = value ?? tags ?? [];
    const { colors } = useTheme();
    const [sheetVisible, setSheetVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    // Why the last commit stayed in the field, in words, until the field changes.
    const [refused, setRefused] = useState<RefusedTag | null>(null);
    // When the field last moved: its text changed, or a Backspace reached it.
    const fieldMoved = useRef(0);

    useEffect(() => {
        if (!sheetVisible) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setSheetVisible(false);
            return true;
        });
        return () => sub.remove();
    }, [sheetVisible]);

    useEffect(() => {
        if (!sheetVisible) return;
        if (typeof window !== 'undefined' && window.addEventListener) {
            const handleKeyDown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSheetVisible(false);
                }
            };
            window.addEventListener('keydown', handleKeyDown, true);
            return () => window.removeEventListener('keydown', handleKeyDown, true);
        }
    }, [sheetVisible]);

    const styles = useStyles(({ colors, theme }) => StyleSheet.create({
        container: {
            marginVertical: 6,
        },
        labelRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
        },
        label: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.8,
        },
        chipsRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
        },
        chip: {
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 22,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.app,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            maxWidth: '100%',
        },
        chipSelected: {
            backgroundColor: colors.brand.fill,
            borderColor: colors.brand.fill,
        },
        chipText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.body,
            flexShrink: 1,
            minWidth: 0,
        },
        chipTextSelected: {
            color: colors.text.onBrand,
            fontWeight: '700',
        },
        addBtn: {
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 14,
            paddingVertical: 6,
            borderRadius: 22,
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: colors.brand.primary,
            backgroundColor: colors.brand.tint,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
        },
        addBtnText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.brand.primary,
        },
        removeIcon: {
            marginLeft: 2,
        },
        // Modal sheet styles
        keyboardLift: {
            flex: 1,
        },
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.45)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 12,
            paddingHorizontal: 16,
            paddingBottom: 32,
            maxHeight: '85%',
        },
        handleBar: {
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.border.strong,
            alignSelf: 'center',
            marginBottom: 12,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
        },
        headerTitle: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
        },
        doneBtn: {
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        doneBtnText: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.brand.primary,
        },
        searchWrap: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.app,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
            paddingHorizontal: 12,
            minHeight: 44,
            marginBottom: 14,
        },
        searchInput: {
            flex: 1,
            minHeight: 44,
            fontSize: 15,
            color: colors.text.body,
            paddingVertical: 8,
        },
        refusal: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.feedback.danger.fg,
            marginTop: -6,
            marginBottom: 10,
        },
        hint: {
            fontSize: 13,
            color: colors.text.secondary,
            marginBottom: 6,
        },
        addTypedRow: {
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 8,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border.default,
        },
        addTypedText: {
            flexShrink: 1,
            minWidth: 0,
            fontSize: 15,
            fontWeight: '700',
            color: colors.brand.primary,
        },
        sectionTitle: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginTop: 10,
            marginBottom: 8,
        },
        // This community's typed tags, under the library's matches (slice F3): a two-line chip, the tag and its count.
        usedHere: {
            marginTop: 8,
        },
        usedChip: {
            flexDirection: 'column',
            alignItems: 'flex-start',
            borderRadius: 16,
            gap: 0,
        },
        usedCount: {
            fontSize: 12,
            color: colors.text.secondary,
            flexShrink: 1,
        },
        sectionWrap: {
            marginBottom: 16,
        },
        groupRow: {
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: 10,
            paddingHorizontal: 4,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
        },
        groupLabel: {
            fontSize: 15,
            fontWeight: '600',
            color: colors.text.body,
        },
        groupItemsWrap: {
            paddingVertical: 8,
            paddingLeft: 8,
        },
        emptyText: {
            fontSize: 14,
            color: colors.text.muted,
            paddingVertical: 12,
            textAlign: 'center',
        },
    }));

    const index = useMemo(() => tagIndex(), [sheetVisible]);

    // This community's typed tags (slice F3): read when the sheet opens, none until they come or when they can't.
    const canType = !!onFreeTagsChange;
    const [community, setCommunity] = useState<CommunityTag[]>([]);
    useEffect(() => {
        if (!sheetVisible || !canType) return;
        let live = true;
        communityTags().then((list) => { if (live) setCommunity(list); }, () => {});
        return () => { live = false; };
    }, [sheetVisible, canType, communityTags]);
    // A word an owner merged into a library tag commits as that tag (core community-tags.ts).
    const merged = useMemo(() => mergedInto(community, index), [community, index]);

    const toggleTag = (id: string) => {
        if (selectedTags.includes(id)) {
            hapticTick();
            setRefused(null);
            onChange(selectedTags.filter((t) => t !== id));
        } else {
            if (selectedTags.length >= POST_TAGS_MAX) {
                hapticWarning();
                setRefused(TOO_MANY_TAGS);
                return;
            }
            hapticTick();
            setRefused(null);
            onChange([...selectedTags, id]);
        }
    };

    // A tag off makes room: what stopped the last one no longer stands.
    const takeOffFree = (tag: string) => {
        hapticTick();
        setRefused(null);
        onFreeTagsChange?.(freeTags.filter((other) => other !== tag));
    };

    const held = { tags: selectedTags, freeTags };

    // The typed word has found its tag. Left in the field, Done would put back one just taken off.
    const pickFound = (id: string) => {
        toggleTag(id);
        if (canType && (selectedTags.includes(id) || selectedTags.length < POST_TAGS_MAX)) setSearchQuery('');
    };

    /** Commits what is typed (core typed-tags.ts); false when a piece was refused and stays in the field with its words. */
    const enter = (text: string, done: boolean): boolean => {
        const entry = enterTypedTags(text, held, done, index, merged);
        const added = entry.tags.length !== selectedTags.length || entry.freeTags.length !== freeTags.length;
        if (entry.tags.length !== selectedTags.length) onChange(entry.tags);
        if (entry.freeTags.length !== freeTags.length) onFreeTagsChange?.(entry.freeTags);
        setSearchQuery(entry.rest);
        setRefused(entry.refused);
        if (entry.refused) hapticWarning();
        else if (added) hapticTick();
        return !entry.refused;
    };

    const typeInField = (text: string) => {
        fieldMoved.current = Date.now();
        setRefused(null);
        if (canType && TAG_COMMA.test(text)) enter(text, false);
        else setSearchQuery(text);
    };

    // A fresh Backspace on a field already empty before it takes the last chip off (as the web's !e.repeat && !composing).
    // Every Backspace moves the field, so a hold never goes still however long it runs, and the key a composing keyboard
    // sends after the last letter comes just after that letter went.
    const backspaceOnEmpty = (key: string) => {
        if (!canType || key !== 'Backspace') return;
        const now = Date.now();
        const fresh = now - fieldMoved.current >= BACKSPACE_STILL_MS;
        fieldMoved.current = now;
        if (!fresh || searchQuery.length > 0) return;
        const off = lastTagOff(held);
        if (off.freeTags.length !== freeTags.length) onFreeTagsChange?.(off.freeTags);
        else if (off.tags.length !== selectedTags.length) onChange(off.tags);
        else return;
        setRefused(null);
        hapticTick();
    };

    // Done commits what is in the field: a refused piece keeps the sheet open, with its words.
    const finish = () => {
        if (!canType || enter(searchQuery, true)) setSheetVisible(false);
    };

    // The keyboard goes first: a Modal opened over a raised one leaves the screen under it padded by its height.
    const openSheet = async () => {
        await dismissKeyboardWithin(() => KeyboardController.dismiss());
        setSheetVisible(true);
    };

    const toggleGroup = (groupId: string) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    };

    // Up to 8 suggestions from title, description and category
    const suggestions = useMemo(() => {
        return suggestTags(title, description, { category, limit: 8, index });
    }, [title, description, category, index]);

    // Search results (from 2 chars)
    const searchResults = useMemo(() => {
        const q = searchQuery.trim();
        if (q.length < 2) return [];
        const found = index.search(q, 12);
        // A plural ("lemons") is no prefix of its label, and Enter picks that label: it has a row like any other.
        const exact = canType ? exactLibraryTag(q, index) : null;
        return exact && !found.includes(exact) ? [exact, ...found] : found;
    }, [searchQuery, index, canType]);

    // What Enter would do with the field now. A word still being typed is not yet too short.
    const typed = canType ? typedTag(searchQuery, held, index, merged) : null;
    // Under the library's matches: this community's tags the typing reaches, never one with a library label's letters.
    const usedHere = canType ? communityTagsFor(searchQuery, community, held, { shadowed: (tag) => exactLibraryTag(tag, index) !== null }) : [];
    const addable = typed?.kind === 'free' && !freeTags.includes(typed.tag) ? typed.tag : null;
    // A word "Add" would make that is a library tag's label in another language (slice F5): the node is asked once the field
    // is still, once per word, and the field offers that tag above the "Add" row. Return still adds the member's own word.
    const [elsewhere, setElsewhere] = useState<LibraryElsewhere | null>(null);
    const askedNode = useRef(new Map<string, string | null>());
    useEffect(() => {
        if (!sheetVisible || !addable) return;
        const known = askedNode.current.get(addable);
        if (known !== undefined) { setElsewhere({ tag: addable, id: known }); return; }
        let live = true;
        const timer = setTimeout(() => {
            libraryTagFor(addable).then((id) => {
                askedNode.current.set(addable, id);
                if (live) setElsewhere({ tag: addable, id });
            }, () => {});
        }, LIBRARY_ASK_MS);
        return () => { live = false; clearTimeout(timer); };
    }, [sheetVisible, addable, libraryTagFor]);
    const meant = didYouMeanTag(addable, elsewhere, held, searchResults, index);
    const shownRefusal = refused ?? (typed?.kind === 'refused' && typed.why !== FREE_TAG_TOO_SHORT ? typed : null);

    // Groups for the selected category
    const groups = useMemo(() => {
        if (!category) return [];
        return tagChildren(category);
    }, [category]);

    const chosenChips = (
        <>
            {selectedTags.map((id) => {
                const label = index.label(id);
                if (!label) return null;
                return (
                    <Pressable
                        key={id}
                        style={[styles.chip, styles.chipSelected]}
                        onPress={() => toggleTag(id)}
                        accessibilityRole="button"
                        accessibilityLabel={t('Remove {name}', { name: label })}
                    >
                        <Text style={[styles.chipText, styles.chipTextSelected]}>{label}</Text>
                        <MaterialCommunityIcons name="close" size={16} color={colors.text.onBrand} style={styles.removeIcon} />
                    </Pressable>
                );
            })}
            {freeTags.map((tag) => (
                <Pressable
                    key={`#${tag}`}
                    style={[styles.chip, styles.chipSelected]}
                    onPress={() => takeOffFree(tag)}
                    accessibilityRole="button"
                    accessibilityLabel={t('Remove {name}', { name: `#${tag}` })}
                >
                    <Text style={[styles.chipText, styles.chipTextSelected]}>#{tag}</Text>
                    <MaterialCommunityIcons name="close" size={16} color={colors.text.onBrand} style={styles.removeIcon} />
                </Pressable>
            ))}
        </>
    );

    return (
        <View style={styles.container} testID={testID}>
            <View style={styles.labelRow}>
                <Text style={styles.label}>{t('Tags · optional')}</Text>
            </View>

            <View style={styles.chipsRow}>
                {chosenChips}

                {(selectedTags.length < POST_TAGS_MAX || (canType && freeTags.length < FREE_TAGS_MAX)) && (
                    <Pressable
                        style={styles.addBtn}
                        onPress={openSheet}
                        accessibilityRole="button"
                        accessibilityLabel={t('+ Add tag')}
                    >
                        <Text style={styles.addBtnText}>{t('+ Add')}</Text>
                    </Pressable>
                )}
            </View>

            <Modal
                visible={sheetVisible}
                transparent
                animationType="slide"
                onRequestClose={() => setSheetVisible(false)}
            >
                {/* The search sits low in a short sheet at 320 dp: the root KeyboardProvider's lift, never a nested one. */}
                <KeyboardAvoidingView style={styles.keyboardLift} behavior="padding">
                <Pressable style={styles.overlay} onPress={() => setSheetVisible(false)}>
                    <Pressable testID="tag-picker-sheet" style={styles.sheet} onPress={(e) => e.stopPropagation()}>
                        <View style={styles.handleBar} />
                        <View style={styles.headerRow}>
                            <Text style={styles.headerTitle}>{t('Tags')}</Text>
                            <Pressable
                                style={styles.doneBtn}
                                onPress={finish}
                                accessibilityRole="button"
                                accessibilityLabel={t('Done')}
                            >
                                <Text style={styles.doneBtnText}>{t('Done')}</Text>
                            </Pressable>
                        </View>

                        <View style={styles.searchWrap}>
                            <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} style={{ marginRight: 8 }} />
                            <TextInput
                                style={styles.searchInput}
                                placeholder={t('Search tags...')}
                                placeholderTextColor={colors.text.muted}
                                value={searchQuery}
                                onChangeText={typeInField}
                                onKeyPress={(e) => backspaceOnEmpty(e.nativeEvent.key)}
                                // Return commits and the keyboard stays, for the next tag.
                                {...(canType ? { onSubmitEditing: () => { enter(searchQuery, true); }, submitBehavior: 'submit' as const, returnKeyType: 'done' as const } : {})}
                                autoCapitalize="none"
                                autoCorrect={false}
                                accessibilityLabel={t('Search tags')}
                            />
                            {searchQuery.length > 0 && (
                                <Pressable
                                    onPress={() => { setSearchQuery(''); setRefused(null); }}
                                    style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Clear search')}
                                >
                                    <MaterialCommunityIcons name="close-circle" size={18} color={colors.text.muted} />
                                </Pressable>
                            )}
                        </View>

                        {shownRefusal && <Text style={styles.refusal} accessibilityLiveRegion="polite">{t(shownRefusal.why)}</Text>}

                        <ScrollView
                            keyboardShouldPersistTaps="handled"
                            showsVerticalScrollIndicator
                            contentContainerStyle={{ paddingBottom: canType ? 8 : 24 }}
                        >
                            {canType && selectedTags.length + freeTags.length > 0 && (
                                <View style={[styles.chipsRow, styles.sectionWrap]} testID="tag-picker-chosen">{chosenChips}</View>
                            )}
                            {searchQuery.trim().length >= 2 ? (
                                <View style={styles.sectionWrap}>
                                    {(searchResults.length > 0 || !canType) && <Text style={styles.sectionTitle}>{t('Search results')}</Text>}
                                    {searchResults.length === 0 ? (
                                        !canType && <Text style={styles.emptyText}>{t('No tags found')}</Text>
                                    ) : (
                                        <View style={styles.chipsRow}>
                                            {searchResults.map((id) => {
                                                const label = index.label(id);
                                                const selected = selectedTags.includes(id);
                                                return (
                                                    <Pressable
                                                        key={id}
                                                        style={[styles.chip, selected && styles.chipSelected]}
                                                        onPress={() => pickFound(id)}
                                                        accessibilityRole="button"
                                                        accessibilityState={{ selected }}
                                                    >
                                                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                                                            {label || id}
                                                        </Text>
                                                        {selected && (
                                                            <MaterialCommunityIcons name="check" size={16} color={colors.text.onBrand} />
                                                        )}
                                                    </Pressable>
                                                );
                                            })}
                                        </View>
                                    )}
                                    {usedHere.length > 0 && (
                                        <View style={styles.usedHere} testID="tag-picker-used-here">
                                            <Text style={styles.sectionTitle}>{t('Tags used here')}</Text>
                                            <View style={styles.chipsRow}>
                                                {usedHere.map((c) => (
                                                    <Pressable
                                                        key={`#${c.tag}`}
                                                        style={[styles.chip, styles.usedChip]}
                                                        onPress={() => (c.mergeInto ? pickFound(c.mergeInto) : enter(c.tag, true))}
                                                        accessibilityRole="button"
                                                    >
                                                        <Text style={styles.chipText}>{c.mergeInto ? index.label(c.mergeInto) : `#${c.tag}`}</Text>
                                                        <Text style={styles.usedCount}>
                                                            {[c.mergeInto ? `#${c.tag}` : '', c.listings > 0 ? tn(c.listings, 'Used on {n} listing', 'Used on {n} listings') : '']
                                                                .filter(Boolean).join(' · ')}
                                                        </Text>
                                                    </Pressable>
                                                ))}
                                            </View>
                                        </View>
                                    )}
                                </View>
                            ) : (
                                <>
                                    {canType && (
                                        <View style={styles.sectionWrap}>
                                            <Text style={styles.hint}>{t(TYPED_TAG_WORDS.arePublic)}</Text>
                                            <Text style={styles.hint}>{t(TYPED_TAG_WORDS.yourWords)}</Text>
                                        </View>
                                    )}
                                    {suggestions.length > 0 && (
                                        <View style={styles.sectionWrap}>
                                            <Text style={styles.sectionTitle}>{t('Suggested')}</Text>
                                            <View style={styles.chipsRow}>
                                                {suggestions.map((id) => {
                                                    const label = index.label(id);
                                                    const selected = selectedTags.includes(id);
                                                    return (
                                                        <Pressable
                                                            key={id}
                                                            style={[styles.chip, selected && styles.chipSelected]}
                                                            onPress={() => toggleTag(id)}
                                                            accessibilityRole="button"
                                                            accessibilityState={{ selected }}
                                                        >
                                                            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                                                                {label || id}
                                                            </Text>
                                                            {selected && (
                                                                <MaterialCommunityIcons name="check" size={16} color={colors.text.onBrand} />
                                                            )}
                                                        </Pressable>
                                                    );
                                                })}
                                            </View>
                                        </View>
                                    )}

                                    {groups.length > 0 && (
                                        <View style={styles.sectionWrap}>
                                            <Text style={styles.sectionTitle}>{t('Categories')}</Text>
                                            {groups.map((group) => {
                                                const groupLabel = index.label(group.id) || group.id;
                                                const isExpanded = expandedGroups.has(group.id);
                                                const items = tagChildren(group.id);

                                                return (
                                                    <View key={group.id}>
                                                        <Pressable
                                                            style={styles.groupRow}
                                                            onPress={() => toggleGroup(group.id)}
                                                            accessibilityRole="button"
                                                            accessibilityState={{ expanded: isExpanded }}
                                                        >
                                                            <Text style={styles.groupLabel}>{groupLabel}</Text>
                                                            <MaterialCommunityIcons
                                                                name={isExpanded ? 'chevron-down' : 'chevron-right'}
                                                                size={22}
                                                                color={colors.text.secondary}
                                                            />
                                                        </Pressable>

                                                        {isExpanded && (
                                                            <View style={styles.groupItemsWrap}>
                                                                <View style={styles.chipsRow}>
                                                                    {items.length > 0 ? (
                                                                        items.map((item) => {
                                                                            const itemLabel = index.label(item.id) || item.id;
                                                                            const selected = selectedTags.includes(item.id);
                                                                            return (
                                                                                <Pressable
                                                                                    key={item.id}
                                                                                    style={[styles.chip, selected && styles.chipSelected]}
                                                                                    onPress={() => toggleTag(item.id)}
                                                                                    accessibilityRole="button"
                                                                                    accessibilityState={{ selected }}
                                                                                >
                                                                                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                                                                                        {itemLabel}
                                                                                    </Text>
                                                                                    {selected && (
                                                                                        <MaterialCommunityIcons name="check" size={16} color={colors.text.onBrand} />
                                                                                    )}
                                                                                </Pressable>
                                                                            );
                                                                        })
                                                                    ) : (
                                                                        <Pressable
                                                                            style={[styles.chip, selectedTags.includes(group.id) && styles.chipSelected]}
                                                                            onPress={() => toggleTag(group.id)}
                                                                            accessibilityRole="button"
                                                                            accessibilityState={{ selected: selectedTags.includes(group.id) }}
                                                                        >
                                                                            <Text style={[styles.chipText, selectedTags.includes(group.id) && styles.chipTextSelected]}>
                                                                                {groupLabel}
                                                                            </Text>
                                                                            {selectedTags.includes(group.id) && (
                                                                                <MaterialCommunityIcons name="check" size={16} color={colors.text.onBrand} />
                                                                            )}
                                                                        </Pressable>
                                                                    )}
                                                                </View>
                                                            </View>
                                                        )}
                                                    </View>
                                                );
                                            })}
                                        </View>
                                    )}
                                </>
                            )}
                        </ScrollView>

                        {/* The library tag the typed word names in another language, just above the row that adds the word itself. */}
                        {meant && (
                            <Pressable style={styles.addTypedRow} onPress={() => pickFound(meant)} accessibilityRole="button" testID="tag-picker-did-you-mean">
                                <MaterialCommunityIcons name="tag-outline" size={18} color={colors.brand.primary} />
                                <Text style={styles.addTypedText}>{t(TYPED_TAG_WORDS.didYouMean, { tag: index.label(meant) })}</Text>
                            </Pressable>
                        )}
                        {/* The last row, and held below the list: on a short sheet twelve results would push it under the keyboard. */}
                        {addable && (
                            <Pressable style={styles.addTypedRow} onPress={() => enter(searchQuery, true)} accessibilityRole="button" testID="tag-picker-add-typed">
                                <MaterialCommunityIcons name="plus" size={18} color={colors.brand.primary} />
                                <Text style={styles.addTypedText}>{t(TYPED_TAG_WORDS.add, { tag: `#${addable}` })}</Text>
                            </Pressable>
                        )}
                    </Pressable>
                </Pressable>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}
