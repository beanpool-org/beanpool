/**
 * The Market's one line about Learn (DESIGN-local-knowledge-fable.md amended §2.7, §3.9): while the Market's search box holds words
 * and Learn has a match, one line sits above the results (and in the empty state): "📖 In Learn: {n} for "{words}" ›". It opens
 * Learn with the search filled. No knowledge is ever among the listings; the Market's pills, rows, grid and counts are untouched.
 *
 * The phone counts from its own copy of the pages (utils/learn-copy.ts), so it needs no request and works offline. A copy that
 * can't be read, a community with Learn off (or only previewed), and no match all draw nothing: never an error.
 */
import React, { useEffect, useState } from 'react';
import { DeviceEventEmitter, Pressable, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { t } from '@beanpool/core';
import { useStyles } from '../../app/ThemeContext';
import { getKnowledgePosts } from '../../utils/db';
import { learnSearch } from '../../utils/learn-copy';
import { useLearnMode } from '../../utils/use-learn-mode';
import { LEARN_LINES } from './learn-lines';

/** The pause after the last key before the copy is read, so typing doesn't read it on every letter. */
export const MARKET_LEARN_LINE_DELAY_MS = 250;

export function MarketLearnLine({ words }: { words: string }) {
    const mode = useLearnMode();
    const [count, setCount] = useState(0);
    const typed = words.trim();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        line: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
        text: { fontSize: 14, fontWeight: '700', color: colors.chip.learn.fg },
    }));

    useEffect(() => {
        if (mode !== 'live' || !typed) { setCount(0); return; }
        let cancelled = false;
        const read = () => {
            // Inside a promise, so a copy that cannot be read at all (a call that throws before it returns) is no page either.
            Promise.resolve()
                .then(() => getKnowledgePosts())
                .then((pages) => { if (!cancelled) setCount(learnSearch(pages, typed).total); })
                .catch(() => { if (!cancelled) setCount(0); });
        };
        const timer = setTimeout(read, MARKET_LEARN_LINE_DELAY_MS);
        // A sync or a pushed change (a take-down) changes the copy under words already typed: count again (review of #3070).
        const sub = DeviceEventEmitter.addListener('sync_data_updated', read);
        return () => { cancelled = true; clearTimeout(timer); sub.remove(); };
    }, [mode, typed]);

    if (mode !== 'live' || !typed || count < 1) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('In Learn: {n} for "{words}". Opens Learn.', { n: count, words: typed })}
            onPress={() => router.push({ pathname: '/learn', params: { q: typed } } as any)}
            style={styles.line}
            testID="market-learn-line"
        >
            <Text style={styles.text} numberOfLines={2}>{t(LEARN_LINES.marketLine, { n: count, words: typed })}</Text>
        </Pressable>
    );
}
