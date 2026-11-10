/**
 * The one button an owner or admin sees on someone else's profile, following the person's state (invites-vouching I4,
 * DESIGN-invites-vouching-review-fable.md §3 ask 2; Marty, 10 Nov: the names list first, the voucher second):
 *
 *   Add to the names list    not on the list: opens the names list at its one-step add-and-confirm form, the name prefilled
 *                            with the callsign (names-list.tsx, `act=add`)
 *   Make a voucher           confirmed, and the viewer is on the credit committee: the names list's own Make a voucher form
 *   Voucher · 400 left ›     a voucher now: the voucher's card, here
 *
 * The state is the node's (the trust profile's `voucherButton`, engine/vouchers.ts profileVoucherButton); this never decides it,
 * and shows nothing for a state it does not know. The words are core's, so the web says the same. A budget left is not a balance.
 */
import React, { useState, type ComponentType } from 'react';
import { Modal, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { isProfileVoucherButton, profileVoucherButtonWords } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import type { VoucherCardProps } from './VoucherCard';
import type { BeanPoolIdentity } from '../utils/identity';

export function ProfileVoucherButton({ button, memberPubkey, callsign, anchorUrl, identity }: {
    button: unknown; memberPubkey: string; callsign: string; anchorUrl: string; identity: BeanPoolIdentity | null;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        button: {
            minHeight: 48, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1,
            borderColor: c.border.strong, backgroundColor: c.surface.card, justifyContent: 'center',
        },
        text: { fontSize: 15, fontWeight: '700', color: c.brand.primary },
    }));
    const [cardOpen, setCardOpen] = useState(false);
    // The card (and the names-list code behind it) is loaded when it is first wanted, not with every profile: a profile is read far
    // more often than a voucher's card is opened, and most profiles show no button at all.
    const [Card, setCard] = useState<ComponentType<VoucherCardProps> | null>(null);
    if (!isProfileVoucherButton(button)) return null;
    const words = profileVoucherButtonWords(button);
    const press = async () => {
        if (button.state === 'voucher') {
            if (!Card) {
                const loaded = await import('./VoucherCard');
                setCard(() => loaded.VoucherCard);
            }
            setCardOpen(true);
            return;
        }
        router.push({ pathname: '/names-list', params: { act: button.state, forMember: memberPubkey, forCallsign: callsign } });
    };
    return (
        <>
            <Pressable onPress={() => { void press(); }} accessibilityRole="button" accessibilityLabel={words} style={styles.button} testID="profile-voucher-button">
                <Text style={styles.text} maxFontSizeMultiplier={1.3}>{words}</Text>
            </Pressable>
            {button.state === 'voucher' ? (
                <Modal visible={cardOpen} animationType="slide" onRequestClose={() => setCardOpen(false)}>
                    {/* A full-screen Modal has no doodle pattern behind it: the solid surface.app, never the transparent surface.page. */}
                    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface.app }} edges={['top', 'left', 'right', 'bottom']} testID="profile-voucher-card-modal">
                        {cardOpen && Card && identity && anchorUrl ? (
                            <Card anchorUrl={anchorUrl} identity={identity} memberPubkey={memberPubkey} onClose={() => setCardOpen(false)} />
                        ) : null}
                    </SafeAreaView>
                </Modal>
            ) : null}
        </>
    );
}
