/**
 * A listing's photos while it is being written: each one with a ✕ to take it off, and a + that adds one (utils/post-photo.ts:
 * Camera or Gallery, nothing asked of the phone until one is tapped), up to the five a listing holds. The edit form's row
 * (app/post/[id].tsx), for a composer that keeps its photos in a list of data URLs.
 */
import React from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import { t } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { askForPostPhoto } from '../utils/post-photo';

/** The most photos a listing holds (the node keeps five: engine/posts.ts). */
export const MAX_POST_PHOTOS = 5;

export function PostPhotoRow({ photos, onChange, testID, required }: { photos: string[]; onChange: (next: string[]) => void; testID?: string; required?: boolean }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 8 },
        requiredStar: { color: colors.feedback.danger.solid },
        row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
        thumb: { width: 60, height: 60, borderRadius: 12, position: 'relative' },
        img: { width: 60, height: 60, borderRadius: 12 },
        remove: { position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.feedback.danger.solid, justifyContent: 'center', alignItems: 'center' },
        removeText: { color: colors.text.inverse, fontSize: 11, fontWeight: '800' },
        add: { width: 60, height: 60, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.border.strong, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.card },
        addIcon: { color: colors.text.muted, fontSize: 26 },
    }));
    // The newest list each time: two photos picked quickly both stay.
    const latest = React.useRef(photos);
    latest.current = photos;
    const add = () => askForPostPhoto((photo) => {
        if (latest.current.length >= MAX_POST_PHOTOS) return;
        latest.current = [...latest.current, photo];
        onChange(latest.current);
    });

    return (
        <View testID={testID}>
            <Text style={styles.label}>
                {t('PHOTOS ({n}/{max})', { n: photos.length, max: MAX_POST_PHOTOS })}
                {required ? <Text style={styles.requiredStar}> *</Text> : null}
            </Text>
            <View style={styles.row}>
                {photos.map((uri, i) => (
                    <View key={`${i}-${uri.length}`} style={styles.thumb}>
                        <Image accessibilityLabel={t('Post photo')} source={{ uri }} style={styles.img} />
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Remove photo')} accessibilityHint={t('Removes this photo')}
                            hitSlop={10} style={styles.remove} onPress={() => onChange(photos.filter((_, j) => j !== i))}>
                            <Text style={styles.removeText}>✕</Text>
                        </Pressable>
                    </View>
                ))}
                {photos.length < MAX_POST_PHOTOS && (
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Add photo')} style={styles.add} onPress={add}>
                        <Text style={styles.addIcon}>+</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
}
