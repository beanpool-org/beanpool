/**
 * Settings → "🛡️ Manage <community>" ("Moderate <community>" for a moderator): shown ONLY to a member the node
 * itself says is an owner, admin or moderator. A moderator's /settings is Reports only; the node enforces that.
 *
 * The role is asked of the node each time Settings is focused (utils/node-admin.ts → GET /api/node-admin/me)
 * and never stored on disk, so there is nothing on the phone to edit into a button. Pressing it asks for the
 * phone's own unlock, gets a one-time sign-in link, and opens the node's /settings in an in-app browser tab
 * (Custom Tabs / SFSafariViewController). /settings is not an app link, so the tab keeps it. The press itself
 * is useManageNode, shared with the header's 🛡️ icon.
 *
 * For an owner or admin (not a moderator), "Names list" (app/names-list.tsx): the admins' list of members' real names,
 * sealed on admins' phones (community modes slice 2). Its routes refuse anyone else; the row only decides whether to offer.
 *
 * Once the node says the member holds a role, App Lock is turned on for them, once (LocalAuth.turnAppLockOnForRole,
 * decision D3): the phone's lock is a role holder's second factor since key sign-ins stopped asking for the node's code.
 *
 * Beside it, "Manage this community from a computer" ("Moderate …" for a moderator; app/settings-signin.tsx): scan the
 * QR on /settings in a computer's browser. Older apps call it "Sign in on a computer".
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { fetchMyNodeRole, rememberNodeRole, canManageNode, manageLabel, manageSubtitle, computerSigninLabel, type ManageRole } from '../utils/node-admin';
import { useManageNode } from './useManageNode';
import { useNodeProfile } from '../utils/use-node-profile';
import { offersNamesList } from '../utils/names-list';
import { issueBreakGlassCodeOnce, forgetBreakGlassCode } from '../utils/break-glass';
import { turnAppLockOnForRole, APP_LOCK_ON_FOR_ROLE } from '../utils/LocalAuth';

/** The Settings screen's own menu styles, so the entry looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function NodeAdminEntry({ styles, fallbackCommunityName, onAppLockTurnedOn }: {
    styles: MenuStyles;
    fallbackCommunityName?: string | null;
    /** Settings' App Lock switch, told when this turned App Lock on for a role holder. */
    onAppLockTurnedOn?: () => void;
}) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [role, setRole] = useState<ManageRole | null>(null);
    const [communityName, setCommunityName] = useState<string | null>(null);
    const { busy, start, dialog } = useManageNode();
    const profile = useNodeProfile();
    // While a break-glass code is being made (the unlock prompt, then the node): its row is disabled and shows so.
    const [issuing, setIssuing] = useState(false);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) setRole(null); return; }
                const mine = await fetchMyNodeRole(url, identity);
                // A new owner/admin/moderator: the header's 🛡️ icon picks it up now rather than when its own answer
                // expires. Only a positive: "no role" here may just mean the node was unreachable.
                if (canManageNode(mine.role)) rememberNodeRole(url, identity.publicKey, mine);
                if (cancelled) return;
                setRole(mine.role);
                setCommunityName(mine.communityName);
                if (canManageNode(mine.role) && (await turnAppLockOnForRole()) === 'turned-on' && !cancelled) {
                    onAppLockTurnedOn?.();
                    Alert.alert('App Lock is on', APP_LOCK_ON_FOR_ROLE(mine.communityName || fallbackCommunityName || 'your community'));
                }
            })().catch(() => { if (!cancelled) setRole(null); });
            return () => { cancelled = true; };
        }, [identity, onAppLockTurnedOn, fallbackCommunityName])
    );

    if (!canManageNode(role) || !identity) return null;

    // An owner's break-glass code: shown once, to write down; the phone keeps no copy (utils/break-glass.ts says why).
    // One at a time (issueBreakGlassCodeOnce, and the row is disabled meanwhile): a second code would retire the first.
    const breakGlass = async (community: string) => {
        const url = await getAnchorUrl();
        if (!url || !identity?.privateKey) return;
        setIssuing(true);
        try {
            const r = await issueBreakGlassCodeOnce(url, identity, community);
            if (!r.ok) {
                if (r.reason !== 'busy') Alert.alert('No break-glass code', r.message);
                return;
            }
            await forgetBreakGlassCode(url, identity.publicKey).catch(() => {});
            Alert.alert(
                'Your break-glass code',
                `${r.code}\n\nIt adds a new admin key if you lose this phone. Write it down and keep it offline, away from this phone: the app keeps no copy. It is shown only now; any earlier code no longer works, and signing out everywhere retires this one too.`,
                [{ text: 'I wrote it down', style: 'cancel' }],
            );
        } finally {
            setIssuing(false);
        }
    };
    const name = communityName || fallbackCommunityName || 'this community';
    const label = manageLabel(role, name);
    const computerLabel = computerSigninLabel(role);

    return (
        <>
            <Text style={styles.sectionHeader}>{role === 'moderator' ? 'COMMUNITY MODERATION' : 'COMMUNITY ADMIN'}</Text>
            <View style={styles.menuGroup}>
                <Pressable
                    style={[styles.menuBtn, { minHeight: 48 }]}
                    onPress={() => start(name)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityHint={role === 'moderator'
                        ? "Asks for your phone's unlock, then opens the community's reports in a browser tab"
                        : "Asks for your phone's unlock, then opens the community's admin settings in a browser tab"}
                    accessibilityState={{ busy, disabled: busy }}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{label}</Text>
                        <Text style={styles.menuSub}>{manageSubtitle(role)}</Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                </Pressable>
                {offersNamesList(role, profile?.profile) ? (
                    <Pressable
                        style={[styles.menuBtn, { minHeight: 48 }]}
                        onPress={() => router.push({ pathname: '/names-list', params: { community: name } })}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel="Names list"
                        accessibilityHint="Opens the admins' list of members' real names, on this phone. Only owners and admins can read it"
                    >
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📇</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Names list</Text>
                            <Text style={styles.menuSub}>Who your members are, by name · sealed on admins' phones</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                ) : null}
                {role === 'owner' ? (
                    <Pressable
                        style={[styles.menuBtn, { minHeight: 48 }]}
                        onPress={() => { breakGlass(name).catch(() => {}); }}
                        disabled={busy || issuing}
                        accessibilityRole="button"
                        accessibilityLabel="Break-glass code"
                        accessibilityHint="Asks for your phone's unlock, then shows a new break-glass code once. Your old code stops working"
                        accessibilityState={{ busy: issuing, disabled: busy || issuing }}
                    >
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Break-glass code</Text>
                            <Text style={styles.menuSub}>A spare way to add a new admin key · shown once</Text>
                        </View>
                        {issuing ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                    </Pressable>
                ) : null}
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={() => router.push({ pathname: '/settings-signin', params: { community: name } })}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={computerLabel}
                    accessibilityHint={`Scan the code on ${name}'s Settings page in a computer's browser to sign it in as you. Your key stays on this phone`}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💻</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{computerLabel}</Text>
                        <Text style={styles.menuSub}>Scan the code on its Settings page · your key stays on this phone</Text>
                    </View>
                    <Text style={styles.menuChevron}>›</Text>
                </Pressable>
            </View>

            {dialog}
        </>
    );
}
