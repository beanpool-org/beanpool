/**
 * "Also remove from friends" under a name on Settings → Manage Blocked Users, shown only while that person is still your
 * friend. A block does not end a friendship (guide settings/blocking.md): they still have you as a friend, and see your
 * contact if it is set to Friends. This ends it in one step, through the same node route as any removal
 * (utils/db.removeFriendOnNode), and the block stays. A block made on this phone never reaches the node; the removal
 * does, as any removal does. They can notice a removal, so it says so before it is done.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import { isFriendLocal, removeFriendOnNode } from '../utils/db';

export const BLOCKED_FRIEND_NOTE = 'Still your friend. They can notice a removal.';
export const BLOCKED_FRIEND_REMOVED = 'No longer your friend. Still blocked.';

export function BlockedFriendRemove({ myKey, pubkey, callsign }: { myKey: string; pubkey: string; callsign: string }) {
    const styles = useStyles(({ colors }) => ({
        box: { marginTop: 8, gap: 6 },
        note: { fontSize: 12, color: colors.text.secondary },
        // Heading text on the brand tint, edged in the brand colour: readable in light and dark (as AddedYouLines' Add back).
        button: { alignSelf: 'flex-start' as const, backgroundColor: colors.brand.tint, borderWidth: 1, borderColor: colors.brand.primary, minHeight: 44, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center' as const },
        buttonText: { color: colors.text.heading, fontWeight: '700' as const, fontSize: 13 },
        error: { fontSize: 12, fontWeight: '600' as const, color: colors.feedback.danger.fg },
    }));
    const [state, setState] = useState<'checking' | 'friend' | 'not' | 'busy' | 'removed'>('checking');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        isFriendLocal(myKey, pubkey)
            .then(friend => { if (live) setState(friend ? 'friend' : 'not'); })
            .catch(() => { if (live) setState('not'); });
        return () => { live = false; };
    }, [myKey, pubkey]);

    const remove = async () => {
        setError(null);
        setState('busy');
        try {
            await removeFriendOnNode(myKey, pubkey);
            setState('removed');
        } catch (e: any) {
            setError(String(e?.message || 'That did not go through, so they are still your friend. Please try again.'));
            setState('friend');
        }
    };

    if (state === 'checking' || state === 'not') return null;
    if (state === 'removed') return <View style={styles.box}><Text style={styles.note}>{BLOCKED_FRIEND_REMOVED}</Text></View>;
    return (
        <View style={styles.box}>
            <Text style={styles.note}>{BLOCKED_FRIEND_NOTE}</Text>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Also remove ${callsign} from friends`}
                style={styles.button}
                disabled={state === 'busy'}
                onPress={() => Alert.alert(
                    'Remove from friends?',
                    `${callsign} stays blocked and is no longer your friend. They can notice a removal.`,
                    [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => { void remove(); } },
                    ],
                )}
            >
                <Text style={styles.buttonText}>{state === 'busy' ? 'Removing…' : 'Also remove from friends'}</Text>
            </Pressable>
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </View>
    );
}
