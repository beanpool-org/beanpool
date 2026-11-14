import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { t, type ChatSide, type ChatSideEntry } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';

/**
 * The Chat tab's top where this community's forum is on (slice T0; DESIGN-forums-messaging-joint-fable.md §2.1): Chats ·
 * Forum, in the place of the big "Chat" title (core chatSides). Two tabs across, WhatsApp's top tabs: the side shown is
 * underlined, the other reads in the quieter colour. Drawn by app/(tabs)/chats.tsx above Messages · Groups · People, and
 * above the Forum's pane (components/forum/ForumPane.tsx).
 *
 * **No height added.** The title it replaces is PAGE_TITLE_TOP + its 36 dp line + PAGE_TITLE_BOTTOM: 48 dp, 58.8 dp with
 * text at 1.3x (the line scales, capped there). This row is one 44 dp touch row plus FRAME_SWITCH_BOTTOM: 48 dp at any text
 * size, its words capped at 1.3x too and shrinking to fit their half rather than growing the row
 * (utils/__tests__/chat-frame-render.test.ts holds both at 320 x 569 x 1.3).
 */
export const FRAME_SWITCH_ROW = 44;
export const FRAME_SWITCH_BOTTOM = 4;
const LABEL_SIZE = 17;
const LABEL_LINE = 22;

export function ChatFrameSwitch({ sides, side, onChange, testID }: {
    sides: ReadonlyArray<ChatSideEntry>;
    side: ChatSide;
    onChange: (side: ChatSide) => void;
    /** e2e selector (the Maestro smoke flow finds the Chat tab's top by it, title or switch). */
    testID?: string;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        bar: {
            flexDirection: 'row',
            marginHorizontal: 16,
            marginBottom: FRAME_SWITCH_BOTTOM,
        },
        tab: {
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: FRAME_SWITCH_ROW,
            paddingVertical: 6,
            paddingHorizontal: 8,
        },
        label: { fontSize: LABEL_SIZE, lineHeight: LABEL_LINE, fontWeight: '700', color: colors.text.secondary },
        labelActive: { color: colors.text.heading, fontWeight: '800' },
        // Inside the row's 44 dp, at its foot: the side shown.
        underline: { position: 'absolute', left: 8, right: 8, bottom: 0, height: 3, borderRadius: 2, backgroundColor: colors.accent.fill },
    }));
    return (
        <View style={styles.bar} accessibilityRole="tablist" accessibilityLabel={t('Chat')} testID={testID}>
            {sides.map((entry) => {
                const active = entry.id === side;
                return (
                    <Pressable
                        key={entry.id}
                        testID={`chat-side-${entry.id}`}
                        onPress={() => { if (!active) onChange(entry.id); }}
                        style={styles.tab}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={t(entry.label)}
                    >
                        {/* Half the row each: a longer name in another language shrinks to fit rather than being cut. */}
                        <Text
                            style={[styles.label, active && styles.labelActive]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.7}
                            maxFontSizeMultiplier={1.3}
                        >
                            {t(entry.label)}
                        </Text>
                        {active && <View style={styles.underline} pointerEvents="none" />}
                    </Pressable>
                );
            })}
        </View>
    );
}
