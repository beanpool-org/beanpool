import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import type { BeanPoolIdentity } from '../../utils/identity';
import {
    communityFacts, communityLabel, findCardNamed, findCommunityCardCopy, nearbyPostsLine, notAnsweringLine, watchPlace, type DirectoryCommunity, type GlobalHome, type Point,
} from '../../utils/community-directory';
import { FIND_COMMUNITY_WORDS, TYPE_YOUR_TOWN, findCommunityState, t } from '@beanpool/core';
import { cardKnockLines, readKnockStatus, type KnockStatusResult, type RememberedKnock } from '../../utils/knock';
import { FabAware, HomeButton, HomeLink, homeStyles } from './HomeParts';

/** Shown through t() in the member's language. */
const LINKS = { typeTown: TYPE_YOUR_TOWN };

/**
 * "Find your community" (design §3.1, §7) as a Home card on the global node (slice H4): the way out of the worldwide
 * community to a local one. What the Market drew above its feed before H4, now drawn from Home's own answer (its `find`
 * card is GET /api/global/home's body, assembled in-process), so it costs no request of its own; the screen checks its
 * rows first (utils/community-directory.ts `readGlobalHome`). The answers to this phone's own knocks are still read from
 * the communities it asked, and only those.
 *
 * Three actions, each 48dp tall and wrapping rather than shrinking: communities near you, start one, or be told when one
 * starts here. They report where they rest to Home's floating "+ ADD POST" (FabAware), which steps aside for them.
 * With no place yet, one quiet link under them, "or type your town ›" (Marty, 14 Oct): Home's own trailing link (48dp, and
 * the "+ ADD POST" steps aside for it too), opening the find screen with its town box open.
 */
export function FindCommunityBody({ home, knocks, identity, nodeUrl, point, colors }: {
    home: GlobalHome;
    /** The knocks this phone sent for the account, newest first (utils/knock.ts `rememberedKnocks`). */
    knocks: readonly RememberedKnock[];
    identity: BeanPoolIdentity | null;
    /** The community Home is read from (the global node): where a place watch is kept. */
    nodeUrl: string | null;
    /** Where "here" is for a place watch: the phone's place, else the account's own area; null: the screen asks. */
    point: Point | null;
    colors: AppColors;
}) {
    const s = homeStyles(colors);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [watched, setWatched] = useState(false);

    // Only the communities this phone asked, once per knock it remembers.
    const knockKey = knocks.map(k => k.url).join(' ');
    useEffect(() => {
        if (!identity || !knocks.length) return;
        let alive = true;
        knocks.forEach(k => readKnockStatus(k.url, identity).then(r => { if (alive) setStatuses(was => ({ ...was, [k.url]: r })); }));
        return () => { alive = false; };
    }, [knockKey, identity?.publicKey]);

    const copy = findCommunityCardCopy({ ok: true, value: home }, !!point);
    const named = findCardNamed(home);
    const nearby = nearbyPostsLine(home);
    const others = home.communities.slice(1, 3);
    // Gone quiet for more than 36 h: said under the community the sentence names and under each row after it, as the
    // web's card says it under its rows and the find screen under its own (front doors S13).
    const quietLine = (c: DirectoryCommunity) => {
        const quiet = notAnsweringLine(c);
        return quiet ? <Text style={[s.rowSub, { fontStyle: 'italic' }]} testID={`home-find-not-answering-${c.key}`}>{quiet}</Text> : null;
    };
    const lines = cardKnockLines(knocks, statuses);
    const watching = watched || (home.watches?.length ?? 0) > 0;
    // Nothing listed near (and the list loaded): Start a community leads, as the web's card does (rehearsal B2).
    const state = findCommunityState(home);
    const startFirst = state === 'none' || state === 'far';
    const start = (
        <HomeButton key="start" primary={startFirst} colors={colors} text={t(FIND_COMMUNITY_WORDS.start)} onPress={() => router.push('/start-community')} testID="home-find-start" />
    );

    const tellMe = async () => {
        if (!point || !identity) { router.push('/find-community'); return; }
        const r = await watchPlace(identity, point, nodeUrl ?? undefined);
        if (r.ok) setWatched(true);
        setWatchNote(r.ok ? t("Done. You'll be told when a community starts near here.") : r.message);
    };

    return (
        <>
            <Text style={[s.rowLine, { marginBottom: 4 }]}>{copy.body}</Text>
            {!!named && quietLine(named)}
            {others.map(c => (
                <React.Fragment key={c.key}>
                    <Text style={s.rowSub} numberOfLines={2}>
                        {communityLabel(c)}{communityFacts(c) ? ` · ${communityFacts(c)}` : ''}
                    </Text>
                    {quietLine(c)}
                </React.Fragment>
            ))}
            {!!nearby && <Text style={[s.rowSub, { marginTop: 4 }]} testID="home-find-nearby">{nearby}</Text>}
            {lines.map(l => (
                <Text key={l.url} style={[s.rowLine, s.rowStrong, { marginTop: 6 }]}>{l.invited ? '🎉 ' : '⏳ '}{l.text}</Text>
            ))}
            {!!watchNote && <Text style={[s.rowLine, { marginTop: 6 }]} accessibilityLiveRegion="polite" testID="home-find-watch-note">{watchNote}</Text>}
            <FabAware id="find:actions" style={s.buttonRow}>
                {startFirst && start}
                <HomeButton primary={!startFirst} colors={colors} text={t('Communities near you')} onPress={() => router.push('/find-community')} testID="home-find-near" />
                {!startFirst && start}
                {!watching && (
                    <HomeButton colors={colors} text={t('Tell me when one starts here')} a11y={t('Tell me when a community starts near here')}
                        onPress={() => void tellMe()} testID="home-find-watch" />
                )}
            </FabAware>
            {!point && (
                <HomeLink id="find:town" colors={colors} text={t(LINKS.typeTown)} a11y={t('Or type your town, to see the communities near it')}
                    onPress={() => router.push({ pathname: '/find-community', params: { town: '1' } })} testID="home-find-type-town" />
            )}
        </>
    );
}
