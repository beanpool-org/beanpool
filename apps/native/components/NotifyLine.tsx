/**
 * The named line at the member's own act (DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3 slice N2a; the first
 * design §4.2, amend1 §4.3): "Hear when Asha answers." [Tell me], under a first message sent, a first message read or a
 * request accepted, a first listing, a first offer or request on someone's listing, an ask to join; and (slice N2b) Going or
 * Interested on an event, a starred interest, a forum topic followed. It replaces the old pop-up of ours at the first post,
 * message and ask to join. N2b's true lines, which are states and not asks, read the phone with ./useNotifyPhone.ts.
 *
 * One line with one button and no "Not now": leaving the screen is the no, once per visit (a screen covered by another, a
 * sheet closed, then shown again: no line; useNotifyLine's `showing`). Whether it shows is core's rule
 * (utils/notification-permission.ts `offerNamedLine`): each kind once on a phone, one soft ask a day (the join's day allows
 * one), never after the phone's no, never where the phone allows notifications without asking (Android 8 to 12). Only a
 * tap on Tell me brings the phone's own pop-up. Allowed: the line says "You'll hear when Asha answers.". Refused, or closed
 * with no answer: the line goes without a word. It wraps at 320 dp and 1.3x text; colours are the theme's.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { notifyLineWords, type NotifyLineKind } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { notePhoneChanged } from './useNotifyPhone';

export interface NotifyLineOffer {
    kind: NotifyLineKind;
    /** The person (answer, again, offer) or community (join) the member waits on. */
    name?: string | null;
    /** Where on the screen it hangs: a chat line's id, a community's address. */
    anchor?: string | null;
    /** Under the member's own line ('end'), or anyone else's ('start', the default). */
    align?: 'start' | 'end';
    /**
     * The fact line in its place (slice N3; amend1 §4.3: "If it waited a day or more, the fact line shows instead; never
     * both"): how many days what is under it waited for the member. Offered by core's `fact` rule, not the kind's.
     */
    fact?: number | null;
}

type Shown = NotifyLineOffer & { state: 'offer' | 'busy' | 'done'; words?: NotifyLineText };

/**
 * A moment that happens on one screen and is answered on the next: a listing posted (its line is on Your deals), a request
 * on someone's listing (its line is in the chat it opens). Kept in memory a short while; taken once.
 */
const moments = new Map<string, NotifyLineOffer & { at: number }>();
const MOMENT_MS = 120_000;
/** A listing posted (app/new-listing.tsx): its line is over My Posts on Your deals (components/MyDealsSheet.tsx). */
export const LISTING_MOMENT = 'deals:listing';
/** A request on someone's listing (app/post/[id].tsx): its line is in the chat with them it opens (app/chat/[id].tsx). */
export const chatMoment = (conversationId: string) => `chat:${conversationId}`;
export function noteNotifyMoment(where: string, offer: NotifyLineOffer): void {
    moments.set(where, { ...offer, at: Date.now() });
}
export function takeNotifyMoment(where: string): NotifyLineOffer | null {
    const m = moments.get(where);
    moments.delete(where);
    if (!m || Date.now() - m.at >= MOMENT_MS) return null;
    return { kind: m.kind, name: m.name, anchor: m.anchor, align: m.align };
}

/**
 * Whether a screen is the one in front: false while another screen covers it, true again when it comes back (expo-router's
 * focus). A stack screen stays mounted under the next one, so this, not mounting, is what a visit is.
 */
export function useScreenShowing(): boolean {
    const [showing, setShowing] = useState(true);
    useFocusEffect(useCallback(() => {
        setShowing(true);
        return () => setShowing(false);
    }, []));
    return showing;
}

/**
 * One screen's named line: `offer` asks core's rule and, where it allows, shows the line (one per screen); `view` is the
 * line to draw, or null. The rule and the turn-on are loaded at the call, so a screen never loads expo-notifications as it
 * opens, and a failure only means no line.
 *
 * `showing` is whether the place is on screen now: a stack screen's focus (useScreenShowing), a sheet's `visible`. A place
 * can stay mounted while hidden (Market keeps Your deals mounted and only flips `visible`), so a mount is not a visit: when
 * `showing` goes false the line goes for good. Leaving is the no for that kind, it never comes back on the next visit,
 * and a line from an earlier day can never stand beside that day's other line. Nothing is offered while hidden, and an
 * answer that lands after the place was hidden shows nothing.
 */
export function useNotifyLine(publicKey: string | null | undefined, showing: boolean) {
    const [shown, setShown] = useState<Shown | null>(null);
    const taken = useRef(false);
    const mounted = useRef(true);
    const showingNow = useRef(showing);
    /** Counts the times the place was hidden: an answer asked for in one visit is drawn only in that visit. */
    const visit = useRef(0);
    useEffect(() => () => { mounted.current = false; }, []);
    useEffect(() => {
        showingNow.current = showing;
        if (!showing) {
            visit.current++;
            setShown(null);
        }
    }, [showing]);

    const offer = useCallback(async (next: NotifyLineOffer): Promise<boolean> => {
        if (taken.current || !showingNow.current) return false;
        taken.current = true;
        const askedIn = visit.current;
        let ok = false;
        let words: NotifyLineText | undefined;
        try {
            const permission = await import('../utils/notification-permission');
            if (next.fact) {
                // "This waited 2 days for you." with its link for the button; once on, the kind's own "You'll hear …".
                const fact = await permission.offerFactLine(next.fact);
                if (fact) words = { line: fact.line, button: fact.link, done: notifyLineWords(next.kind, next.name).done };
                ok = !!fact;
            } else ok = await permission.offerNamedLine(next.kind);
        } catch {
            ok = false;
        }
        if (!ok) taken.current = false;
        else if (mounted.current && showingNow.current && visit.current === askedIn) setShown({ ...next, words, state: 'offer' });
        return ok;
    }, []);

    const tellMe = useCallback(async () => {
        setShown((s) => (s ? { ...s, state: 'busy' } : s));
        let granted = false;
        try {
            granted = (await (await import('../utils/notification-permission')).turnOnNotifications(publicKey)) === 'granted';
        } catch {
            granted = false;
        }
        if (mounted.current) setShown((s) => (s && granted ? { ...s, state: 'done' } : null));
        // A true line elsewhere on screen (the event's reminder) says what is true now.
        notePhoneChanged();
    }, [publicKey]);

    // Hidden: nothing drawn even for the one render before the effect above lets the line go.
    const line = showing ? shown : null;
    /**
     * The line in words the screen says are true now, in place of its kind's own (an event's line follows the answer as it
     * is, not the one that brought it: core's notifyEventLineWords); null: nothing true to say now, so nothing drawn.
     */
    const draw = (words?: NotifyLineText | null) => (line && words !== null
        ? <NotifyLine kind={line.kind} name={line.name} state={line.state} onTellMe={tellMe} align={line.align} words={words} />
        : null);
    const view = draw(line?.words);
    return { line, offer, view, draw };
}

/** A named line's words: the offer, what it says once notifications are on, and its button. */
export type NotifyLineText = { line: string; done: string; button: string };

export function NotifyLine({ kind, name, state, onTellMe, align = 'start', words: given }: {
    kind: NotifyLineKind;
    name?: string | null;
    state: Shown['state'];
    onTellMe: () => void;
    align?: 'start' | 'end';
    /** In place of the kind's own words (useNotifyLine's `draw`). */
    words?: NotifyLineText;
}) {
    const { colors } = useTheme();
    const words = given ?? notifyLineWords(kind, name);
    const side = { alignSelf: align === 'end' ? 'flex-end' as const : 'flex-start' as const };
    if (state === 'done') {
        return (
            <View style={[s.row, side]} testID="notify-line-done" accessibilityLiveRegion="polite">
                <MaterialCommunityIcons name="check" size={16} color={colors.feedback.success.fg} style={s.tick} />
                <Text style={[s.words, { color: colors.text.secondary }]}>{words.done}</Text>
            </View>
        );
    }
    const busy = state === 'busy';
    return (
        <View style={[s.row, side]} testID="notify-line">
            <Text style={[s.words, { color: colors.text.secondary }]}>{words.line}</Text>
            <Pressable
                onPress={busy ? undefined : onTellMe}
                disabled={busy}
                style={({ pressed }) => [s.button, pressed && { backgroundColor: colors.surface.subtle }]}
                accessibilityRole="button"
                accessibilityLabel={words.button}
                accessibilityState={{ busy, disabled: busy }}
                testID="notify-line-tell-me"
            >
                <Text style={[s.buttonText, { color: colors.text.link }]}>{words.button}</Text>
            </Pressable>
        </View>
    );
}

const s = StyleSheet.create({
    // Words and button wrap onto two rows at 320 dp and 1.3x text; the button keeps the 44 dp touch floor.
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', maxWidth: '100%', paddingHorizontal: 4, marginVertical: 2 },
    words: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
    tick: { marginRight: 4 },
    button: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 14, fontWeight: '700' },
});
