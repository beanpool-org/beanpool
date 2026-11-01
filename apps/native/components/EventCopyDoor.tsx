/**
 * What stands where Going and Interested stand on a member's copy of an event (DESIGN-list-on-global-fable.md §6): the
 * words of the door and the way through it, the community's own card, whose Ask to join sends nothing before its tap.
 * Every word from the directory row global holds (@beanpool/core eventCopyOf).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { copyDoorButton, copyDoorLine, type EventCopy } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { communityCardRoute } from '../utils/community-card-link';

export function EventCopyDoor({ copy }: { copy: EventCopy }) {
    const styles = useStyles(makeStyles);
    const button = copyDoorButton(copy);
    return (
        <View style={styles.door} testID="event-copy-door">
            <Text style={styles.line}>{copyDoorLine(copy)}</Text>
            {!!button && !!copy.from && (
                <Pressable onPress={() => router.push(communityCardRoute(copy.from!.url) as any)} style={styles.button} accessibilityRole="button" testID="event-copy-ask">
                    <Text style={styles.buttonText}>{button}</Text>
                </Pressable>
            )}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    door: { marginBottom: 14 },
    line: { fontSize: 15, fontWeight: '600', color: colors.text.body, lineHeight: 21, marginBottom: 10 },
    button: { minHeight: 48, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.brand.fill },
    buttonText: { fontSize: 15, fontWeight: '800', color: '#fff', textAlign: 'center' },
});
