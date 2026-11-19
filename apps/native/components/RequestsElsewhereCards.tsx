import React from 'react';
import { Text, StyleSheet, Pressable } from 'react-native';
import { t, tn } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import type { RequestsPlace } from '../utils/requests-elsewhere';

/**
 * The Message requests list's card for each other community on this phone where requests wait, global among them (Marty,
 * 19 Nov 2026, decision 4 of DESIGN-no-switch-messaging-fable.md, slice S0; utils/requests-elsewhere.ts): how many people,
 * "In {community}", and a tap moves the phone there through the one switch and opens that community's Message requests
 * (app/(tabs)/chats.tsx `openOtherCommunity`). Their lines are read there: this phone reads one community's copy at a time.
 * While a move is under way the cards wait; a tap that moved nothing says so under them, in `note`. Drawn apart from the
 * list so the 320 dp harness (e2e/chat-s1-45-320.mjs) draws these very cards; the words wrap at any text size.
 */
export function RequestsElsewhereCards({ places, busy, note, onOpen }: {
    places: readonly RequestsPlace[];
    busy: boolean;
    note?: string | null;
    onOpen: (place: RequestsPlace) => void;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: {
            padding: 24,
            borderRadius: 16,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 16,
        },
        title: { fontSize: 15, fontWeight: '700', color: colors.text.body, marginBottom: 12, textAlign: 'center' },
        where: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, textAlign: 'center' },
        action: { fontSize: 14, fontWeight: '700', color: colors.text.body, textAlign: 'center' },
        note: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, textAlign: 'center', marginTop: 12 },
    }));
    if (places.length === 0) return null;
    return (
        <>
            {places.map((place) => (
                <Pressable
                    key={place.address}
                    accessibilityRole="button"
                    testID={`message-requests-in-${place.address}`}
                    style={[styles.card, busy && { opacity: 0.7 }]}
                    disabled={busy}
                    onPress={() => onOpen(place)}
                >
                    <Text style={styles.title}>{tn(place.count, '{n} person wants to message you', '{n} people want to message you')}</Text>
                    <Text style={styles.where}>{t('In {community}', { community: place.name })}</Text>
                    <Text style={styles.action}>{t('Open their requests there')}</Text>
                </Pressable>
            ))}
            {note ? <Text style={styles.note} accessibilityRole="alert" testID="message-requests-elsewhere-note">{note}</Text> : null}
        </>
    );
}

export default RequestsElsewhereCards;
