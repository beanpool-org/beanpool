import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, LayoutAnimation, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { useNavigation } from 'expo-router';
import { useTheme } from '../app/ThemeContext';

// MOCK v3 (mock/header-slim): the header row names the community, so each tabbed page (not the
// map) opens with its own large title, as iOS large titles do. Capped at 1.3x so "Commons" still
// fits one line at 320dp with the largest text setting.
export const PAGE_TITLE_SIZE = 30;
// MOCK v4: ONE spacing for every large title (Market, Talk, Pulse, Commons, Ledger). The title owns
// the gap above it and the gap to the first content row; pages add nothing of their own above that
// row while the title shows. v3 measured 10.7-18.7dp above and 6-22dp below, page by page.
export const PAGE_TITLE_TOP = 4;
export const PAGE_TITLE_BOTTOM = 8;
const PAGE_TITLE_LINE = 36;

export function PageTitle({ title, right, collapsed = false, inset = 16 }: {
    title: string;
    /** Page action drawn on the title's line (e.g. Talk's compose button). */
    right?: React.ReactNode;
    /** Pages whose controls stay pinned above their list fold the title away once scrolled. */
    collapsed?: boolean;
    /** Horizontal padding; 0 when the page's own container already pads 16 (Commons' list). */
    inset?: number;
}) {
    const { colors } = useTheme();
    if (collapsed) return null;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: inset, paddingTop: PAGE_TITLE_TOP, paddingBottom: PAGE_TITLE_BOTTOM }}>
            <Text
                accessibilityRole="header"
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                style={{ flex: 1, fontSize: PAGE_TITLE_SIZE, lineHeight: PAGE_TITLE_LINE, includeFontPadding: false, fontWeight: '800', letterSpacing: -0.5, color: colors.text.heading }}
            >
                {title}
            </Text>
            {right}
        </View>
    );
}

/**
 * For pages whose search/filter controls are pinned above the list: the title sits above those
 * controls and folds away once the list scrolls, returning at the top. Same thresholds (and the
 * same LayoutAnimation) Market already uses for its "fresh today" banner.
 */
export function useCollapsingTitle() {
    const [collapsed, setCollapsed] = useState(false);
    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const y = e.nativeEvent.contentOffset.y;
        if (y > 15) {
            setCollapsed(prev => {
                if (!prev) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                return true;
            });
        } else if (y <= 5) {
            setCollapsed(prev => {
                if (prev) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                return false;
            });
        }
    }, []);
    return { collapsed, onScroll };
}

type Scrollable = { scrollToOffset?: (p: { offset: number; animated?: boolean }) => void; scrollTo?: (p: { y: number; animated?: boolean }) => void };

/**
 * Tapping the tab you are already on scrolls the page back to the top — what React Navigation's
 * useScrollToTop does, written against expo-router's navigation so the app needs no new direct
 * dependency. The ref may point at whichever list the page is currently rendering.
 */
export function useTabRetapScrollTop(ref: React.RefObject<Scrollable | null>) {
    const navigation = useNavigation();
    useEffect(() => {
        const unsub = (navigation as any).addListener('tabPress', () => {
            // tabPress fires before the switch, so a focused screen means a re-tap.
            if (!navigation.isFocused()) return;
            const list = ref.current;
            if (!list) return;
            if (list.scrollToOffset) list.scrollToOffset({ offset: 0, animated: true });
            else list.scrollTo?.({ y: 0, animated: true });
        });
        return unsub;
    }, [navigation, ref]);
}
