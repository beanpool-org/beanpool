import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../constants/colors';
import type { BeanPoolIdentity } from '../utils/identity';
import { setCircleStarting } from '../utils/community-directory';
import { circleIntents, setCircleIntent } from '../utils/circle-intent';
import { FIND_COMMUNITY_WORDS, PLACE_CIRCLE_WORDS, circlePeopleLine, circleStartedLine, t, type CircleCard } from '@beanpool/core';
import { HomeButton, homeStyles } from './home/HomeParts';

/**
 * A place circle's own rows (Lounge L2, §3.3): how many are here, Start a community, and "I'm starting one here", entry S8's
 * row, which lives here and not loose on the Find card. Drawn on Home's Find card and in the group's sheet. "Join when it
 * starts" is this phone's own wish (utils/circle-intent.ts). Once a community has retired the circle: what started, and
 * how long the chat stays.
 */
export function PlaceCircleCard({ id, circle, identity, nodeUrl, colors, onChange }: {
    id: string;
    circle: CircleCard;
    identity: BeanPoolIdentity | null;
    /** The community the group is on; left out: the global one. */
    nodeUrl?: string | null;
    colors: AppColors;
    onChange?: (card: CircleCard) => void;
}) {
    const s = homeStyles(colors);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [joinAsked, setJoinAsked] = useState(false);

    useEffect(() => {
        if (!identity) return;
        let alive = true;
        void circleIntents(identity.publicKey).then(held => { if (alive) setJoinAsked(held.includes(id)); });
        return () => { alive = false; };
    }, [id, identity?.publicKey]);

    if (circle.doneAt) {
        return (
            <View style={[s.card, { marginHorizontal: 0, marginTop: 8, marginBottom: 8, paddingVertical: 10 }]} testID="circle-card-done">
                <Text style={[s.rowLine, s.rowStrong]} testID="circle-started-line">{circleStartedLine(circle.community)}</Text>
                <Text style={[s.rowSub, { marginTop: 4 }]}>{t(PLACE_CIRCLE_WORDS.done)}</Text>
            </View>
        );
    }

    const people = circlePeopleLine(circle.people);

    const onStarting = async () => {
        if (!identity || busy) return;
        setBusy(true);
        setNote(null);
        const r = await setCircleStarting(identity, id, circle.starting !== 'you', nodeUrl ?? undefined);
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
        <View style={[s.card, { marginHorizontal: 0, marginTop: 8, marginBottom: 8, paddingVertical: 10 }]} testID="circle-card">
            {!!people && <Text style={[s.rowLine, s.rowStrong]} testID="circle-people">{people}</Text>}
            {circle.starting === 'someone' && <Text style={[s.rowLine, { marginTop: 4 }]} testID="circle-someone-starting">{t(PLACE_CIRCLE_WORDS.someoneStarting)}</Text>}
            {circle.starting === 'you' && <Text style={[s.rowLine, { marginTop: 4 }]} testID="circle-you-starting">{t(PLACE_CIRCLE_WORDS.youAreStarting)}</Text>}
            <View style={s.buttonRow}>
                <HomeButton colors={colors} text={t(FIND_COMMUNITY_WORDS.start)} onPress={() => router.push('/start-community')} testID="circle-start" />
                {circle.starting !== 'someone' && (
                    <HomeButton colors={colors} busy={busy} primary={circle.starting === null} text={circle.starting === 'you' ? t(PLACE_CIRCLE_WORDS.notStarting) : t(PLACE_CIRCLE_WORDS.starting)}
                        onPress={() => void onStarting()} testID="circle-starting" />
                )}
                {circle.starting !== 'you' && (
                    <HomeButton colors={colors} text={joinAsked ? t(PLACE_CIRCLE_WORDS.joinWhenStartsOn) : t(PLACE_CIRCLE_WORDS.joinWhenStarts)}
                        onPress={() => void onJoinWhenStarts()} testID="circle-join-when" />
                )}
            </View>
            {!!note && <Text style={[s.rowSub, { marginTop: 4 }]} accessibilityLiveRegion="polite" testID="circle-note">{note}</Text>}
        </View>
    );
}
