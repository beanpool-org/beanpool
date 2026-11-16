/**
 * The thread's grey line when the key behind a chat changed and the chat carried on with the new one (DESIGN-dm-key-signal-model
 * §4, Signal's model): the person wasn't marked verified, so nothing stopped. The phone writes it from its own memory (the
 * pin's `changedAt`), so a node can't hide a key change from a phone that already had the chat. Information, never a warning:
 * neutral colours, a button that opens the key code screen, wrapping freely at 320 dp and 1.3× text. Words and styles live in
 * utils/dm-key-change.ts, where the small-screen and contrast rules are tested.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { dmKeyChangeStyleSpec, dmKeyChangedNoticeText } from '../../utils/dm-key-change';

export interface DmKeyChangedNoticeProps {
    peerName?: string | null;
    /** Opens the key code screen for this chat. */
    onPress: () => void;
}

export function DmKeyChangedNotice({ peerName, onPress }: DmKeyChangedNoticeProps) {
    const styles = useStyles(({ colors }) => dmKeyChangeStyleSpec(colors));
    const { colors } = useTheme();
    const words = dmKeyChangedNoticeText(peerName);
    return (
        <Pressable style={styles.notice} onPress={onPress} accessibilityRole="button" accessibilityLabel={words} testID="dm-key-changed-notice">
            <MaterialCommunityIcons name="key-change" size={16} color={colors.text.secondary} />
            <Text style={styles.noticeText}>{words}</Text>
        </Pressable>
    );
}
