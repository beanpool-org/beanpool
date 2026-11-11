/**
 * The row card: Learn's one row shape (DESIGN-local-knowledge-fable.md §3.1, kept by the amendment) on its front, in a topic,
 * in a search, and later on the Home card and the Pulse card. The whole card opens the page (small cards open the item, Marty
 * 4 Nov); it names nobody. Photo or the topic's full-colour tile (64 dp) · chip row (the topic in capitals, 📌 PINNED,
 * MAY BE OUT OF DATE in amber) · title (2 lines) · the first line of the body (1 line) · "Checked Nov 2026 · Helped 12"
 * ("Helped" from 1; "Checked over a year ago" in amber). Spoken: "Local knowledge: {title}, checked {month year}".
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { inCapitalsOf, t, type KnowledgeRow } from '@beanpool/core';
import { useStyles } from '../../app/ThemeContext';
import { ListPhoto } from '../ListPhoto';
import { LEARN_LINES, checkedOverAYearAgo, monthYear, topicOf } from './learn-lines';

const TILE = 64;

/** The topic's full-colour picture, drawn from the central teal role in light and dark: the topic's emoji on its ground. */
export function TopicTile({ topic, size = TILE, testID = 'topic-tile' }: { topic: string; size?: number; testID?: string }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.chip.learn.bg, borderRadius: 12 },
    }));
    return (
        <View style={[styles.tile, { width: size, height: size }]} testID={testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={{ fontSize: Math.round(size * 0.5) }}>{topicOf(topic).emoji}</Text>
        </View>
    );
}

export function KnowledgeRowCard({ row, onPress, now, testID }: { row: KnowledgeRow; onPress: () => void; now?: number; testID?: string }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: {
            flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, minHeight: 88,
            backgroundColor: colors.surface.card, borderColor: colors.border.default,
        },
        picture: { width: TILE, height: TILE, borderRadius: 12, overflow: 'hidden' },
        body: { flex: 1, minWidth: 0, gap: 3 },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
        title: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        line: { fontSize: 13.5, color: colors.text.body },
        foot: { fontSize: 12, color: colors.text.secondary },
        footOld: { fontSize: 12, fontWeight: '700', color: colors.feedback.warning.fg },
    }));
    const topic = topicOf(row.topic);
    const when = monthYear(row.checkedAt);
    const old = checkedOverAYearAgo(row.checkedAt, now);
    const checked = old ? t(LEARN_LINES.checkedOver) : when ? t(LEARN_LINES.checked, { date: when }) : '';
    const helped = row.helped > 0 ? t(LEARN_LINES.helped, { n: row.helped }) : '';
    const foot = checked && helped ? t(LEARN_LINES.checkedHelped, { checked, helped }) : checked || helped;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={when
                ? t('Local knowledge: {title}, checked {date}', { title: row.title, date: when })
                : t('Local knowledge: {title}', { title: row.title })}
            onPress={onPress}
            style={styles.card}
            testID={testID ?? `learn-row-${row.id}`}
        >
            <View style={styles.picture}>
                <ListPhoto photo={row.photo} fallback={<TopicTile topic={row.topic} />} style={{ width: TILE, height: TILE }} contentFit="cover" />
            </View>
            <View style={styles.body}>
                <View style={styles.chips}>
                    <ChipText bg="learn">{inCapitalsOf(t(topic.label))}</ChipText>
                    {row.pinned ? <ChipText bg="learn">{t(LEARN_LINES.pinned)}</ChipText> : null}
                    {row.outdated ? <ChipText bg="amber">{t(LEARN_LINES.outdatedChip)}</ChipText> : null}
                </View>
                <Text style={styles.title} numberOfLines={2}>{row.title}</Text>
                {row.line ? <Text style={styles.line} numberOfLines={1}>{row.line}</Text> : null}
                <Text style={old ? styles.footOld : styles.foot} numberOfLines={2}>
                    {foot}
                </Text>
            </View>
        </Pressable>
    );
}

/** A small chip: Learn's teal, or amber for the out-of-date mark (amber keeps meaning caution). */
export function ChipText({ children, bg }: { children: React.ReactNode; bg: 'learn' | 'amber' }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        learn: { backgroundColor: colors.chip.learn.bg },
        amber: { backgroundColor: colors.feedback.warning.bg },
        learnText: { color: colors.chip.learn.fg },
        amberText: { color: colors.feedback.warning.fg },
        chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
        text: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4 },
    }));
    return (
        <View style={[styles.chip, bg === 'learn' ? styles.learn : styles.amber]}>
            <Text style={[styles.text, bg === 'learn' ? styles.learnText : styles.amberText]}>{children}</Text>
        </View>
    );
}
