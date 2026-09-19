/**
 * Settings → "🛡️ Manage <community>": shown ONLY to a member the node itself says is an owner or admin.
 *
 * The role is asked of the node each time Settings is focused (utils/node-admin.ts → GET /api/node-admin/me)
 * and never stored on disk, so there is nothing on the phone to edit into a button. Pressing it asks for the
 * phone's own unlock, gets a one-time sign-in link, and opens the node's /settings in an in-app browser tab
 * (Custom Tabs / SFSafariViewController). /settings is not an app link, so the tab keeps it. The press itself
 * is useManageNode, shared with the header's 🛡️ icon.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { fetchMyNodeRole, rememberNodeRole, canManageNode, type ManageRole } from '../utils/node-admin';
import { useManageNode } from './useManageNode';

/** The Settings screen's own menu styles, so the entry looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function NodeAdminEntry({ styles, fallbackCommunityName }: { styles: MenuStyles; fallbackCommunityName?: string | null }) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [role, setRole] = useState<ManageRole | null>(null);
    const [communityName, setCommunityName] = useState<string | null>(null);
    const { busy, start, dialog } = useManageNode();

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) setRole(null); return; }
                const mine = await fetchMyNodeRole(url, identity);
                // A new owner/admin: the header's 🛡️ icon picks it up now rather than when its own answer
                // expires. Only a positive: "no role" here may just mean the node was unreachable.
                if (canManageNode(mine.role)) rememberNodeRole(url, identity.publicKey, mine);
                if (cancelled) return;
                setRole(mine.role);
                setCommunityName(mine.communityName);
            })().catch(() => { if (!cancelled) setRole(null); });
            return () => { cancelled = true; };
        }, [identity])
    );

    if (!canManageNode(role) || !identity) return null;
    const name = communityName || fallbackCommunityName || 'this community';

    return (
        <>
            <Text style={styles.sectionHeader}>COMMUNITY ADMIN</Text>
            <View style={styles.menuGroup}>
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={() => start(name)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Manage ${name}`}
                    accessibilityHint="Asks for your phone's unlock, then opens the community's admin settings in a browser tab"
                    accessibilityState={{ busy, disabled: busy }}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>Manage {name}</Text>
                        <Text style={styles.menuSub}>
                            {role === 'owner' ? "You're an owner" : "You're an admin"} · opens the node's settings, signed in as you
                        </Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                </Pressable>
            </View>

            {dialog}
        </>
    );
}
