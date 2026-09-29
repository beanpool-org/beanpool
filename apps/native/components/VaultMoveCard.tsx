/**
 * Settings → the move card (key vault design §5.1; utils/vault-move.ts): "Move your Google recovery to BeanPool's key
 * vault. One sign-in." Shown when the community the phone is on still keeps a sign-in copy that the vault doesn't, or
 * when a sign-in the member tried to link while the vault was paused is still unlinked. One sign-in (the ordinary
 * connect sheet), then the community's copy comes off with a signed delete. "Not now" puts it away for a week.
 *
 * Looked up in the background on each focus of Settings; nothing waits for it, and an answer that doesn't come shows
 * no card. It never blocks anything.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { colors } from '../constants/colors';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { SSO_PROVIDER_NAMES } from '../utils/sso-providers';
import { finishMove, moveLater, vaultMoveOffer, type VaultMoveOffer } from '../utils/vault-move';
import type { KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { SsoEnrolSheet } from './SsoEnrolSheet';

export const VAULT_MOVE_COPY = {
    moveTitle: (name: string) => `Move your ${name} recovery to BeanPool's key vault`,
    moveBody: (name: string) => `One sign-in. Today your community keeps the copy of your account that ${name} opens. `
        + "BeanPool's key vault keeps it instead, for every community, and your community's copy is removed.",
    moveButton: 'Move it',
    retryTitle: (name: string) => `Link your ${name} sign-in`,
    retryBody: (name: string) => `You tried to link ${name} while BeanPool's key vault was paused, so it isn't linked yet. `
        + 'It takes one sign-in.',
    retryButton: 'Link it',
    later: 'Not now',
} as const;

export function VaultMoveCard({ onMoved }: { onMoved?: (result: KeeperEnrolmentResult) => void }) {
    const { identity } = useIdentity();
    const [offer, setOffer] = useState<VaultMoveOffer | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                if (!identity?.privateKey) return;
                const found = await vaultMoveOffer(identity, await getAnchorUrl());
                if (!cancelled) setOffer(found);
            })().catch(() => { if (!cancelled) setOffer(null); });
            return () => { cancelled = true; };
        }, [identity])
    );

    if (!offer || !identity) return null;
    const name = SSO_PROVIDER_NAMES[offer.provider];
    const move = offer.kind === 'move';

    return (
        <View style={styles.card} accessibilityRole="summary">
            <Text style={styles.title} accessibilityRole="header">{move ? VAULT_MOVE_COPY.moveTitle(name) : VAULT_MOVE_COPY.retryTitle(name)}</Text>
            <Text style={styles.body}>{move ? VAULT_MOVE_COPY.moveBody(name) : VAULT_MOVE_COPY.retryBody(name)}</Text>
            <Pressable style={styles.primary} onPress={() => setSheetOpen(true)} accessibilityRole="button">
                <Text style={styles.primaryText}>{move ? VAULT_MOVE_COPY.moveButton : VAULT_MOVE_COPY.retryButton}</Text>
            </Pressable>
            <Pressable
                style={styles.secondary}
                onPress={async () => {
                    await moveLater(identity);
                    setOffer(null);
                }}
                accessibilityRole="button"
            >
                <Text style={styles.secondaryText}>{VAULT_MOVE_COPY.later}</Text>
            </Pressable>
            <SsoEnrolSheet
                visible={sheetOpen}
                provider={offer.provider}
                onClose={() => setSheetOpen(false)}
                onEnrolled={async (result) => {
                    // The vault has it now: the community's copy goes (utils/vault-move.ts `finishMove`).
                    await finishMove(identity, offer);
                    setOffer(null);
                    onMoved?.(result);
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.feedback.warning.bg,
        borderColor: colors.feedback.warning.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.feedback.warning.fg,
        marginBottom: 6,
    },
    body: {
        fontSize: 13,
        lineHeight: 19,
        color: colors.text.body,
        marginBottom: 12,
    },
    primary: {
        backgroundColor: colors.brand.primary,
        borderRadius: 12,
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    primaryText: {
        color: colors.text.inverse,
        fontSize: 15,
        fontWeight: '700',
    },
    secondary: {
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    secondaryText: {
        color: colors.text.secondary,
        fontSize: 15,
    },
});
