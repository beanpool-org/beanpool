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
 *
 * For an owner of a community its members reach by its server's public number, with no name yet, the nudge under Manage
 * (utils/address-follow.ts numberNudge; DESIGN-https-anywhere-fable.md §3, D3): a name follows the community, a number
 * doesn't. Words only: never a gate, never a deadline.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { fetchMyNodeRole, rememberNodeRole, canManageNode, type ManageRole } from '../utils/node-admin';
import { useManageNode } from './useManageNode';
import { useNodeProfile } from '../utils/use-node-profile';
import type { NodeFeatures } from '../utils/node-profile';
import { offersNamesList } from '../utils/names-list';
import { issueBreakGlassCodeOnce, forgetBreakGlassCode } from '../utils/break-glass';
import { signOutEverywhereOnce, signOutEverywhereDone } from '../utils/sign-out-everywhere';
import { turnAppLockOnForRole } from '../utils/LocalAuth';
import { numberNudge, numberOnlyAddress } from '../utils/address-follow';
import { t } from '@beanpool/core';
import {
    appLockOnForRoleWords, computerSigninLabelWords, howThisCommunityWorksLabelWords, howThisCommunityWorksSubtitleWords, manageLabelWords, manageSubtitleWords, settingsLineWords, signOutEverywhereWarningWords,
} from './settings/settings-lines';
import { CommunityShapeSheet } from './CommunityShapeSheet';

/** The Settings screen's own menu styles, so the entry looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function NodeAdminEntry({ styles, fallbackCommunityName, onAppLockTurnedOn, onRoleChange, activeFeatures }: {
    styles: MenuStyles;
    fallbackCommunityName?: string | null;
    /** Settings' App Lock switch, told when this turned App Lock on for a role holder. */
    onAppLockTurnedOn?: () => void;
    /** Told when the role is determined or changed, so Settings knows whether to draw the Community section for non-role holders. */
    onRoleChange?: (role: ManageRole | null) => void;
    activeFeatures?: NodeFeatures | null;
}) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [role, setRole] = useState<ManageRole | null>(null);
    const [shapeOpen, setShapeOpen] = useState(false);
    const [communityName, setCommunityName] = useState<string | null>(null);
    // The community's address on this phone, for the owner's nudge when it is the server's number.
    const [anchor, setAnchor] = useState<string | null>(null);
    const { busy, start, dialog } = useManageNode();
    const profile = useNodeProfile();
    // While a break-glass code is being made (the unlock prompt, then the node): its row is disabled and shows so. The
    // ref is the guard: a second tap that lands before the row re-renders disabled returns at once, so it can never
    // clear the spinner while the first ask is still running (#1548 review NB2).
    const [issuing, setIssuing] = useState(false);
    const issuingRef = useRef(false);
    // "Sign out everywhere": the same one-at-a-time guard.
    const [signingOut, setSigningOut] = useState(false);
    const signingOutRef = useRef(false);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) { setRole(null); onRoleChange?.(null); } return; }
                const mine = await fetchMyNodeRole(url, identity);
                // A new owner/admin/moderator: the header's 🛡️ icon picks it up now rather than when its own answer
                // expires. Only a positive: "no role" here may just mean the node was unreachable.
                if (canManageNode(mine.role)) rememberNodeRole(url, identity.publicKey, mine);
                if (cancelled) return;
                setRole(mine.role);
                onRoleChange?.(mine.role);
                setCommunityName(mine.communityName);
                setAnchor(url);
                if (canManageNode(mine.role) && (await turnAppLockOnForRole()) === 'turned-on' && !cancelled) {
                    onAppLockTurnedOn?.();
                    Alert.alert(t('App Lock is on'), appLockOnForRoleWords(mine.communityName || fallbackCommunityName || t('your community')));
                }
            })().catch(() => { if (!cancelled) { setRole(null); onRoleChange?.(null); } });
            return () => { cancelled = true; };
        }, [identity, onAppLockTurnedOn, fallbackCommunityName])
    );

    if (!canManageNode(role) || !identity) return null;

    // An owner's break-glass code: shown once, to write down; the phone keeps no copy (utils/break-glass.ts says why).
    // One at a time (issueBreakGlassCodeOnce, and the row is disabled meanwhile): a second code would retire the first.
    const breakGlass = async (community: string) => {
        if (issuingRef.current) return;
        issuingRef.current = true;
        setIssuing(true);
        try {
            const url = await getAnchorUrl();
            if (!url || !identity?.privateKey) return;
            const r = await issueBreakGlassCodeOnce(url, identity, community);
            if (!r.ok) {
                if (r.reason !== 'busy') Alert.alert(t('No break-glass code'), settingsLineWords(r.message));
                return;
            }
            await forgetBreakGlassCode(url, identity.publicKey).catch(() => {});
            Alert.alert(
                t('Your break-glass code'),
                t('{code}\n\nIt adds a new admin key if you lose this phone. Write it down and keep it offline, away from this phone: the app keeps no copy. It is shown only now; any earlier code no longer works, and "Sign out everywhere" (below) retires this one too.', { code: r.code }),
                [{ text: t('I wrote it down'), style: 'cancel' }],
            );
        } finally {
            issuingRef.current = false;
            setIssuing(false);
        }
    };

    // Ends every Settings sign-in of this member's, on every computer and phone (an owner's break-glass code with them),
    // after a plain confirm. The key stays on this phone, so Manage signs in again.
    const signOutAll = async () => {
        if (signingOutRef.current) return;
        signingOutRef.current = true;
        setSigningOut(true);
        try {
            const url = await getAnchorUrl();
            if (!url || !identity?.privateKey) return;
            const r = await signOutEverywhereOnce(url, identity);
            if (!r.ok) {
                if (r.reason !== 'busy') Alert.alert(t('Not signed out'), settingsLineWords(r.message));
                return;
            }
            Alert.alert(t('Signed out everywhere'), settingsLineWords(signOutEverywhereDone(r)));
        } finally {
            signingOutRef.current = false;
            setSigningOut(false);
        }
    };
    const confirmSignOutAll = (community: string) => {
        Alert.alert(t('Sign out everywhere?'), signOutEverywhereWarningWords(community, role === 'owner'), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Sign out everywhere'), style: 'destructive', onPress: () => { signOutAll().catch(() => {}); } },
        ]);
    };
    const name = communityName || fallbackCommunityName || t('this community');
    const label = manageLabelWords(role, name);
    const computerLabel = computerSigninLabelWords(role);
    // Public Address is the owners' (the node's Settings), so the nudge is theirs. The addresses are the profile's copy.
    const numberOnly = role === 'owner' ? numberOnlyAddress(anchor, profile?.addresses) : null;

    return (
        <>
            <Text style={styles.sectionHeader}>{role === 'moderator' ? t('COMMUNITY MODERATION') : t('COMMUNITY ADMIN')}</Text>
            <View style={styles.menuGroup}>
                <Pressable
                    style={[styles.menuBtn, { minHeight: 48 }]}
                    onPress={() => start(name)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityHint={role === 'moderator'
                        ? t("Asks for your phone's unlock, then opens the community's reports in a browser tab")
                        : t("Asks for your phone's unlock, then opens the community's admin settings in a browser tab")}
                    accessibilityState={{ busy, disabled: busy }}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{label}</Text>
                        <Text style={styles.menuSub}>{manageSubtitleWords(role)}</Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                </Pressable>
                {numberOnly ? (
                    <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle }} testID="owner-number-nudge">
                        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text.body }}>{numberNudge(numberOnly)}</Text>
                    </View>
                ) : null}
                <Pressable
                    style={[styles.menuBtn, { minHeight: 48 }]}
                    onPress={() => setShapeOpen(true)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={howThisCommunityWorksLabelWords()}
                    testID="settings-how-this-community-works"
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🧭</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{howThisCommunityWorksLabelWords()}</Text>
                        <Text style={styles.menuSub}>{howThisCommunityWorksSubtitleWords()}</Text>
                    </View>
                    <Text style={styles.menuChevron}>›</Text>
                </Pressable>
                {offersNamesList(role, profile?.profile) ? (
                    <Pressable
                        style={[styles.menuBtn, { minHeight: 48 }]}
                        onPress={() => router.push({ pathname: '/names-list', params: { community: name } })}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={t('Names list')}
                        accessibilityHint={t("Opens the admins' list of members' real names, on this phone. Only owners and admins can read it")}
                    >
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📇</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t('Names list')}</Text>
                            <Text style={styles.menuSub}>{t("Who your members are, by name · sealed on admins' phones")}</Text>
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
                        accessibilityLabel={t('Break-glass code')}
                        accessibilityHint={t("Asks for your phone's unlock, then shows a new break-glass code once. Your old code stops working")}
                        accessibilityState={{ busy: issuing, disabled: busy || issuing }}
                    >
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t('Break-glass code')}</Text>
                            <Text style={styles.menuSub}>{t('A spare way to add a new admin key · shown once')}</Text>
                        </View>
                        {issuing ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                    </Pressable>
                ) : null}
                <Pressable
                    style={[styles.menuBtn, { minHeight: 48 }]}
                    onPress={() => confirmSignOutAll(name)}
                    disabled={busy || signingOut}
                    accessibilityRole="button"
                    accessibilityLabel={t('Sign out everywhere')}
                    accessibilityHint={t("Asks first, then ends your sign-ins to {name}'s Settings on every computer and phone. Your key stays on this phone", { name })}
                    accessibilityState={{ busy: signingOut, disabled: busy || signingOut }}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚪</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{t('Sign out everywhere')}</Text>
                        <Text style={styles.menuSub}>{t('Ends your Settings sign-ins on every computer and phone')}</Text>
                    </View>
                    {signingOut ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                </Pressable>
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={() => router.push({ pathname: '/settings-signin', params: { community: name } })}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={computerLabel}
                    accessibilityHint={t("Scan the code on {name}'s Settings page in a computer's browser to sign it in as you. Your key stays on this phone", { name })}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💻</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{computerLabel}</Text>
                        <Text style={styles.menuSub}>{t('Scan the code on its Settings page or connect an AI assistant · your key stays on this phone')}</Text>
                    </View>
                    <Text style={styles.menuChevron}>›</Text>
                </Pressable>
            </View>

            {dialog}
            <CommunityShapeSheet
                features={activeFeatures ?? profile?.features}
                visible={shapeOpen}
                onClose={() => setShapeOpen(false)}
            />
        </>
    );
}
