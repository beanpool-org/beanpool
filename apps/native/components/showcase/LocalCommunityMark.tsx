/**
 * The one marker, 🏘️ Local community, and the sheet every variant opens (scratch/global-node/DESIGN-global-showcase-fable.md
 * §2, W3). Info tone with a 1 dp dashed border, in the theme's own colours (both schemes): never a lock, amber, red,
 * grey, reduced opacity or a trust tone. Variants: `pill` (a title), `strip` (the top of a preview screen), `action`
 * (a button that would move Beans or cast a vote keeps its place and words) and `line` (one tappable sentence).
 *
 * Nothing here writes: the sheet only goes to Start a community, Communities near you, or the feature's guide page.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_MARK, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, type ShowcaseFeature,
} from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import { lightColors, type AppColors } from '../../constants/colors';
import { contrastRatio } from '../../utils/readable-color';

/**
 * The marker's colours: the theme's info tone, so it reads in light and dark alike. Where the info tone doesn't read at
 * 4.5:1 on its own background, the card and the page, or is a hue the design rules out for the marker (an orange-red),
 * the marker takes the classic blue, as on the web. Its dashed border takes the tone's solid where the border would fade
 * into the card. Review of #1852, finding 6.
 */
export function markTone(colors: AppColors) {
    const own = colors.feedback.info;
    // The page is 'transparent' over the doodle pattern: only a colour can be measured.
    const reads = (fg: string, bg: string) => [bg, colors.surface.card, colors.surface.page]
        .filter(behind => /^#[0-9a-f]{6}$/i.test(behind))
        .every(behind => contrastRatio(fg, behind) >= 4.5);
    const info = reads(own.fg, own.bg) ? own : lightColors.feedback.info;
    const border = contrastRatio(info.border, colors.surface.card) >= 3 ? info.border : info.solid;
    return { fg: info.fg, bg: info.bg, border };
}

/** Where each of the sheet's ways forward goes. */
export const SHEET_ROUTES = Object.freeze({ start: '/start-community', nearYou: '/find-community' });

export function LocalCommunitySheet({ feature, visible, onClose }: { feature: ShowcaseFeature; visible: boolean; onClose: () => void }) {
    const { colors } = useTheme();
    const tone = markTone(colors);
    const s = sheetStyles(colors);
    const go = (to: () => void) => { onClose(); to(); };
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close" />
            <View style={s.sheet} testID="local-community-sheet">
                <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
                    <Text style={s.title} accessibilityRole="header">{LOCAL_COMMUNITY_EMOJI} {LOCAL_COMMUNITY_SHEET.title}</Text>
                    <Text style={s.body}>{LOCAL_COMMUNITY_SHEET.features[feature]}</Text>
                    <Text style={s.body}>{LOCAL_COMMUNITY_SHEET.common}</Text>
                    <Pressable style={[s.button, { backgroundColor: tone.fg, borderColor: tone.fg }]} accessibilityRole="button"
                        onPress={() => go(() => router.push(SHEET_ROUTES.start))}>
                        <Text style={[s.buttonText, { color: colors.surface.card }]}>{LOCAL_COMMUNITY_SHEET.start}</Text>
                    </Pressable>
                    <Pressable style={[s.button, { borderColor: tone.border }]} accessibilityRole="button"
                        onPress={() => go(() => router.push(SHEET_ROUTES.nearYou))}>
                        <Text style={[s.buttonText, { color: tone.fg }]}>{LOCAL_COMMUNITY_SHEET.nearYou}</Text>
                    </Pressable>
                    <Pressable style={[s.button, { borderColor: colors.border.default }]} accessibilityRole="button"
                        onPress={() => go(() => router.push({ pathname: '/guide/[slug]', params: { slug: LOCAL_COMMUNITY_SHEET.guide[feature] } }))}>
                        <Text style={[s.buttonText, { color: colors.text.body }]}>{LOCAL_COMMUNITY_SHEET.howItWorks}</Text>
                    </Pressable>
                </ScrollView>
            </View>
        </Modal>
    );
}

/** The strip's collapsed state: per node and feature, on this device only (a per-viewer convenience). */
export const stripKey = (nodeUrl: string, feature: ShowcaseFeature) =>
    `beanpool_showcase_strip:${nodeUrl.trim().replace(/\/+$/, '').toLowerCase()}:${feature}`;

function useStripCollapsed(feature: ShowcaseFeature): [boolean, (v: boolean) => void] {
    const [collapsed, setCollapsed] = useState(false);
    const [key, setKey] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
            if (!url || cancelled) return;
            const k = stripKey(url, feature);
            setKey(k);
            const v = await AsyncStorage.getItem(k).catch(() => null);
            if (!cancelled && v === '1') setCollapsed(true);
        })();
        return () => { cancelled = true; };
    }, [feature]);
    const set = (v: boolean) => {
        setCollapsed(v);
        if (key) AsyncStorage.setItem(key, v ? '1' : '0').catch(() => {});
    };
    return [collapsed, set];
}

type MarkProps =
    | { variant: 'pill'; feature: ShowcaseFeature }
    | { variant: 'strip'; feature: ShowcaseFeature }
    | { variant: 'action'; feature: ShowcaseFeature; label: string }
    | { variant: 'line'; feature: ShowcaseFeature; text: string };

export function LocalCommunityMark(props: MarkProps) {
    const { colors } = useTheme();
    const tone = markTone(colors);
    const s = markStyles(colors);
    const [open, setOpen] = useState(false);
    const [collapsed, setCollapsed] = useStripCollapsed(props.feature);
    const sheet = <LocalCommunitySheet feature={props.feature} visible={open} onClose={() => setOpen(false)} />;
    const pill = (
        <View style={[s.pill, { backgroundColor: tone.bg, borderColor: tone.border }]}>
            <Text style={[s.pillText, { color: tone.fg }]} numberOfLines={1}>{LOCAL_COMMUNITY_EMOJI} {LOCAL_COMMUNITY_MARK}</Text>
        </View>
    );

    if (props.variant === 'pill') {
        return (
            <>
                <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${LOCAL_COMMUNITY_MARK}: why?`} style={{ flexShrink: 0 }}>
                    {pill}
                </Pressable>
                {sheet}
            </>
        );
    }
    if (props.variant === 'action') {
        return (
            <>
                <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${props.label}, ${LOCAL_COMMUNITY_MARK}`}
                    style={[s.action, { borderColor: tone.border }]} testID="local-community-action">
                    <Text style={[s.actionText, { color: tone.fg }]}>{props.label}</Text>
                    {pill}
                </Pressable>
                {sheet}
            </>
        );
    }
    if (props.variant === 'line') {
        return (
            <>
                <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={s.line}>
                    <Text style={[s.lineText, { color: tone.fg }]}>{props.text}</Text>
                </Pressable>
                {sheet}
            </>
        );
    }
    if (collapsed) {
        return (
            <>
                <Pressable onPress={() => setCollapsed(false)} accessibilityRole="button" testID="local-community-strip"
                    style={[s.strip, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                    <Text style={[s.lineText, { color: tone.fg }]}>{LOCAL_COMMUNITY_STRIP.collapsed}</Text>
                </Pressable>
                {sheet}
            </>
        );
    }
    return (
        <>
            <View style={[s.strip, { backgroundColor: tone.bg, borderColor: tone.border }]} testID="local-community-strip">
                <View style={s.stripTop}>
                    {/* Tapping any variant opens the sheet (design §2), the strip's pill too (review of #1852, finding 12). */}
                    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${LOCAL_COMMUNITY_MARK}: why?`}
                        hitSlop={12} style={{ flexShrink: 0 }}>
                        {pill}
                    </Pressable>
                    <Pressable onPress={() => setCollapsed(true)} accessibilityRole="button" accessibilityLabel="Make this shorter" hitSlop={12}
                        style={s.close}>
                        <Text style={[s.closeText, { color: tone.fg }]}>✕</Text>
                    </Pressable>
                </View>
                <Text style={[s.stripText, { color: colors.text.body }]}>
                    <Text style={{ fontWeight: '800' }}>{LOCAL_COMMUNITY_STRIP.lead[props.feature]}</Text> {LOCAL_COMMUNITY_STRIP.body[props.feature]}
                </Text>
                <Pressable onPress={() => router.push(SHEET_ROUTES.start)} accessibilityRole="button"
                    style={[s.stripButton, { backgroundColor: tone.fg, borderColor: tone.fg }]}>
                    <Text style={[s.buttonText, { color: colors.surface.card }]}>{LOCAL_COMMUNITY_SHEET.start}</Text>
                </Pressable>
                <Pressable onPress={() => router.push(SHEET_ROUTES.nearYou)} accessibilityRole="button"
                    style={[s.stripButton, { borderColor: tone.border }]}>
                    <Text style={[s.buttonText, { color: tone.fg }]}>{LOCAL_COMMUNITY_SHEET.nearYou}</Text>
                </Pressable>
            </View>
            {sheet}
        </>
    );
}

/** The Example chip and the "Example Valley · an example member" header over a preview. */
export function ExampleHeader({ text = 'Example Valley · an example member' }: { text?: string }) {
    const { colors } = useTheme();
    const tone = markTone(colors);
    const s = markStyles(colors);
    return (
        <View style={s.header}>
            <View style={[s.pill, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                <Text style={[s.pillText, { color: tone.fg }]}>Example</Text>
            </View>
            <Text style={[s.headerText, { color: colors.text.secondary }]}>{text}</Text>
        </View>
    );
}

export const markStyles = (_colors: AppColors) => StyleSheet.create({
    pill: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start', flexShrink: 0 },
    pillText: { fontSize: 11, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.3 },
    strip: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 14, padding: 14, marginHorizontal: 16, marginVertical: 8, gap: 10 },
    stripTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    stripText: { fontSize: 14, lineHeight: 20 },
    stripButton: { borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, alignSelf: 'stretch' },
    close: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
    closeText: { fontSize: 18, fontWeight: '700' },
    buttonText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    action: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, minHeight: 48, paddingHorizontal: 12, paddingVertical: 8,
        flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
    actionText: { fontSize: 15, fontWeight: '800' },
    line: { minHeight: 48, justifyContent: 'center', paddingVertical: 6 },
    lineText: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
    header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8 },
    headerText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
});

const sheetStyles = (colors: AppColors) => StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.overlay.imageViewerCloseBg },
    sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
    title: { fontSize: 18, fontWeight: '800', color: colors.text.body },
    body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
    button: { borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    buttonText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
});
