/**
 * "Also show this on the global community" on an in-person event (DESIGN-list-on-global-fable.md §2, slice G2′): off by
 * default, and never a join by itself. The composer's tick, and the same offer on the host's page, which says when the event
 * is shown and offers to stop. The global community itself shows none of this.
 *
 * Nothing is asked of the global community until the member taps: a composer that opens tells it nothing. The row is
 * drawn from what the phone kept of its last answer, and the tap asks if that isn't "member". Told this key is a stranger
 * there, it offers the door: on the host's page as a link, and in the composer as words, since the form is a modal over
 * the app and leaving it would lose the event.
 *
 * The event screens open for everyone and this is for the few: what it runs on is loaded at the tap, or when the row shows.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import type { BeanPoolIdentity } from '../utils/identity';
import type { GlobalStanding } from '../utils/global-entry';
import type { HomeEvent } from '../utils/show-on-global';

export const showOnGlobalLabel = () => t('Also show this on the global community');
export const showOnGlobalHint = () => t("Anyone there can see it, with its times, its rough area and this community's name. Not your name, the place or your note. To go, they ask to join.");
const joinFirstWords = () => t('Join the global community to show this there');

/** The member's own copy, sent from here: it holds up nothing, and what it owes them comes as its own line. */
export async function showEventOnGlobal(event: HomeEvent, identity: BeanPoolIdentity): Promise<void> {
    const { copyResultLine, showOnGlobal } = await import('../utils/show-on-global');
    const here = await (await import('../utils/node-post')).anchorUrl();
    const line = here ? copyResultLine(await showOnGlobal(event, here, identity)) : null;
    if (line) Alert.alert(showOnGlobalLabel(), line);
}

/**
 * What the row offers, from the phone's own memory. `enabled`: an event at a place, the member's own and for the whole
 * community, on a local community; the screen that draws the row holds the node's profile, and the global community draws none.
 */
function useOffer(enabled: boolean): { offer: 'tick' | 'join' | null; ask: () => Promise<GlobalStanding> } {
    const { identity } = useIdentity();
    const [kept, setKept] = useState<GlobalStanding>('unknown');
    const publicKey = identity?.publicKey;
    useEffect(() => {
        let gone = false;
        if (enabled && publicKey) {
            void import('../utils/global-entry').then((g) => g.readGlobalStanding(publicKey)).then((s) => { if (!gone) setKept(s); });
        }
        return () => { gone = true; };
    }, [enabled, publicKey]);
    const ask = async (): Promise<GlobalStanding> => {
        if (!identity?.privateKey) return 'unknown';
        const { askGlobalStanding, readGlobalStanding } = await import('../utils/global-entry');
        const now = await readGlobalStanding(identity.publicKey);
        const standing = now === 'member' ? now : (await askGlobalStanding({ publicKey: identity.publicKey, privateKey: identity.privateKey })).standing;
        setKept(standing);
        return standing;
    };
    return { offer: !enabled || !identity ? null : kept === 'stranger' ? 'join' : 'tick', ask };
}

const unreachable = () => Alert.alert(showOnGlobalLabel(), t("The global community can't be reached right now."));

/**
 * The composer's tick. Off until the member ticks it, and off again if the form moves away from what it is for (Online, a
 * group, another host): a tick nobody can see must not go with the event. `online`: an event that would have the offer
 * but for being online, told why not.
 */
export function ShowOnGlobalTick({ enabled, online = false, checked, onChange }: { enabled: boolean; online?: boolean; checked: boolean; onChange: (next: boolean) => void }) {
    const styles = useStyles(makeStyles);
    const { offer, ask } = useOffer(enabled);
    const [busy, setBusy] = useState(false);
    // The form outlives its sheet: an answer landing once this row has gone would tick the next event, against "off, every time".
    const here = useRef(true);
    useEffect(() => {
        here.current = true;
        return () => { here.current = false; };
    }, []);
    useEffect(() => {
        if (!enabled && checked) onChange(false);
    }, [enabled, checked, onChange]);
    if (online) {
        return (
            <View style={styles.row} testID="show-on-global-online">
                <Text style={styles.hint}>{t("Online events can't be shown on the global community yet.")}</Text>
            </View>
        );
    }
    if (offer === 'join') {
        return (
            <View style={styles.row} testID="show-on-global-join">
                <View style={styles.col}>
                    <Text style={styles.title}>{joinFirstWords()}</Text>
                    <Text style={styles.hint}>{t("You can show it from the event's page once you have.")}</Text>
                </View>
            </View>
        );
    }
    if (offer !== 'tick') return null;
    const tap = async () => {
        if (checked) return onChange(false);
        setBusy(true);
        try {
            const standing = await ask();
            if (!here.current) return;
            if (standing === 'member') onChange(true);
            else if (standing === 'unknown') unreachable();
        } finally {
            setBusy(false);
        }
    };
    return (
        <Pressable
            onPress={tap}
            disabled={busy}
            style={[styles.row, busy && styles.asking]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, busy }}
            accessibilityLabel={showOnGlobalLabel()}
            accessibilityHint={showOnGlobalHint()}
            testID="show-on-global-tick"
        >
            <Text style={styles.box}>{checked ? '☑' : '☐'}</Text>
            <View style={styles.col}>
                <Text style={styles.title}>{showOnGlobalLabel()}</Text>
                <Text style={styles.hint}>{showOnGlobalHint()}</Text>
            </View>
        </Pressable>
    );
}

/** The host's page: shown, with Stop showing; or the same offer as the composer, for an event made without it. */
export function ShowOnGlobalHostRow({ event, enabled }: { event: HomeEvent; enabled: boolean }) {
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const { offer, ask } = useOffer(enabled);
    const [shown, setShown] = useState(false);
    const [resting, setResting] = useState(false);
    const [busy, setBusy] = useState(false);
    const read = useCallback(() => {
        if (!enabled || !identity) return;
        void import('../utils/show-on-global').then((c) => c.pairOf(event.id, identity.publicKey)).then((p) => {
            setShown(!!p);
            setResting(!!p?.resting);
        });
    }, [enabled, event.id, identity]);
    useEffect(read, [read]);
    if (!enabled || !identity || (!shown && !offer)) return null;
    if (!shown && offer === 'join') {
        return (
            <Pressable onPress={() => void import('expo-router').then(({ router }) => router.push('/join-global'))} style={styles.row} accessibilityRole="button" testID="show-on-global-join">
                <Text style={styles.link}>{joinFirstWords()}</Text>
            </Pressable>
        );
    }
    const show = async () => {
        const standing = await ask();
        if (standing === 'unknown') return unreachable();
        if (standing === 'member') await showEventOnGlobal(event, identity);
    };
    // A stop that didn't reach global reads as done once the row flips back, so the member is told it is still up.
    const stop = async () => {
        const { stopLaterLine, stopShowing } = await import('../utils/show-on-global');
        if (!(await stopShowing(event.id, identity))) Alert.alert(showOnGlobalLabel(), stopLaterLine());
    };
    const act = async () => {
        setBusy(true);
        try {
            await (shown ? stop() : show());
        } finally {
            read();
            setBusy(false);
        }
    };
    return (
        <View style={styles.row} testID="show-on-global-host">
            <View style={styles.col}>
                {shown
                    ? <Text style={styles.title}>{resting ? t("It comes down while you're on holiday, and goes back up when you're back.") : t('Shown on the global community')}</Text>
                    : <Text style={styles.hint}>{showOnGlobalHint()}</Text>}
                <Pressable onPress={act} disabled={busy} style={[styles.action, busy && styles.asking]} accessibilityRole="button" accessibilityState={{ busy }} testID="show-on-global-act">
                    <Text style={styles.link}>{shown ? t('Stop showing') : showOnGlobalLabel()}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12, minHeight: 44, paddingVertical: 4 },
    asking: { opacity: 0.6 },
    box: { fontSize: 22, color: colors.text.body, marginRight: 8, lineHeight: 26 },
    col: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, fontWeight: '700', color: colors.text.body, lineHeight: 19 },
    hint: { fontSize: 12, color: colors.text.secondary, marginTop: 4, lineHeight: 16 },
    action: { minHeight: 44, justifyContent: 'center' },
    link: { fontSize: 14, fontWeight: '700', color: colors.text.link },
});
