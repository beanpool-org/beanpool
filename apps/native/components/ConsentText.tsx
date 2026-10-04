/**
 * A known community's consent text, readable at 320 dp and 130% text (rehearsal 5 Oct, d1): the summary, then "Read all
 * of it" for the rest, the trades an admin can see one per line. Not a word changed: utils/known-consent.ts
 * consentTextParts splits the node's text where it already breaks, and joined the parts are the text again.
 */
import React, { useState } from 'react';
import { Text, View, Pressable } from 'react-native';
import { useTheme } from '../app/ThemeContext';
import { consentTextParts } from '../utils/known-consent';

export function ConsentText({ text }: { text: string }) {
    const { colors } = useTheme();
    const [open, setOpen] = useState(false);
    const { summary, rest } = consentTextParts(text);
    const body = { color: colors.text.body, fontSize: 14, lineHeight: 20, marginTop: 6 } as const;
    return (
        <View>
            <Text style={body}>{summary}</Text>
            {open && rest.map((b, i) => b.item ? (
                <View key={i} style={{ flexDirection: 'row', marginTop: 4, paddingLeft: 4 }}>
                    <Text style={[body, { marginTop: 0, width: 16 }]} accessibilityElementsHidden importantForAccessibility="no">•</Text>
                    <Text style={[body, { marginTop: 0, flex: 1 }]}>{b.text}</Text>
                </View>
            ) : (
                <Text key={i} style={body}>{b.text}</Text>
            ))}
            {rest.length > 0 && (
                <Pressable
                    onPress={() => setOpen(!open)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    style={{ minHeight: 48, justifyContent: 'center' }}
                    testID="consent-read-all"
                >
                    <Text style={{ color: colors.brand.primary, fontSize: 14, fontWeight: '700' }}>{open ? 'Show less' : 'Read all of it'}</Text>
                </Pressable>
            )}
        </View>
    );
}
