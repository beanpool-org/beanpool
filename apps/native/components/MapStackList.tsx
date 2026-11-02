import React, { useEffect, useMemo } from 'react';
import { AccessibilityInfo, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { STACK_LIST_SHARE, stackHeading, t } from '@beanpool/core';
import { MarketCardPicture } from './MarketCardPicture';
import { stackRow, type StackRow } from '../utils/map-stack';
import { useStyles } from '../app/ThemeContext';

const PHOTO = 56;

/**
 * The pins of a bubble that cannot split (Marty, 2 Nov: three events at one hall took four taps): a panel over the bottom
 * third of the map, every pin a compact row, whether 3 or 100, so the bubble stays in view above it. It scrolls on a FlatList,
 * so 100 rows mount a screenful at a time. A row opens that post; ✕ or a tap on the map closes the panel.
 */
export function MapStackList({ posts, onOpen, onClose }: {
    posts: readonly any[];
    onOpen: (id: string) => void;
    onClose: () => void;
}) {
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        panel: {
            position: 'absolute', left: 0, right: 0, bottom: 0, height: `${STACK_LIST_SHARE * 100}%`, zIndex: 150,
            backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden',
            shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: theme === 'dark' ? 0.4 : 0.15, shadowRadius: 12, elevation: 20,
        },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, minHeight: 52,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.strong,
        },
        heading: { flex: 1, fontSize: 17, fontWeight: '800', color: colors.text.heading, paddingVertical: 8 },
        close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
        closeText: { fontSize: 16, fontWeight: '800', color: colors.text.secondary },
        row: {
            flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8, minHeight: 72,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.default,
        },
        rowPressed: { backgroundColor: colors.surface.subtle },
        photoBox: { width: PHOTO, height: PHOTO, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface.subtle },
        photo: { width: '100%', height: '100%' },
        tile: { width: PHOTO, height: PHOTO },
        words: { flex: 1, minWidth: 0 },
        title: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        type: { fontSize: 13, fontWeight: '600', color: colors.text.secondary, marginTop: 2 },
        when: { fontSize: 13, fontWeight: '700', color: colors.event.ink, marginTop: 2 },
    }));

    const rows = useMemo(() => posts.map(stackRow), [posts]);
    const heading = stackHeading(rows.length);

    // Opening does not move a screen reader's focus, so the count is said aloud as the panel comes up.
    useEffect(() => { AccessibilityInfo.announceForAccessibility?.(heading); }, []);

    const renderRow = ({ item }: { item: StackRow }) => (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.label}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onOpen(item.id)}
        >
            <View style={styles.photoBox}>
                <MarketCardPicture
                    postId={item.id}
                    cover={item.cover}
                    picture={item.picture}
                    category={item.category}
                    kind={item.isEvent ? 'event' : 'listing'}
                    size="thumb"
                    imageStyle={styles.photo}
                    tileStyle={styles.tile}
                />
            </View>
            <View style={styles.words}>
                <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.type}>{item.type}</Text>
                {item.when ? <Text style={styles.when}>{item.when}</Text> : null}
            </View>
        </Pressable>
    );

    return (
        <View style={styles.panel} testID="map-stack-list">
            <View style={styles.header}>
                <Text style={styles.heading} accessibilityRole="header">{heading}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.close} onPress={onClose}>
                    <Text style={styles.closeText}>✕</Text>
                </Pressable>
            </View>
            <FlatList
                data={rows}
                keyExtractor={(r) => r.id}
                renderItem={renderRow}
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={5}
                keyboardShouldPersistTaps="handled"
            />
        </View>
    );
}
