import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, AccessibilityInfo } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppColors } from '../../constants/colors';
import { HOME_TARGET_DP } from './HomeParts';

/**
 * A Home card's "…" menu (CARD-FRAME §1.3, design §10): Settings… (only on a type that has them), Move up, Move down,
 * Remove. A small sheet with items big enough for a thumb and for TalkBack. Remove asks nothing: a card is one tap to put
 * back from Add a card. The system Back button (and Escape on a keyboard) closes it, as Cancel does; a modal keeps the
 * screen reader inside it while open, and when it closes focus goes back to the "…" that opened it.
 */
export function HomeCardMenu({ visible, name, colors, canRemove, canUp, canDown, onSettings, onRemove, onUp, onDown, onClose, returnTo }: {
    visible: boolean;
    name: string;
    colors: AppColors;
    canRemove: boolean;
    canUp: boolean;
    canDown: boolean;
    /** Absent: the card's type has no settings, and the menu has no Settings… item. */
    onSettings?: () => void;
    onRemove: () => void;
    onUp: () => void;
    onDown: () => void;
    onClose: () => void;
    /** The "…" that opened it. */
    returnTo?: React.RefObject<View | null>;
}) {
    const insets = useSafeAreaInsets();
    const wasVisible = useRef(visible);
    useEffect(() => {
        if (wasVisible.current && !visible && returnTo?.current) {
            const target = returnTo.current;
            // After the modal has gone: TalkBack lands on the "…" again rather than the top of the screen.
            setTimeout(() => AccessibilityInfo.sendAccessibilityEvent?.(target, 'focus'), 250);
        }
        wasVisible.current = visible;
    }, [visible, returnTo]);

    const item = (label: string, a11y: string, on: boolean, run: () => void, testID: string) => (
        <Pressable
            key={testID}
            disabled={!on}
            onPress={() => { onClose(); run(); }}
            style={({ pressed }) => [s.item, pressed && { backgroundColor: colors.surface.subtle }]}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            accessibilityState={{ disabled: !on }}
            testID={testID}
        >
            <Text style={[s.itemText, { color: on ? colors.text.heading : colors.text.muted }]}>{label}</Text>
        </Pressable>
    );

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <Pressable style={s.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close card options">
                <Pressable style={[s.sheet, { backgroundColor: colors.surface.card, paddingBottom: 16 + insets.bottom }]} onPress={() => {}} accessible={false}>
                    <Text style={[s.title, { color: colors.text.secondary }]} accessibilityRole="header" accessibilityLabel={`Card options for ${name}`} numberOfLines={2}>{name}</Text>
                    {onSettings && item('Settings…', `Settings for ${name}`, true, onSettings, 'home-menu-settings')}
                    {item('Move up', `Move ${name} up`, canUp, onUp, 'home-menu-up')}
                    {item('Move down', `Move ${name} down`, canDown, onDown, 'home-menu-down')}
                    {item('Remove', `Remove ${name} from Home`, canRemove, onRemove, 'home-menu-remove')}
                    {item('Cancel', 'Cancel', true, () => {}, 'home-menu-cancel')}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const s = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, paddingBottom: 24, paddingHorizontal: 8 },
    title: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 12, paddingVertical: 10 },
    item: { minHeight: HOME_TARGET_DP + 4, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10 },
    itemText: { fontSize: 16, fontWeight: '600' },
});
