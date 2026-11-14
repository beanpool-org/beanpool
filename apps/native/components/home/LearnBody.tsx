/**
 * "Learn something local" on Home (DESIGN-local-knowledge-amend-fable.md §3.6, slice K7): what core's `learnHomeLines` says to
 * draw, the same as the web's card. An owner's or admin's amber "N to check ›" row first, where this app opens To check; "Add
 * the first thing worth knowing about {community}" where it opens the form and Learn shows nothing; then up to three of the
 * day's pages in Learn's own row card, the newest of the last 14 days led by "NEW", each opening its page; "See all ›" (spoken
 * "See all of Learn") opens Learn. While the card arrives on a Home its member already arranged, "Keep on Home" keeps it.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { LEARN_HOME_WORDS, t, tn, formatCount, type LearnHomeLines } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { KnowledgeRowCard } from '../learn/KnowledgeRowCard';
import { FabAware, HomeButton, HomeLink, HomeRow } from './HomeParts';

export function LearnBody({ lines, community, colors, now, onOpen, onSeeAll, onToCheck, onAddFirst, onKeep }: {
    lines: LearnHomeLines;
    /** The community's name, for "Add the first thing worth knowing about {community}". */
    community: string;
    colors: AppColors;
    now?: number;
    onOpen: (id: string) => void;
    onSeeAll: () => void;
    onToCheck?: () => void;
    onAddFirst?: () => void;
    /** Only while the card arrives (core `arrivingCards`): Keep on Home puts it on the member's list. */
    onKeep?: () => void;
}) {
    const toCheck = lines.toCheck > 0 ? tn(lines.toCheck, LEARN_HOME_WORDS.toCheck.one, LEARN_HOME_WORDS.toCheck.other, { n: formatCount(lines.toCheck) }) : '';
    const first = lines.first ? t(LEARN_HOME_WORDS.first, { community }) : '';
    return (
        <>
            {!!toCheck && onToCheck && (
                <HomeRow
                    colors={colors}
                    text={toCheck}
                    a11y={toCheck}
                    strong
                    onPress={onToCheck}
                    testID="home-learn-check"
                    // Never colour alone: the amber is a ▲ too, as Needs you draws it. Its style inline (homeStyles' `trailing`),
                    // where the contrast check reads the colour: s.* from homeStyles is a table it cannot follow.
                    left={<Text style={{ fontSize: 13, fontWeight: '700', flexShrink: 0, width: 14, color: colors.feedback.warning.fg }} importantForAccessibility="no">▲</Text>}
                />
            )}
            {!!first && onAddFirst && <HomeRow colors={colors} text={`${first} ›`} a11y={first} strong onPress={onAddFirst} testID="home-learn-first" />}
            {lines.rows.length > 0 && (
                <View style={{ gap: 8, marginTop: 2 }}>
                    {lines.rows.map(row => (
                        <KnowledgeRowCard key={row.id} row={row} fresh={row.isNew === true} now={now} onPress={() => onOpen(row.id)} testID={`home-learn-${row.id}`} />
                    ))}
                </View>
            )}
            {lines.rows.length > 0 && (
                <HomeLink id="learn:all" colors={colors} text={t('See all')} a11y={t(LEARN_HOME_WORDS.seeAllSpoken)} onPress={onSeeAll} testID="home-learn-all" />
            )}
            {onKeep && (
                <FabAware id="learn:keep" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 4 }}>
                    <HomeButton colors={colors} text={t(LEARN_HOME_WORDS.keep)} onPress={onKeep} testID="home-learn-keep" />
                </FabAware>
            )}
        </>
    );
}
