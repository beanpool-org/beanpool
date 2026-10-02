import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import type { BeanPoolIdentity } from '../../utils/identity';
import {
    communityFacts, communityLabel, findCommunityCardCopy, nearbyPostsLine, watchPlace, type GlobalHome, type Point,
} from '../../utils/community-directory';
import { cardKnockLines, readKnockStatus, type KnockStatusResult, type RememberedKnock } from '../../utils/knock';
import { FabAware, HomeButton, homeStyles } from './HomeParts';

/**
 * "Find your community" (design §3.1, §7) as a Home card on the global node (slice H4): the way out of the worldwide
 * community to a local one. What the Market drew above its feed before H4, now drawn from Home's own answer (its `find`
 * card is GET /api/global/home's body, assembled in-process), so it costs no request of its own; the screen checks its
 * rows first (utils/community-directory.ts `readGlobalHome`). The answers to this phone's own knocks are still read from
 * the communities it asked, and only those.
 *
 * Three actions, each 48dp tall and wrapping rather than shrinking: communities near you, start one, or be told when one
 * starts here. They report where they rest to Home's floating "+ ADD POST" (FabAware), which steps aside for them.
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
    const nearby = nearbyPostsLine(home);
    const others = home.communities.slice(1, 3);
    const lines = cardKnockLines(knocks, statuses);
    const watching = watched || (home.watches?.length ?? 0) > 0;

    const tellMe = async () => {
        if (!point || !identity) { router.push('/find-community'); return; }
        const r = await watchPlace(identity, point, nodeUrl ?? undefined);
        if (r.ok) setWatched(true);
        setWatchNote(r.ok ? "Done. You'll be told when a community starts near here." : r.message);
    };

    return (
        <>
            <Text style={[s.rowLine, { marginBottom: 4 }]}>{copy.body}</Text>
            {others.map(c => (
                <Text key={c.key} style={s.rowSub} numberOfLines={2}>
                    {communityLabel(c)}{communityFacts(c) ? ` · ${communityFacts(c)}` : ''}
                </Text>
            ))}
            {!!nearby && <Text style={[s.rowSub, { marginTop: 4 }]} testID="home-find-nearby">{nearby}</Text>}
            {lines.map(l => (
                <Text key={l.url} style={[s.rowLine, s.rowStrong, { marginTop: 6 }]}>{l.invited ? '🎉 ' : '⏳ '}{l.text}</Text>
            ))}
            {!!watchNote && <Text style={[s.rowLine, { marginTop: 6 }]} accessibilityLiveRegion="polite" testID="home-find-watch-note">{watchNote}</Text>}
            <FabAware id="find:actions" style={s.buttonRow}>
                <HomeButton primary colors={colors} text="Communities near you" onPress={() => router.push('/find-community')} testID="home-find-near" />
                <HomeButton colors={colors} text="Start a community" onPress={() => router.push('/start-community')} testID="home-find-start" />
                {!watching && (
                    <HomeButton colors={colors} text="Tell me when one starts here" a11y="Tell me when a community starts near here"
                        onPress={() => void tellMe()} testID="home-find-watch" />
                )}
            </FabAware>
        </>
    );
}
