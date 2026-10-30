import React, { useState, useMemo } from 'react';
import {
    View, Text, Pressable, Modal, ScrollView, TextInput, StyleSheet, Dimensions,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    POST_TAGS_MAX, isTagId, suggestTags, tagChildren, tagIndex, t,
} from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { hapticTick, hapticWarning } from '../utils/haptics';

export interface TagPickerProps {
    value?: string[];
    tags?: string[];
    onChange: (tags: string[]) => void;
    category?: string;
    title?: string;
    description?: string;
    testID?: string;
}

export function TagPicker({
    value,
    tags,
    onChange,
    category,
    title = '',
    description = '',
    testID = 'tag-picker',
}: TagPickerProps) {
    const selectedTags = value ?? tags ?? [];
    const { colors, theme } = useTheme();
    const [sheetVisible, setSheetVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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
        },
        chipSelected: {
            backgroundColor: colors.brand.primary,
            borderColor: colors.brand.primary,
        },
        chipText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.body,
        },
        chipTextSelected: {
            color: colors.text.inverse,
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
        sectionTitle: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginTop: 10,
            marginBottom: 8,
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

    const toggleTag = (id: string) => {
        if (selectedTags.includes(id)) {
            hapticTick();
            onChange(selectedTags.filter((t) => t !== id));
        } else {
            if (selectedTags.length >= POST_TAGS_MAX) {
                hapticWarning();
                return;
            }
            hapticTick();
            onChange([...selectedTags, id]);
        }
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
        return index.search(q, 12);
    }, [searchQuery, index]);

    // Groups for the selected category
    const groups = useMemo(() => {
        if (!category) return [];
        return tagChildren(category);
    }, [category]);

    return (
        <View style={styles.container} testID={testID}>
            <View style={styles.labelRow}>
                <Text style={styles.label}>{t('Tags · optional')}</Text>
            </View>

            <View style={styles.chipsRow}>
                {selectedTags.map((id) => {
                    const label = index.label(id);
                    if (!label && !isTagId(id)) return null;
                    return (
                        <Pressable
                            key={id}
                            style={[styles.chip, styles.chipSelected]}
                            onPress={() => toggleTag(id)}
                            accessibilityRole="button"
                            accessibilityLabel={t('Remove {name}', { name: label || id })}
                        >
                            <Text style={[styles.chipText, styles.chipTextSelected]}>{label || id}</Text>
                            <MaterialCommunityIcons name="close" size={16} color={colors.text.inverse} style={styles.removeIcon} />
                        </Pressable>
                    );
                })}

                {selectedTags.length < POST_TAGS_MAX && (
                    <Pressable
                        style={styles.addBtn}
                        onPress={() => setSheetVisible(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('+ Add tag')}
                    >
                        <MaterialCommunityIcons name="plus" size={16} color={colors.brand.primary} />
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
                <Pressable style={styles.overlay} onPress={() => setSheetVisible(false)}>
                    <Pressable testID="tag-picker-sheet" style={styles.sheet} onPress={(e) => e.stopPropagation()}>
                        <View style={styles.handleBar} />
                        <View style={styles.headerRow}>
                            <Text style={styles.headerTitle}>{t('Tags')}</Text>
                            <Pressable
                                style={styles.doneBtn}
                                onPress={() => setSheetVisible(false)}
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
                                onChangeText={setSearchQuery}
                                autoCapitalize="none"
                                autoCorrect={false}
                                accessibilityLabel={t('Search tags')}
                            />
                            {searchQuery.length > 0 && (
                                <Pressable
                                    onPress={() => setSearchQuery('')}
                                    style={{ padding: 4 }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Clear search')}
                                >
                                    <MaterialCommunityIcons name="close-circle" size={18} color={colors.text.muted} />
                                </Pressable>
                            )}
                        </View>

                        <ScrollView
                            keyboardShouldPersistTaps="handled"
                            showsVerticalScrollIndicator
                            contentContainerStyle={{ paddingBottom: 24 }}
                        >
                            {searchQuery.trim().length >= 2 ? (
                                <View style={styles.sectionWrap}>
                                    <Text style={styles.sectionTitle}>{t('Search results')}</Text>
                                    {searchResults.length === 0 ? (
                                        <Text style={styles.emptyText}>{t('No tags found')}</Text>
                                    ) : (
                                        <View style={styles.chipsRow}>
                                            {searchResults.map((id) => {
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
                                                            <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />
                                                        )}
                                                    </Pressable>
                                                );
                                            })}
                                        </View>
                                    )}
                                </View>
                            ) : (
                                <>
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
                                                                <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />
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
                                                                                        <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />
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
                                                                                <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />
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
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}
