/**
 * The Market's one line for a member of a community that syncs listings by area who has set no area (design §3.4): the
 * node gives them the newest listings worldwide, and the line says so, with the way to Settings → Your area. Never a gate:
 * the feed below works as for everyone. Nothing is fixed-width: at 320dp and 1.3x font the line wraps, and the whole line
 * is the one target (at least 44 high).
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors as defaultColors, type AppColors } from '../constants/colors';
import { NO_AREA_LINE } from '../utils/nearby-area';

export function NoAreaLine({ onPress, colors = defaultColors }: { onPress: () => void; colors?: AppColors }): React.JSX.Element {
    const tone = colors.feedback.info;
    return (
        <Pressable
            style={[styles.box, { backgroundColor: tone.bg, borderColor: tone.border }]}
            onPress={onPress}
            accessibilityRole="link"
            accessibilityLabel={`${NO_AREA_LINE.seeing} ${NO_AREA_LINE.action}`}
            testID="market-no-area-line"
        >
            <Text style={[styles.line, { color: colors.text.body }]}>
                📍 {NO_AREA_LINE.seeing} <Text style={[styles.action, { color: tone.fg }]}>{NO_AREA_LINE.action}</Text>
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    box: { borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
    line: { fontSize: 13, lineHeight: 18 },
    action: { fontWeight: '700', textDecorationLine: 'underline' },
});
