import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import type { BeanPoolIdentity } from '../../utils/identity';
import {
    communityFacts, communityLabel, communityOrigin, findCardNamed, findCommunityCardCopy, nearbyPostsLine, notAnsweringLine, watchPlace, type DirectoryCommunity, type GlobalHome, type Point,
} from '../../utils/community-directory';
import { FIND_COMMUNITY_WORDS, PLACE_CIRCLE_WORDS, TYPE_YOUR_TOWN, circleDemandLine, circleWaitingLine, communityAnswersLine, findCommunityState, formatDate, t } from '@beanpool/core';
import { KNOCK_MESSAGES, cancelKnock, cardKnockLines, forgetKnock, knockCardState, readKnockStatus, rememberedKnocks, type KnockStatusResult, type RememberedKnock } from '../../utils/knock';
import { knockForCircle } from '../../utils/circle-intent';
import { PlaceCircleCard } from '../PlaceCircleCard';
import { findLineWords } from '../find-community-lines';
import { openLookDoor } from '../../utils/look-door';
import { FabAware, HomeButton, HomeLink, homeStyles } from './HomeParts';

/** Shown through t() in the member's language. */
const LINKS = { typeTown: TYPE_YOUR_TOWN };

/**
 * What the card's per-request state is kept under. A community's URL is not enough: asking the same community again (after
 * a Cancel, or a Got it) gives a new request with a new `sentAt` under the same URL, and the Home tab stays mounted, so
 * state kept by URL would tell the member the new request is cancelled or closed.
 */
const requestKey = (k: RememberedKnock) => `${k.url} ${k.sentAt}`;

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
export function FindCommunityBody({ home, knocks, identity, nodeUrl, point, colors, onKnocksChange, onCancelled }: {
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
    /**
     * A Cancel worked on this request. Home keeps it in `knocks`, and so keeps the card, its line and the pin, until Home
     * loses focus, however often it reads the phone's memory meanwhile (where the knock is no longer listed).
     */
    onCancelled?: (knock: RememberedKnock) => void;
}) {
    const s = homeStyles(colors);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [watched, setWatched] = useState(false);
    const [helped, setHelped] = useState(false);
    /** The circle as this visit last heard it: "I'm starting one here" answers with the card. */
    const [circle, setCircle] = useState(home.circle ?? null);
    const [activeKnocks, setActiveKnocks] = useState<readonly RememberedKnock[]>(knocks);
    /** The list as it is now, for a cancel that finishes after another one did (a press handler's closure is older). */
    const latestKnocks = useRef<readonly RememberedKnock[]>(knocks);
    const showKnocks = (list: readonly RememberedKnock[]) => { latestKnocks.current = list; setActiveKnocks(list); };
    /** Every cancel still out (by `requestKey`): two waiting cards are normal, and each one's button is its own. */
    const [cancellingRequests, setCancellingRequests] = useState<ReadonlySet<string>>(() => new Set());
    /** Why a cancel failed, kept under the request it was for (by `requestKey`): one community's failure is not another's, nor a later request's. */
    const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({});
    /**
     * The requests whose Cancel worked in this Home visit (by `requestKey`): their cards stay, with the cancelled line and
     * no button. Held here, never stored: the next visit reads the phone's memory, where `cancelKnock` has already marked the
     * knock cancelled, and the card is not drawn. A later request to the same community is a new key, so it is not marked.
     */
    const [cancelledRequests, setCancelledRequests] = useState<ReadonlySet<string>>(() => new Set());

    useEffect(() => {
        showKnocks(knocks);
    }, [knocks]);

    useEffect(() => setCircle(home.circle ?? null), [home.circle]);

    // A community retired this phone's circle, and the member asked to join when one started: this phone asks, once.
    const retiredBy = home.circle?.community?.key;
    useEffect(() => {
        if (!identity || !home.circle || !retiredBy) return;
        let alive = true;
        void knockForCircle(identity, home.circle).then(async sent => {
            if (sent && alive) onKnocksChange?.(await rememberedKnocks(identity.publicKey));
        });
        return () => { alive = false; };
    }, [identity?.publicKey, home.circle?.id, retiredBy]);

    // Only the communities this phone asked, once per request it remembers (a new request to the same community is read anew).
    const knockKey = activeKnocks.map(requestKey).join(' ');
    useEffect(() => {
        if (!identity || !activeKnocks.length) return;
        let alive = true;
        activeKnocks.forEach(k => readKnockStatus(k.url, identity).then(r => { if (alive) setStatuses(was => ({ ...was, [requestKey(k)]: r })); }));
        return () => { alive = false; };
    }, [knockKey, identity?.publicKey]);

    const onCancelKnock = (k: RememberedKnock) => {
        if (!identity) return;
        const rk = requestKey(k);
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
                        setCancellingRequests(was => new Set(was).add(rk));
                        setCancelErrors(was => Object.fromEntries(Object.entries(was).filter(([key]) => key !== rk)));
                        const res = await cancelKnock(k.url, identity);
                        // `not_found` is the node's answer to every standing but an open request: it lapsed, it was cancelled
                        // elsewhere, or a member said yes after this card read it. The node is asked what it holds now, never
                        // told, and the button stays busy meanwhile.
                        const reread = !res.ok && res.status === 404 && res.code === 'not_found'
                            ? await readKnockStatus(k.url, identity)
                            : null;
                        setCancellingRequests(was => { const left = new Set(was); left.delete(rk); return left; });
                        if (res.ok) {
                            // The card stays and says so. Home is told, and keeps this request in its list for the visit, so
                            // neither the card nor Find vanishes under the line that says what happened.
                            setCancelledRequests(was => new Set(was).add(rk));
                            onCancelled?.(k);
                        } else {
                            if (reread) setStatuses(was => ({ ...was, [rk]: reread }));
                            setCancelErrors(was => ({ ...was, [rk]: res.message }));
                        }
                    },
                },
            ],
        );
    };

    /**
     * "Got it" on a request the community says it no longer holds: the phone forgets the knock, the card goes, and Home is
     * told the list without it, so the pin it held can go (a request nothing holds pins Find until this, or day 61).
     */
    const onGotIt = async (k: RememberedKnock) => {
        if (!identity) return;
        await forgetKnock(identity.publicKey, k.url);
        const next = latestKnocks.current.filter(item => item.url !== k.url);
        showKnocks(next);
        onKnocksChange?.(next as RememberedKnock[]);
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

    /**
     * Communities near you, with its town box open or not. A visitor looking around with no key (no `identity`) goes to the
     * door, as the root guard sent these taps before S3: Find a community, which a phone with no account may now open to ask
     * by an address, shows neither the list, nor a town, nor a watch until there is an account. The door opens as the
     * guard opened it and every other visitor door does, as the only screen, so its Back returns to the look.
     */
    const openFind = (town?: boolean) => {
        if (!identity) { openLookDoor(); return; }
        router.push(town ? { pathname: '/find-community', params: { town: '1' } } : '/find-community');
    };

    const tellMe = async () => {
        if (!point || !identity) { openFind(); return; }
        const r = await watchPlace(identity, point, nodeUrl ?? undefined);
        if (r.ok) setWatched(true);
        setWatchNote(r.ok ? t("Done. You'll be told when a community starts near here.") : r.message);
    };

    /** "I'd help start one here": a watch on this cell, with the one flag (the place circle). */
    const wouldHelp = async () => {
        if (!point || !identity) { openFind(); return; }
        const r = await watchPlace(identity, point, nodeUrl ?? undefined, { wouldHelp: true });
        if (r.ok) { setWatched(true); setHelped(true); }
        setWatchNote(r.ok ? t(PLACE_CIRCLE_WORDS.helpDone) : r.message);
    };
    const helping = helped || !!home.watches?.some(w => w.wouldHelp);
    // Said where nothing is near, and only until the person is in a circle: from then on the circle's own count says it.
    const demandLine = startFirst && !circle ? circleDemandLine(home.demand) : null;

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
            {!!demandLine && <Text style={[s.rowLine, { marginTop: 4 }]} testID="home-find-demand">{demandLine}</Text>}
            {!!circle && <PlaceCircleCard id={circle.id} circle={circle} identity={identity} nodeUrl={nodeUrl} colors={colors} onChange={card => setCircle({ ...card, id: circle.id })} />}
            {activeKnocks.map(k => {
                const comm = home.communities.find(c => (k.key && c.key === k.key) || (c.url && communityOrigin(c.url) === k.url));
                const name = k.name ?? comm?.name ?? k.url.replace(/^https:\/\//, '');
                const rk = requestKey(k);
                const status = statuses[rk];
                const sentDate = formatDate(new Date(k.sentAt), 'day-month-year');
                const answersLine = communityAnswersLine(comm?.answers);
                const isCancelling = cancellingRequests.has(rk);
                const cancelled = cancelledRequests.has(rk);

                if (!cancelled && status?.ok && status.value.status === 'approved') {
                    const approved = cardKnockLines([k], { [k.url]: status })[0];
                    return (
                        <Text key={k.url} style={[s.rowLine, s.rowStrong, { marginTop: 6 }]} testID={`home-find-invited-${k.url}`}>
                            {'🎉 ' + (approved?.text ?? '')}
                        </Text>
                    );
                }

                // What the community now says, as MyJoinRequests reads it: only a waiting request arrived and can be taken
                // back. An answer that could not be read is said as it is, with no Cancel. Nothing open there (`none`:
                // lapsed, cancelled elsewhere, an invite that expired) is the closed card: its three lines and "Got it",
                // which forgets the request (decided 29 Oct 2026).
                const state = knockCardState(true, true, status);
                const waiting = state.kind === 'waiting';
                const closed = status?.ok === true && status.value.status === 'none';
                let arrivedLine: string;
                if (state.kind === 'checking') arrivedLine = t('Checking…');
                else if (waiting) arrivedLine = t(FIND_COMMUNITY_WORDS.requestArrived);
                else arrivedLine = 'note' in state && state.note ? findLineWords(state.note) : '';

                return (
                    <View key={k.url} style={[s.card, { marginHorizontal: 0, marginTop: 8, marginBottom: 8, paddingVertical: 10 }]} testID={`home-find-waiting-${k.url}`}>
                        <Text style={[s.rowLine, s.rowStrong]} testID={`home-find-waiting-sent-${k.url}`}>
                            {t(FIND_COMMUNITY_WORDS.askedOnDate, { name, date: sentDate })}
                        </Text>
                        {cancelled ? (
                            // Said once, under the sent line, for this visit; polite, so a screen reader hears it without losing its place.
                            <Text style={[s.rowSub, { marginTop: 4 }]} accessibilityLiveRegion="polite" testID={`home-find-waiting-cancelled-${k.url}`}>
                                {t(KNOCK_MESSAGES.cancelled)}
                            </Text>
                        ) : (
                            <Text style={[s.rowSub, { marginTop: 4 }]} testID={`home-find-waiting-arrived-${k.url}`}>
                                {arrivedLine}
                            </Text>
                        )}
                        {!!answersLine && !cancelled && !closed && (
                            <Text style={[s.rowSub, { marginTop: 4, fontStyle: 'italic' }]} testID={`home-find-waiting-answers-${k.url}`}>
                                {answersLine}
                            </Text>
                        )}
                        {waiting && !cancelled && !circle && !!circleWaitingLine(home.demand) && (
                            <Text style={[s.rowSub, { marginTop: 4 }]} testID={`home-find-waiting-near-${k.url}`}>{circleWaitingLine(home.demand)}</Text>
                        )}
                        {closed && !cancelled && (
                            <View style={{ marginTop: 8 }}>
                                <HomeButton
                                    colors={colors}
                                    text={t(FIND_COMMUNITY_WORDS.gotIt)}
                                    onPress={() => void onGotIt(k)}
                                    testID={`home-find-gotit-${k.url}`}
                                />
                            </View>
                        )}
                        {waiting && !cancelled && !circle && !!circleWaitingLine(home.demand) && (
                            <View style={{ marginTop: 8 }}>
                                <HomeButton colors={colors} text={t(PLACE_CIRCLE_WORDS.meetThem)} onPress={() => openFind()} testID={`home-find-meet-${k.url}`} />
                            </View>
                        )}
                        {waiting && !cancelled && (
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
                        {!!cancelErrors[rk] && (
                            <Text style={[s.rowSub, { marginTop: 4, color: colors.feedback.danger.fg }]} accessibilityLiveRegion="polite" testID={`home-find-cancel-error-${k.url}`}>
                                {findLineWords(cancelErrors[rk])}
                            </Text>
                        )}
                    </View>
                );
            })}
            {!!watchNote && <Text style={[s.rowLine, { marginTop: 6 }]} accessibilityLiveRegion="polite" testID="home-find-watch-note">{watchNote}</Text>}
            <FabAware id="find:actions" style={s.buttonRow}>
                {startFirst && start}
                <HomeButton primary={!startFirst} colors={colors} text={t('Communities near you')} onPress={() => openFind()} testID="home-find-near" />
                {!startFirst && start}
                {!watching && (
                    <HomeButton colors={colors} text={t('Tell me when one starts here')} a11y={t('Tell me when a community starts near here')}
                        onPress={() => void tellMe()} testID="home-find-watch" />
                )}
                {startFirst && !circle && !helping && (
                    <HomeButton colors={colors} text={t(PLACE_CIRCLE_WORDS.help)} a11y={t(PLACE_CIRCLE_WORDS.helpA11y)}
                        onPress={() => void wouldHelp()} testID="home-find-help" />
                )}
            </FabAware>
            {!point && (
                <HomeLink id="find:town" colors={colors} text={t(LINKS.typeTown)} a11y={t('Or type your town, to see the communities near it')}
                    onPress={() => openFind(true)} testID="home-find-type-town" />
            )}
        </>
    );
}
