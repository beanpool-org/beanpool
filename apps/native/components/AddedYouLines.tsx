/**
 * "Added you · Add back" on the People tab's Friends view: the people who added you lately and whom you haven't added back
 * (GET /api/friends/added-you; server engine/friends-added-you.ts). Quiet on purpose: a line each, no push, no badge.
 * Adding back makes it a friendship both ways, which is what a connection in common is made of. Nothing shows when
 * nobody has, or when the node can't say (an older node, off-grid).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { MemberAvatar } from './MemberAvatar';
import { useStyles } from '../app/ThemeContext';
import { addFriendLocal, fetchAddedYou, type AddedYou } from '../utils/db';

export function AddedYouLines({ myKey, onAddedBack }: { myKey: string; onAddedBack: () => void }) {
    const styles = useStyles(({ colors }) => ({
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16, overflow: 'hidden' as const },
        row: { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 12, paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        who: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 44 },
        line: { flex: 1, fontSize: 14, color: colors.text.body },
        name: { fontWeight: '700' as const, color: colors.text.heading },
        addBack: { backgroundColor: colors.brand.dark, minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center' as const, flexShrink: 0 },
        addBackText: { color: colors.text.inverse, fontWeight: '700' as const, fontSize: 13 },
        more: { fontSize: 12, color: colors.text.muted, paddingHorizontal: 12, paddingVertical: 8 },
    }));
    const [lines, setLines] = useState<AddedYou[]>([]);
    const [more, setMore] = useState(0);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const { addedYou, more: rest } = await fetchAddedYou();
            setLines(addedYou);
            setMore(rest);
        } catch {
            setLines([]);
            setMore(0);
        }
    }, []);
    useEffect(() => { void load(); }, [load, myKey]);

    if (lines.length === 0) return null;
    return (
        <View style={styles.card} testID="added-you">
            {lines.map(l => (
                <View key={l.publicKey} style={styles.row}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${l.callsign} added you. Open their profile`}
                        style={styles.who}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: l.publicKey, callsign: l.callsign || 'Unknown' } })}
                    >
                        <MemberAvatar avatarUrl={l.avatarUrl} pubkey={l.publicKey} callsign={l.callsign || '?'} size={32} />
                        <Text style={styles.line}><Text style={styles.name}>{l.callsign}</Text> added you</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${l.callsign} back`}
                        disabled={busy !== null}
                        style={styles.addBack}
                        onPress={async () => {
                            setBusy(l.publicKey);
                            try {
                                await addFriendLocal(myKey, l.publicKey);
                                setLines(prev => prev.filter(x => x.publicKey !== l.publicKey));
                                onAddedBack();
                            } catch (e: any) {
                                Alert.alert('Not added', e?.message || 'Your community did not add them.');
                            } finally {
                                setBusy(null);
                            }
                        }}
                    >
                        <Text style={styles.addBackText}>Add back</Text>
                    </Pressable>
                </View>
            ))}
            {more > 0 && <Text style={styles.more}>and {more} more</Text>}
        </View>
    );
}
