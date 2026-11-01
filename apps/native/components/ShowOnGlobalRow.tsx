/**
 * "Also show this on the global community" on an in-person event (DESIGN-list-on-global-fable.md §2, slice G2′): off by
 * default, and never a join by itself. The composer's tick, and the same row on the host's page, where it says the event
 * is shown and offers to stop. A phone that isn't a member of the global community is offered the door instead. The
 * global community itself shows none of this. The words are utils/show-on-global.ts's rule: what goes, and what stays.
 */
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { t } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useGlobalEntry } from '../utils/use-global-entry';
import { useNodeProfile } from '../utils/use-node-profile';
import { copyResultLine, pairOf, showOnGlobal, stopShowing, type HomeEvent } from '../utils/show-on-global';
import { anchorUrl } from '../utils/node-post';

export const showOnGlobalLabel = () => t('Also show this on the global community');
export const showOnGlobalHint = () => t("Anyone there can see it, with its times, its rough area and this community's name. Not your name, the place or your note. To go, they ask to join.");

/** Whether the phone can offer it: `tick` for a member of the global community, `join` for the door, else nothing. */
export function useShowOnGlobalOffer(enabled: boolean): 'tick' | 'join' | null {
    const elsewhere = useNodeProfile()?.profile === 'local';
    const entry = useGlobalEntry(enabled && elsewhere);
    return !enabled || !elsewhere ? null : entry === 'member' ? 'tick' : entry === 'join' ? 'join' : null;
}

function JoinRow() {
    const styles = useStyles(makeStyles);
    return (
        <Pressable onPress={() => router.push('/join-global')} style={styles.row} accessibilityRole="button" testID="show-on-global-join">
            <Text style={styles.link}>{t('Join the global community to show this there')}</Text>
        </Pressable>
    );
}

/** The composer's tick. Off until the member ticks it. */
export function ShowOnGlobalTick({ enabled, checked, onChange }: { enabled: boolean; checked: boolean; onChange: (next: boolean) => void }) {
    const styles = useStyles(makeStyles);
    const offer = useShowOnGlobalOffer(enabled);
    if (offer === 'join') return <JoinRow />;
    if (offer !== 'tick') return null;
    return (
        <Pressable onPress={() => onChange(!checked)} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={showOnGlobalLabel()} testID="show-on-global-tick">
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
    const offer = useShowOnGlobalOffer(enabled);
    const [shown, setShown] = useState(false);
    const [busy, setBusy] = useState(false);
    const read = useCallback(() => {
        if (identity) void pairOf(event.id, identity.publicKey).then((p) => setShown(!!p));
    }, [event.id, identity]);
    useFocusEffect(read);
    if (!enabled || !identity) return null;
    if (!shown && offer === 'join') return <JoinRow />;
    if (!shown && offer !== 'tick') return null;
    const act = async () => {
        setBusy(true);
        try {
            if (shown) {
                await stopShowing(event.id, identity);
            } else {
                const here = await anchorUrl();
                const line = here ? copyResultLine(await showOnGlobal(event, here, identity)) : null;
                if (line) Alert.alert(showOnGlobalLabel(), line);
            }
        } finally {
            read();
            setBusy(false);
        }
    };
    return (
        <View style={styles.row} testID="show-on-global-host">
            <View style={styles.col}>
                {shown ? <Text style={styles.title}>{t('Shown on the global community')}</Text> : <Text style={styles.hint}>{showOnGlobalHint()}</Text>}
                <Pressable onPress={act} disabled={busy} style={styles.action} accessibilityRole="button" accessibilityState={{ busy }}>
                    <Text style={styles.link}>{shown ? t('Stop showing') : showOnGlobalLabel()}</Text>
                </Pressable>
            </View>
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12, minHeight: 44, paddingVertical: 4 },
    box: { fontSize: 22, color: colors.text.body, marginRight: 8, lineHeight: 26 },
    col: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, fontWeight: '700', color: colors.text.body, lineHeight: 19 },
    hint: { fontSize: 12, color: colors.text.secondary, marginTop: 4, lineHeight: 16 },
    action: { minHeight: 44, justifyContent: 'center' },
    link: { fontSize: 14, fontWeight: '700', color: colors.text.link },
});
