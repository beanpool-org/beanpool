import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useStyles } from '../app/ThemeContext';
import type { BeanPoolIdentity } from '../utils/identity';
import { rememberedKnocks, readKnockStatus, knockCardState, type KnockStatusResult, type RememberedKnock } from '../utils/knock';

/**
 * On the worldwide community's People: the communities this phone asked to join, and what each has said, read from
 * those communities only. A decline reads as waiting (the community answers it that way). Joining happens in Find a
 * community, where an invite that came back is one tap.
 */
export function MyJoinRequests({ identity }: { identity: BeanPoolIdentity }) {
    const [asked, setAsked] = useState<RememberedKnock[]>([]);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});

    const styles = useStyles(({ colors }) => StyleSheet.create({
        header: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        help: { fontSize: 13, color: colors.text.secondary, marginBottom: 12, lineHeight: 18 },
        row: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 14, padding: 14, marginBottom: 10 },
        name: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        note: { fontSize: 14, color: colors.text.body, marginTop: 4, lineHeight: 20 },
        button: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
        buttonText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800', textAlign: 'center' },
        divider: { height: 1, backgroundColor: colors.border.default, marginVertical: 24 },
    }));

    useEffect(() => {
        let alive = true;
        rememberedKnocks(identity.publicKey).then(list => {
            if (!alive) return;
            setAsked(list);
            list.forEach(k => {
                setStatuses(s => ({ ...s, [k.url]: null }));
                readKnockStatus(k.url, identity).then(r => { if (alive) setStatuses(s => ({ ...s, [k.url]: r })); });
            });
        });
        return () => { alive = false; };
    }, [identity]);

    return (
        <View>
            <Text style={styles.header} accessibilityRole="header">🏘️ Join a local community</Text>
            <Text style={styles.help}>Communities near you are where neighbours trade. Ask to join one, and any member there can let you in.</Text>
            {asked.map(k => {
                const state = knockCardState(true, true, statuses[k.url]);
                const note = state.kind === 'checking' ? 'Checking…' : 'note' in state && state.note ? state.note : 'No answer yet.';
                return (
                    <View key={k.url} style={styles.row}>
                        <Text style={styles.name} numberOfLines={2}>{k.name ?? k.url.replace(/^https:\/\//, '')}</Text>
                        <Text style={styles.note}>{note}</Text>
                    </View>
                );
            })}
            <Pressable style={styles.button} onPress={() => router.push('/find-community')} accessibilityRole="button">
                <Text style={styles.buttonText}>Find a community</Text>
            </Pressable>
            <View style={styles.divider} />
        </View>
    );
}
