/**
 * "Added you · Add back" on the People tab's Friends view: the people who added you lately and whom you haven't added back
 * (GET /api/friends/added-you; server engine/friends-added-you.ts). Quiet on purpose: a line each, no push, no badge.
 * Adding back makes it a friendship both ways, which is what a connection in common is made of. Nothing shows when
 * nobody has, or when the node can't say (an older node, off-grid).
 * A block made on this phone stays on this phone (utils/blocklist.ts): the node never hears of it, so its own filter
 * can't leave them out. They are left out here, as the People lists leave them out, and at once when blocked.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, View, Text, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { MemberAvatar } from './MemberAvatar';
import { useStyles } from '../app/ThemeContext';
import { addFriendLocal, fetchAddedYou, type AddedYou } from '../utils/db';
import { getBlockedUsers, BLOCKLIST_UPDATED_EVENT } from '../utils/blocklist';

export function AddedYouLines({ myKey, onAddedBack }: { myKey: string; onAddedBack: () => void }) {
    const styles = useStyles(({ colors }) => ({
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16, overflow: 'hidden' as const },
        row: { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 12, paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        // minWidth 0 on both, so a long name wraps beside Add back instead of running under it (seen at 320 × 1.3).
        who: { flex: 1, minWidth: 0, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 44 },
        line: { flex: 1, minWidth: 0, flexShrink: 1, fontSize: 14, color: colors.text.body },
        name: { fontWeight: '700' as const, color: colors.text.heading },
        // Heading text on the brand tint, edged in the brand colour: readable in light and dark (white on brand.dark is 3.8:1).
        addBack: { backgroundColor: colors.brand.tint, borderWidth: 1, borderColor: colors.brand.primary, minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center' as const, flexShrink: 0 },
        addBackText: { color: colors.text.heading, fontWeight: '700' as const, fontSize: 13 },
        more: { fontSize: 12, color: colors.text.secondary, paddingHorizontal: 12, paddingVertical: 8 },
    }));
    const [lines, setLines] = useState<AddedYou[]>([]);
    const [more, setMore] = useState(0);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [{ addedYou, more: rest }, blocked] = await Promise.all([fetchAddedYou(), getBlockedUsers()]);
            setLines(addedYou.filter(a => !blocked.includes(a.publicKey)));
            setMore(rest);
        } catch {
            setLines([]);
            setMore(0);
        }
    }, []);
    useEffect(() => { void load(); }, [load, myKey]);
    useEffect(() => {
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, () => { void load(); });
        return () => sub.remove();
    }, [load]);

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
