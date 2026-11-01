import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../constants/colors';
import type { BeanPoolIdentity } from '../utils/identity';
import { setCircleStarting } from '../utils/community-directory';
import { circleIntents, currentNodeUrl, knockForCircle, readCircleAsk, setCircleIntent, type CircleAsk } from '../utils/circle-intent';
import { FIND_COMMUNITY_WORDS, PLACE_CIRCLE_WORDS, circleKnockLine, circleKnockReady, circlePeopleLine, circleStartedLine, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import { HOME_CARD_PADDING_DP, HomeButton } from './home/HomeParts';

/**
 * A place circle's own rows (Lounge L2, §3.3): how many are here, Start a community, and "I'm starting one here", entry S8's
 * row, which lives here and not loose on the Find card. Drawn on Home's Find card and in the group's sheet. "Remind me to
 * join when it starts" is this phone's own wish (utils/circle-intent.ts). Once a community has retired the circle: what
 * started, how long the chat stays, and Ask to join, the one tap that sends anything to it.
 */
export function PlaceCircleCard({ id, circle, identity, nodeUrl, colors, closed, onAsked, onLeave, onChange }: {
    id: string;
    circle: CircleCard;
    identity: BeanPoolIdentity | null;
    /** The community the group is on; left out: the one this phone is on. */
    nodeUrl?: string | null;
    colors: AppColors;
    /** The group has closed: its sheet says so, and "Its chat stays for 30 days" would no longer be true. */
    closed?: boolean;
    /** A tap on Ask to join left a request. Whoever passes this draws how it fares (Home's waiting card); left out, the card says where to look. */
    onAsked?: () => void;
    /** Before Start a community opens: a sheet closes itself, or a Modal stays above the screen it opens. */
    onLeave?: () => void;
    onChange?: (card: CircleCard) => void;
}) {
    const s = useMemo(() => makeStyles(colors), [colors]);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [joinAsked, setJoinAsked] = useState(false);
    /** What this phone holds about asking the community that retired it: null until read, so no button stands on a guess. */
    const [ask, setAsk] = useState<CircleAsk | null>(null);
    const [trouble, setTrouble] = useState<CircleKnockTrouble | null>(null);
    const [said, setSaid] = useState<string | null>(null);

    useEffect(() => {
        if (!identity) return;
        let alive = true;
        void circleIntents(identity.publicKey).then(held => { if (alive) setJoinAsked(held.includes(id)); });
        return () => { alive = false; };
    }, [id, identity?.publicKey]);

    useEffect(() => {
        setTrouble(null);
        setSaid(null);
    }, [id]);

    // This phone's own memory, on each read of the card. Nothing here goes to the community.
    useEffect(() => {
        if (!circle.doneAt || !identity) { setAsk(null); return; }
        let alive = true;
        void readCircleAsk(identity.publicKey, id, circle.community?.url).then(held => { if (alive) setAsk(held); });
        return () => { alive = false; };
    }, [id, identity?.publicKey, circle]);

    const onAskToJoin = async () => {
        if (!identity || busy) return;
        setBusy(true);
        setTrouble(null);
        const r = await knockForCircle(identity, { ...circle, id });
        setTrouble(r.trouble);
        setSaid(r.said);
        setAsk(await readCircleAsk(identity.publicKey, id, circle.community?.url));
        setBusy(false);
        if (r.sent) onAsked?.();
    };

    if (circle.doneAt) {
        const canAsk = !!identity && !!ask && circleKnockReady(circle) && !ask.asked && !ask.cancelled && !ask.refused && !said;
        const knockLine = circleKnockLine(trouble ?? (ask?.refused ? 'refused' : null));
        return (
            <View style={s.card} testID="circle-card-done">
                <Text style={[s.line, s.strong]} testID="circle-started-line">{circleStartedLine(circle.community)}</Text>
                {canAsk && ask.wished && <Text style={s.sub} testID="circle-reminded">{t(PLACE_CIRCLE_WORDS.reminded)}</Text>}
                {canAsk && (
                    <View style={s.buttons}>
                        <HomeButton colors={colors} primary busy={busy} text={t(PLACE_CIRCLE_WORDS.askToJoin)} onPress={() => void onAskToJoin()} testID="circle-ask-join" />
                    </View>
                )}
                {!!knockLine && <Text style={s.sub} accessibilityLiveRegion="polite" testID="circle-knock-line">{knockLine}</Text>}
                {!!said && <Text style={s.sub} accessibilityLiveRegion="polite" testID="circle-knock-said">{said}</Text>}
                {!!ask?.asked && !onAsked && <Text style={s.sub} accessibilityLiveRegion="polite" testID="circle-asked">{t(PLACE_CIRCLE_WORDS.asked)}</Text>}
                {!closed && <Text style={s.sub} testID="circle-chat-stays">{t(PLACE_CIRCLE_WORDS.done)}</Text>}
            </View>
        );
    }

    const people = circlePeopleLine(circle.people);

    const onStarting = async () => {
        if (!identity || busy) return;
        setBusy(true);
        setNote(null);
        const r = await setCircleStarting(identity, id, circle.starting !== 'you', nodeUrl ?? await currentNodeUrl());
        setBusy(false);
        if (r.ok) onChange?.(r.value);
        else setNote(r.message);
    };

    const onJoinWhenStarts = async () => {
        if (!identity) return;
        const next = !joinAsked;
        setJoinAsked(next);
        await setCircleIntent(identity.publicKey, id, next);
    };

    return (
        <View style={s.card} testID="circle-card">
            {!!people && <Text style={[s.line, s.strong]} testID="circle-people">{people}</Text>}
            {circle.starting === 'someone' && <Text style={[s.line, s.gap]} testID="circle-someone-starting">{t(PLACE_CIRCLE_WORDS.someoneStarting)}</Text>}
            {circle.starting === 'you' && <Text style={[s.line, s.gap]} testID="circle-you-starting">{t(PLACE_CIRCLE_WORDS.youAreStarting)}</Text>}
            <View style={s.buttons}>
                <HomeButton colors={colors} text={t(FIND_COMMUNITY_WORDS.start)} onPress={() => { onLeave?.(); router.push('/start-community'); }} testID="circle-start" />
                {circle.starting !== 'someone' && (
                    <HomeButton colors={colors} busy={busy} primary={circle.starting === null} text={circle.starting === 'you' ? t(PLACE_CIRCLE_WORDS.notStarting) : t(PLACE_CIRCLE_WORDS.starting)}
                        onPress={() => void onStarting()} testID="circle-starting" />
                )}
                {circle.starting !== 'you' && (
                    <HomeButton colors={colors} text={joinAsked ? t(PLACE_CIRCLE_WORDS.joinWhenStartsOn) : t(PLACE_CIRCLE_WORDS.joinWhenStarts)}
                        onPress={() => void onJoinWhenStarts()} testID="circle-join-when" />
                )}
            </View>
            {!!note && <Text style={s.sub} accessibilityLiveRegion="polite" testID="circle-note">{note}</Text>}
        </View>
    );
}

// Home's card, row and button-row values, in a table of the card's own so the contrast check reads it in both themes
// (it can't follow `homeStyles` across files).
function makeStyles(colors: AppColors) {
    return StyleSheet.create({
        card: {
            marginTop: 8, marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
            backgroundColor: colors.surface.card, paddingHorizontal: HOME_CARD_PADDING_DP, paddingVertical: 10,
        },
        line: { fontSize: 15, lineHeight: 20, color: colors.text.body },
        strong: { fontWeight: '700', color: colors.text.heading },
        gap: { marginTop: 4 },
        sub: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 4 },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 4 },
    });
}
