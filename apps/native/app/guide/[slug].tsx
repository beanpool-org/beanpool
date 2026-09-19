import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from '../ThemeContext';
import { useGuide } from '../../utils/use-guide';
import { findGuidePage, splitBold } from '../../utils/guide';

export { ErrorBoundary };

// One guide from the members' guide: headings, short paragraphs and bullets, as plain Text (no web view).
// The words come from packages/beanpool-guide/content — the same text as beanpool.org/guide/.
export default function GuideScreen() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ slug?: string | string[] }>();
    const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
    const { guide } = useGuide();
    const page = slug ? findGuidePage(guide, slug) : null;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        scroll: { paddingHorizontal: 20, paddingTop: 20 },
        title: { fontSize: 26, fontWeight: '800', color: colors.text.heading, lineHeight: 32 },
        summary: { fontSize: 16, color: colors.text.secondary, lineHeight: 23, marginTop: 8, marginBottom: 8 },
        h2: { fontSize: 20, fontWeight: '700', color: colors.text.heading, lineHeight: 26, marginTop: 26, marginBottom: 6 },
        h3: { fontSize: 17, fontWeight: '700', color: colors.text.heading, lineHeight: 23, marginTop: 18, marginBottom: 4 },
        p: { fontSize: 16, color: colors.text.body, lineHeight: 24, marginTop: 8 },
        bold: { fontWeight: '700', color: colors.text.heading },
        li: { flexDirection: 'row', marginTop: 8, paddingRight: 4 },
        bullet: { width: 20, fontSize: 16, lineHeight: 24, color: colors.brand.primary, flexShrink: 0 },
        liText: { flex: 1, fontSize: 16, color: colors.text.body, lineHeight: 24 },
        missing: { fontSize: 16, color: colors.text.body, lineHeight: 24, marginTop: 24, textAlign: 'center' },
    }));

    const rich = (text: string) => splitBold(text).map((s, i) => (
        <Text key={i} style={s.bold ? styles.bold : undefined}>{s.text}</Text>
    ));

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
                {!page ? (
                    <Text style={styles.missing}>This guide is not available. Go back and pick another one.</Text>
                ) : (
                    <>
                        <Text style={styles.title} accessibilityRole="header">{page.title}</Text>
                        <Text style={styles.summary}>{page.summary}</Text>
                        {page.blocks.map((b, i) => {
                            if (b.type === 'ul') {
                                return (
                                    <View key={i}>
                                        {b.items.map((item, j) => (
                                            <View key={j} style={styles.li}>
                                                <Text style={styles.bullet} importantForAccessibility="no" accessibilityElementsHidden>•</Text>
                                                <Text style={styles.liText}>{rich(item)}</Text>
                                            </View>
                                        ))}
                                    </View>
                                );
                            }
                            if (b.type === 'h2') return <Text key={i} style={styles.h2} accessibilityRole="header">{rich(b.text)}</Text>;
                            if (b.type === 'h3') return <Text key={i} style={styles.h3} accessibilityRole="header">{rich(b.text)}</Text>;
                            return <Text key={i} style={styles.p}>{rich(b.text)}</Text>;
                        })}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
