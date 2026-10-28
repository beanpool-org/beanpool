import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import type { BeanPoolIdentity } from '../../utils/identity';
import {
    communityFacts, communityLabel, communityOrigin, findCardNamed, findCommunityCardCopy, nearbyPostsLine, notAnsweringLine, watchPlace, type DirectoryCommunity, type GlobalHome, type Point,
} from '../../utils/community-directory';
import { FIND_COMMUNITY_WORDS, TYPE_YOUR_TOWN, communityAnswersLine, findCommunityState, formatDate, t } from '@beanpool/core';
import { cancelKnock, cardKnockLines, knockCardState, readKnockStatus, type KnockStatusResult, type RememberedKnock } from '../../utils/knock';
import { findLineWords } from '../find-community-lines';
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
export function FindCommunityBody({ home, knocks, identity, nodeUrl, point, colors, onKnocksChange }: {
    home: GlobalHome;
    /** The knocks this phone sent for the account, newest first (utils/knock.ts `rememberedKnocks`). */
    knocks: readonly RememberedKnock[];
    identity: BeanPoolIdentity | null;
    /** The community Home is read from (the global node): where a place watch is kept. */
    nodeUrl: string | null;
    /** Where "here" is for a place watch: the phone's place, else the account's own area; null: the screen asks. */
    point: Point | null;
    colors: AppColors;
    onKnocksChange?: (knocks: RememberedKnock[]) => void;
}) {
    const s = homeStyles(colors);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [watched, setWatched] = useState(false);
    const [activeKnocks, setActiveKnocks] = useState<readonly RememberedKnock[]>(knocks);
    /** The list as it is now, for a cancel that finishes after another one did (a press handler's closure is older). */
    const latestKnocks = useRef<readonly RememberedKnock[]>(knocks);
    const showKnocks = (list: readonly RememberedKnock[]) => { latestKnocks.current = list; setActiveKnocks(list); };
    /** Every cancel still out: two waiting cards are normal, and each one's button is its own. */
    const [cancellingUrls, setCancellingUrls] = useState<ReadonlySet<string>>(() => new Set());
    /** Why a cancel failed, kept under the knock it was for (by its URL): one community's failure is not another's. */
    const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        showKnocks(knocks);
    }, [knocks]);

    // Only the communities this phone asked, once per knock it remembers.
    const knockKey = activeKnocks.map(k => k.url).join(' ');
    useEffect(() => {
        if (!identity || !activeKnocks.length) return;
        let alive = true;
        activeKnocks.forEach(k => readKnockStatus(k.url, identity).then(r => { if (alive) setStatuses(was => ({ ...was, [k.url]: r })); }));
        return () => { alive = false; };
    }, [knockKey, identity?.publicKey]);

    const onCancelKnock = (k: RememberedKnock) => {
        if (!identity) return;
        const comm = home.communities.find(c => (k.key && c.key === k.key) || (c.url && communityOrigin(c.url) === k.url));
        const name = k.name ?? comm?.name ?? k.url.replace(/^https:\/\//, '');
        Alert.alert(
            t(FIND_COMMUNITY_WORDS.cancelRequest),
            t(FIND_COMMUNITY_WORDS.cancelConfirmText, { name }),
            [
                { text: t(FIND_COMMUNITY_WORDS.keepIt), style: 'cancel' },
                {
                    text: t(FIND_COMMUNITY_WORDS.cancelRequest),
                    style: 'destructive',
                    onPress: async () => {
                        setCancellingUrls(was => new Set(was).add(k.url));
                        setCancelErrors(was => Object.fromEntries(Object.entries(was).filter(([url]) => url !== k.url)));
                        const res = await cancelKnock(k.url, identity);
                        // `not_found` is the node's answer to every standing but an open request: it lapsed, it was cancelled
                        // elsewhere, or a member said yes after this card read it. The node is asked what it holds now, never
                        // told, and the button stays busy meanwhile.
                        const reread = !res.ok && res.status === 404 && res.code === 'not_found'
                            ? await readKnockStatus(k.url, identity)
                            : null;
                        setCancellingUrls(was => { const left = new Set(was); left.delete(k.url); return left; });
                        if (res.ok) {
                            const next = latestKnocks.current.filter(item => item.url !== k.url);
                            showKnocks(next);
                            onKnocksChange?.(next as RememberedKnock[]);
                        } else {
                            if (reread) setStatuses(was => ({ ...was, [k.url]: reread }));
                            setCancelErrors(was => ({ ...was, [k.url]: res.message }));
                        }
                    },
                },
            ],
        );
    };

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
            {activeKnocks.map(k => {
                const comm = home.communities.find(c => (k.key && c.key === k.key) || (c.url && communityOrigin(c.url) === k.url));
                const name = k.name ?? comm?.name ?? k.url.replace(/^https:\/\//, '');
                const status = statuses[k.url];
                const sentDate = formatDate(new Date(k.sentAt), 'day-month-year');
                const answersLine = communityAnswersLine(comm?.answers);
                const isCancelling = cancellingUrls.has(k.url);

                if (status?.ok && status.value.status === 'approved') {
                    const approved = cardKnockLines([k], statuses)[0];
                    return (
                        <Text key={k.url} style={[s.rowLine, s.rowStrong, { marginTop: 6 }]} testID={`home-find-invited-${k.url}`}>
                            {'🎉 ' + (approved?.text ?? '')}
                        </Text>
                    );
                }

                // What the community now says, as MyJoinRequests reads it: only a waiting request arrived and can be taken
                // back. Nothing open there (`none`), or an answer that could not be read, is said as it is, with no Cancel.
                const state = knockCardState(true, true, status);
                const waiting = state.kind === 'waiting';
                let arrivedLine: string;
                if (state.kind === 'checking') arrivedLine = t('Checking…');
                else if (waiting) arrivedLine = t(FIND_COMMUNITY_WORDS.requestArrived);
                else arrivedLine = 'note' in state && state.note ? findLineWords(state.note) : '';

                return (
                    <View key={k.url} style={[s.card, { marginHorizontal: 0, marginTop: 8, marginBottom: 8, paddingVertical: 10 }]} testID={`home-find-waiting-${k.url}`}>
                        <Text style={[s.rowLine, s.rowStrong]} testID={`home-find-waiting-sent-${k.url}`}>
                            {t(FIND_COMMUNITY_WORDS.askedOnDate, { name, date: sentDate })}
                        </Text>
                        <Text style={[s.rowSub, { marginTop: 4 }]} testID={`home-find-waiting-arrived-${k.url}`}>
                            {arrivedLine}
                        </Text>
                        {!!answersLine && (
                            <Text style={[s.rowSub, { marginTop: 4, fontStyle: 'italic' }]} testID={`home-find-waiting-answers-${k.url}`}>
                                {answersLine}
                            </Text>
                        )}
                        {waiting && (
                            <View style={{ marginTop: 8 }}>
                                <HomeButton
                                    colors={colors}
                                    text={isCancelling ? t(FIND_COMMUNITY_WORDS.cancelling) : t(FIND_COMMUNITY_WORDS.cancelRequest)}
                                    a11y={isCancelling ? t(FIND_COMMUNITY_WORDS.cancelling) : t(FIND_COMMUNITY_WORDS.cancelRequest)}
                                    busy={isCancelling}
                                    onPress={() => onCancelKnock(k)}
                                    testID={`home-find-cancel-${k.url}`}
                                />
                            </View>
                        )}
                        {!!cancelErrors[k.url] && (
                            <Text style={[s.rowSub, { marginTop: 4, color: colors.feedback.danger.fg }]} accessibilityLiveRegion="polite" testID={`home-find-cancel-error-${k.url}`}>
                                {findLineWords(cancelErrors[k.url])}
                            </Text>
                        )}
                    </View>
                );
            })}
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
