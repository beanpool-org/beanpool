/**
 * "Not seen yet." under the sender's own line, in grey (DESIGN-notify-and-backup-asks-fable §4.5; amendment 2 §12.3, N4).
 * Core's notSeenInThread decides which line carries it and notSeenWords writes it; this only draws it, at the line's side.
 * A fact, not a button: nothing to tap. It wraps at 320 dp and 1.3× text rather than cut its words.
 */

import React from 'react';
import { Text } from 'react-native';
import { useTheme } from '../../app/ThemeContext';

export function NotSeenLine({ text }: { text: string }) {
    const { colors } = useTheme();
    return (
        <Text
            testID="not-seen-line"
            style={{ alignSelf: 'flex-end', maxWidth: '85%', marginTop: 2, marginBottom: 4, fontSize: 12, lineHeight: 16, color: colors.text.secondary, textAlign: 'right' }}
        >
            {text}
        </Text>
    );
}
