/**
 * The join steps' main button, kept on screen (Damo, 9 Nov: "the counter-intuitive 'Next' button and the following 'Let's
 * Begin!' buttons being right on the bottom of the screen and forcing me to scroll down before I can even see them").
 *
 * Drawn under the step's scroll view, not at the end of it: the step's words scroll above it, and the button stays put above
 * the system bar at rest and above the keyboard while typing (a KeyboardStickyView, as app/group-post.tsx's footer). The
 * screen is never a Modal, so the root layout's KeyboardProvider serves it (never a KeyboardProvider inside a Modal).
 *
 * Opaque on surface.chrome, never surface.page: the doodle pattern turns the page token see-through.
 *
 * Its measured height goes back to the step through `onHeight`, so a KeyboardAwareScrollView above it keeps the field being
 * typed in clear of the keyboard AND this footer (its bottomOffset).
 */
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../app/ThemeContext';

export function StepFooter({ children, onHeight, testID }: { children: React.ReactNode; onHeight?: (height: number) => void; testID?: string }) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    return (
        // iOS reports the keyboard's height with the home-indicator strip, which the screen's SafeAreaView already keeps under
        // the footer; Android's keyboard height already leaves the navigation bar out (as app/group-post.tsx).
        <KeyboardStickyView offset={{ opened: Platform.OS === 'ios' ? insets.bottom : 0 }} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
            <View
                testID={testID}
                style={[
                    styles.footer,
                    {
                        // Opaque: the step's words scroll under it. surface.page turns 'transparent' when the doodle pattern is
                        // on (app/ThemeContext.tsx); chrome is the pattern's ground then, as the tab strip's.
                        backgroundColor: colors.surface.chrome,
                        borderTopColor: colors.border.default,
                        // The screen's SafeAreaView pads iOS only: on an Android phone drawn edge to edge the footer stays above
                        // its navigation bar. Zero where the bar isn't drawn over.
                        paddingBottom: 12 + (Platform.OS === 'android' ? insets.bottom : 0),
                    },
                ]}
            >
                <View style={styles.inner}>{children}</View>
            </View>
        </KeyboardStickyView>
    );
}

const styles = StyleSheet.create({
    footer: { paddingTop: 12, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
    // A tablet's width: the button keeps a phone's reach and reads as one button, centred.
    inner: { width: '100%', maxWidth: 560, alignSelf: 'center' },
});
