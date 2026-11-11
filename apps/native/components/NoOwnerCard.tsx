import React from 'react';
import { View, Text, StyleSheet, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { t } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { claimRouteFor } from '../utils/claim-link';

/** A server that answered GET /api/local/claim with no owner and a code waiting (utils/node-claim.ts `unclaimed`). */
export interface OwnerlessServer {
    /** The address the claim screen opens with: a checked origin (utils/claim-link.ts claimNodeOrigin). */
    origin: string;
    /** The server's own name, cleaned (cleanClaimName), or its host when it gave none. */
    name: string;
    /** The waiting code's public id, so the claim screen knows which code to ask for. */
    codeId: string;
}

/**
 * "‹name› has no owner yet": a typed server address answered that it has no owner and a code waiting. Its one button opens
 * the claim screen (app/claim-community.tsx) on that server. Find a community shows it under its search box, and Settings'
 * "Add a community by address" shows it instead of saving the server as a community (DESIGN-new-operator-path-fable.md,
 * decision 1). The name is what the server says; the address under it is the real one.
 *
 * The words wrap at 320 dp and 1.3x: nothing is cut to a line count.
 */
export function NoOwnerCard({ server, style, testID }: { server: OwnerlessServer; style?: StyleProp<ViewStyle>; testID?: string }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 14, marginBottom: 10 },
        name: { fontSize: 17, fontWeight: '800', color: colors.text.heading },
        address: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        note: { fontSize: 14, color: colors.text.body, marginTop: 8, lineHeight: 20 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '800', textAlign: 'center' },
    }));
    return (
        <View style={[styles.card, style]} testID={testID}>
            <Text style={styles.name} accessibilityLiveRegion="polite">{t('{name} has no owner yet', { name: server.name })}</Text>
            <Text style={styles.address} selectable>{server.origin}</Text>
            <Text style={styles.note}>{t('If you installed it, claim it with the one-time code on the server.')}</Text>
            <View style={styles.actions}>
                <Pressable
                    style={styles.primary}
                    onPress={() => router.push(claimRouteFor({ node: server.origin, nodeRefused: false, codeId: server.codeId, code: null }) as any)}
                    accessibilityRole="button"
                >
                    <Text style={styles.primaryText}>{t('Claim {name}', { name: server.name })}</Text>
                </Pressable>
            </View>
        </View>
    );
}
