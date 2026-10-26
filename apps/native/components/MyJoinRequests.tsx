import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { router } from 'expo-router';
import { useStyles } from '../app/ThemeContext';
import type { BeanPoolIdentity } from '../utils/identity';
import { rememberedKnocks, readKnockStatus, knockCardState, cancelKnock, KNOCK_MESSAGES, type KnockStatusResult, type RememberedKnock } from '../utils/knock';
import { t } from '@beanpool/core';

/** A note the phone wrote (KNOCK_MESSAGES), in the member's language; a community's own words as it sent them (slice S4). */
function noteWords(note: string): string {
    const said = (Object.keys(KNOCK_MESSAGES) as Array<keyof typeof KNOCK_MESSAGES>).find((k) => KNOCK_MESSAGES[k] === note);
    return said ? t(KNOCK_MESSAGES[said]) : note;
}

/**
 * On the worldwide community's People: the communities this phone asked to join, and what each has said, read from
 * those communities only. A decline reads as waiting (the community answers it that way). Joining happens in Find a
 * community, where an invite that came back is one tap. A waiting one can be cancelled here ("Cancel my request").
 */
export function MyJoinRequests({ identity }: { identity: BeanPoolIdentity }) {
    const [asked, setAsked] = useState<RememberedKnock[]>([]);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});

    const styles = useStyles(({ colors }) => StyleSheet.create({
        header: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        help: { fontSize: 13, color: colors.text.secondary, marginBottom: 12, lineHeight: 18 },
        row: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 14, padding: 14, marginBottom: 10 },
        name: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        note: { fontSize: 14, color: colors.text.body, marginTop: 4, lineHeight: 20 },
        cancel: { minHeight: 48, alignSelf: 'flex-start', paddingHorizontal: 16, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        cancelText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        button: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
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

    // Asked first: the key can't ask that community again for a day. Done, the row goes (Find a community says it was cancelled).
    const cancel = (k: RememberedKnock) => {
        const name = k.name ?? k.url.replace(/^https:\/\//, '');
        Alert.alert(t('Cancel your request to join {name}?', { name }), t('You can ask again after 24 hours.'), [
            { text: t('Keep it'), style: 'cancel' },
            {
                text: t('Cancel my request'), style: 'destructive', onPress: async () => {
                    setCancelling(k.url);
                    const r = await cancelKnock(k.url, identity);
                    setCancelling(null);
                    if (r.ok) setAsked(await rememberedKnocks(identity.publicKey));
                    else setNotes(n => ({ ...n, [k.url]: r.message }));
                },
            },
        ]);
    };

    return (
        <View>
            <Text style={styles.header} accessibilityRole="header">{t('🏘️ Join a local community')}</Text>
            <Text style={styles.help}>{t('Communities near you are where neighbours trade. Ask to join one, and any member there can let you in.')}</Text>
            {asked.map(k => {
                const state = knockCardState(true, true, statuses[k.url]);
                const note = state.kind === 'checking' ? t('Checking…') : 'note' in state && state.note ? noteWords(state.note) : t('No answer yet.');
                const name = k.name ?? k.url.replace(/^https:\/\//, '');
                return (
                    <View key={k.url} style={styles.row}>
                        <Text style={styles.name} numberOfLines={2}>{name}</Text>
                        <Text style={styles.note}>{note}</Text>
                        {!!notes[k.url] && <Text style={styles.note}>{noteWords(notes[k.url])}</Text>}
                        {state.kind === 'waiting' && (
                            <Pressable
                                style={[styles.cancel, cancelling === k.url && { opacity: 0.6 }]}
                                onPress={() => cancel(k)}
                                disabled={!!cancelling}
                                accessibilityRole="button"
                                accessibilityLabel={t('Cancel your request to join {name}', { name })}
                                testID="my-requests-cancel"
                            >
                                <Text style={styles.cancelText}>{cancelling === k.url ? t('Cancelling…') : t('Cancel my request')}</Text>
                            </Pressable>
                        )}
                    </View>
                );
            })}
            <Pressable style={styles.button} onPress={() => router.push('/find-community')} accessibilityRole="button">
                <Text style={styles.buttonText}>{t('Find a community')}</Text>
            </Pressable>
            <View style={styles.divider} />
        </View>
    );
}
