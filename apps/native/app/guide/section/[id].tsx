import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from '../../ThemeContext';
import { useGuide } from '../../../utils/use-guide';
import { findGuideSection, sectionPages } from '../../../utils/guide';

export { ErrorBoundary };

// One part of the how-to manual (Market, Talk, Ledger …): its pages, one short task each.
export default function GuideSectionScreen() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const id = Array.isArray(params.id) ? params.id[0] : params.id;
    const { guide } = useGuide();
    const section = id ? findGuideSection(guide, id) : null;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        scroll: { padding: 16 },
        title: { fontSize: 26, fontWeight: '800', color: colors.text.heading, lineHeight: 32, marginTop: 4 },
        summary: { fontSize: 16, color: colors.text.secondary, lineHeight: 23, marginTop: 6, marginBottom: 16 },
        group: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden' },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
        rowDivider: { borderTopWidth: 1, borderTopColor: colors.border.default },
        rowText: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading },
        rowSub: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        missing: { fontSize: 16, color: colors.text.body, lineHeight: 24, marginTop: 24, textAlign: 'center' },
    }));

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>BEANPOOL GUIDE</Text>
                <View style={{ width: 48 }} />
            </View>

            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]}>
                {!section ? (
                    <Text style={styles.missing}>This part of the guide is not available. Go back and pick another one.</Text>
                ) : (
                    <>
                        <Text style={styles.title} accessibilityRole="header">{section.title}</Text>
                        <Text style={styles.summary}>{section.summary}</Text>
                        <View style={styles.group}>
                            {sectionPages(guide, section).map((p, i) => (
                                <Pressable
                                    key={p.slug}
                                    style={[styles.row, i > 0 && styles.rowDivider]}
                                    onPress={() => router.push({ pathname: '/guide/[slug]', params: { slug: p.slug } })}
                                    accessibilityRole="button"
                                    accessibilityLabel={p.title}
                                    accessibilityHint={p.summary}
                                >
                                    <View style={styles.rowText}>
                                        <Text style={styles.rowTitle} numberOfLines={2}>{p.title}</Text>
                                        <Text style={styles.rowSub} numberOfLines={2}>{p.summary}</Text>
                                    </View>
                                    <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                                </Pressable>
                            ))}
                        </View>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
