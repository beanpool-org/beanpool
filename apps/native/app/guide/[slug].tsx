import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Linking } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from '../ThemeContext';
import { useGuide } from '../../utils/use-guide';
import { findGuidePage, findGuideSection, relatedPages, findGuideVideo, splitBold, guidePageBodyInEnglish } from '../../utils/guide';
import { useLearnVideos } from '../../utils/use-learn-videos';
import { inCapitalsOf, t } from '@beanpool/core';

export { ErrorBoundary };

// One page of the members' guide: headings, short paragraphs and bullets, as plain Text (no web view), then its
// Related pages. The words come from packages/beanpool-guide/content — the same text as beanpool.org/guide/.
// A "Watch" link shows only when this community's Pulse → Learn lane has a matching video (findGuideVideo in
// @beanpool/core says how they match); the page is complete without it. The title, summary and section are in the
// member's language where the guide's titles file has them (useGuide); the body is English until slice S5b, and then the
// page says so in one line at its top.
export default function GuideScreen() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ slug?: string | string[] }>();
    const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
    const { guide } = useGuide();
    const page = slug ? findGuidePage(guide, slug) : null;
    const section = page ? findGuideSection(guide, page.section) : null;
    const videos = useLearnVideos();
    const video = page ? findGuideVideo(page, videos) : null;
    // The title is in the member's language over an English body: one line says so, and VoiceOver reads the body as English.
    const bodyInEnglish = !!page && guidePageBodyInEnglish(page);
    const bodyLanguage = bodyInEnglish ? 'en' : undefined;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        scroll: { paddingHorizontal: 20, paddingTop: 20 },
        // 24, not 26: a one-word title in a longer language ("Notificaciones") still fits the line at 320 dp and 1.3× text.
        title: { fontSize: 24, fontWeight: '800', color: colors.text.heading, lineHeight: 30 },
        summary: { fontSize: 16, color: colors.text.secondary, lineHeight: 23, marginTop: 8, marginBottom: 8 },
        h2: { fontSize: 20, fontWeight: '700', color: colors.text.heading, lineHeight: 26, marginTop: 26, marginBottom: 6 },
        h3: { fontSize: 17, fontWeight: '700', color: colors.text.heading, lineHeight: 23, marginTop: 18, marginBottom: 4 },
        p: { fontSize: 16, color: colors.text.body, lineHeight: 24, marginTop: 8 },
        bold: { fontWeight: '700', color: colors.text.heading },
        li: { flexDirection: 'row', marginTop: 8, paddingRight: 4 },
        bullet: { width: 20, fontSize: 16, lineHeight: 24, color: colors.brand.primary, flexShrink: 0 },
        liText: { flex: 1, fontSize: 16, color: colors.text.body, lineHeight: 24 },
        kicker: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', marginTop: -8 },
        kickerText: { fontSize: 13, fontWeight: '700', color: colors.brand.primary, letterSpacing: 0.5 },
        englishNote: { fontSize: 14, color: colors.text.secondary, lineHeight: 20, marginTop: 4, marginBottom: 4 },
        watch: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, marginTop: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        watchText: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: colors.text.heading },
        relatedLabel: { fontSize: 12, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginTop: 32, marginBottom: 8 },
        group: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden' },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
        rowDivider: { borderTopWidth: 1, borderTopColor: colors.border.default },
        rowText: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading },
        rowSub: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        missing: { fontSize: 16, color: colors.text.body, lineHeight: 24, marginTop: 24, textAlign: 'center' },
    }));

    const rich = (text: string) => splitBold(text).map((s, i) => (
        <Text key={i} style={s.bold ? styles.bold : undefined}>{s.text}</Text>
    ));

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('BEANPOOL GUIDE')}</Text>
                <View style={{ width: 48 }} />
            </View>

            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]}>
                {!page ? (
                    <Text style={styles.missing}>{t('This guide is not available. Go back and pick another one.')}</Text>
                ) : (
                    <>
                        {section && (
                            <Pressable
                                style={styles.kicker}
                                onPress={() => router.push({ pathname: '/guide/section/[id]', params: { id: section.id } })}
                                accessibilityRole="button"
                                accessibilityLabel={t('Part of: {section}', { section: section.title })}
                            >
                                {/* In capitals the language's way (Turkish İ), never textTransform; never cut, a longer title wraps. */}
                                <Text style={styles.kickerText}>{inCapitalsOf(section.title)}</Text>
                            </Pressable>
                        )}
                        <Text style={styles.title} accessibilityRole="header">{page.title}</Text>
                        <Text style={styles.summary}>{page.summary}</Text>
                        {bodyInEnglish && <Text style={styles.englishNote} testID="guide-english-note">{t('This page is in English for now.')}</Text>}
                        {video && (
                            <Pressable
                                style={styles.watch}
                                onPress={() => { Linking.openURL(video.url).catch(() => {}); }}
                                accessibilityRole="link"
                                accessibilityLabel={t('Watch: {title}. Opens the video.', { title: video.title })}
                            >
                                <MaterialCommunityIcons name="play-circle-outline" size={24} color={colors.brand.primary} />
                                <Text style={styles.watchText} numberOfLines={2}>{t('Watch: {title}', { title: video.title })}</Text>
                            </Pressable>
                        )}
                        {page.blocks.map((b, i) => {
                            if (b.type === 'ul') {
                                return (
                                    <View key={i}>
                                        {b.items.map((item, j) => (
                                            <View key={j} style={styles.li}>
                                                <Text style={styles.bullet} importantForAccessibility="no" accessibilityElementsHidden>•</Text>
                                                <Text style={styles.liText} accessibilityLanguage={bodyLanguage}>{rich(item)}</Text>
                                            </View>
                                        ))}
                                    </View>
                                );
                            }
                            if (b.type === 'h2') return <Text key={i} style={styles.h2} accessibilityRole="header" accessibilityLanguage={bodyLanguage}>{rich(b.text)}</Text>;
                            if (b.type === 'h3') return <Text key={i} style={styles.h3} accessibilityRole="header" accessibilityLanguage={bodyLanguage}>{rich(b.text)}</Text>;
                            return <Text key={i} style={styles.p} accessibilityLanguage={bodyLanguage}>{rich(b.text)}</Text>;
                        })}
                        {relatedPages(guide, page).length > 0 && (
                            <>
                                <Text style={styles.relatedLabel} accessibilityRole="header">{t('RELATED')}</Text>
                                <View style={styles.group}>
                                    {relatedPages(guide, page).map((r, i) => (
                                        <Pressable
                                            key={r.slug}
                                            style={[styles.row, i > 0 && styles.rowDivider]}
                                            onPress={() => router.push({ pathname: '/guide/[slug]', params: { slug: r.slug } })}
                                            accessibilityRole="button"
                                            accessibilityLabel={r.title}
                                            accessibilityHint={r.summary}
                                        >
                                            <View style={styles.rowText}>
                                                <Text style={styles.rowTitle}>{r.title}</Text>
                                                <Text style={styles.rowSub} numberOfLines={2}>{r.summary}</Text>
                                            </View>
                                            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                                        </Pressable>
                                    ))}
                                </View>
                            </>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
