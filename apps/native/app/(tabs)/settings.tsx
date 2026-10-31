import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, Share, Linking, Platform, AppState, Modal, RefreshControl } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { useIdentity } from '../IdentityContext';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AvatarPickerSheet } from '../../components/AvatarPickerSheet';
import { updateCallsign, hasMnemonic } from '../../utils/identity';
import { namesCopiesBeforeSignOut, signOutOfThisPhone } from '../../utils/account-leaves-phone';
import { NAMES_COPY, namesSignOutWords } from '../../utils/names-list';
import {
    DELETE_CARD_LINE, DELETE_CHECKING_LINE, SIGN_OUT_INSTEAD_LINE, deleteAccountHere, finishLastDelete, planDelete,
    type DeleteOutcome, type DeletePlan, type VaultCopyChoice,
} from '../../utils/delete-here';
import { hapticTick } from '../../utils/haptics';
import { buildSignedHeaders } from '../../utils/crypto';
import { updateMemberProfile, getMemberProfile, fetchNodeCallsign, signedRequest, signedGet, resetDmChatMemory } from '../../utils/db';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, normaliseReminderOffsets, parseReminderOffsets,
} from '../../utils/event-extras';
import { getCanonicalProfile } from '../../utils/canonical-profile';
import { explicitEditAvatar, resolveProfilePublishAvatar, retireParkedPickAfterPublish, type ProfilePublishAvatar } from '../../utils/avatar-value';
import {
    keepPendingProfileChange, nameRefusedForGood, pendingNameAccepted, pendingNameRefused, pendingProfileChange, takeNameRefusal,
} from '../../utils/pending-profile-sync';
import { MemberAvatar } from '../../components/MemberAvatar';
import { getBlockedUsers, unblockUser, clearBlocklist } from '../../utils/blocklist';
import { getSavedNodes, SavedNode, removeSavedNode, getDatabaseFilenameForNode, recordRequestSigning } from '../../utils/nodes';
import { isPlainNodeAddress, UNSAFE_NODE_ADDRESS_MESSAGE } from '../../utils/node-url';
import { withNodeScheme } from '../../utils/node-address-scheme';
import { fetchMembership } from '../../utils/membership-probe';
import { remoteOwnTransactionCount } from '../../utils/diagnostics-own-count';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { communitySwitched } from '../../utils/community-switch';
import Constants from 'expo-constants';
import appConfig from '../../app.json';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { THEME_PREFERENCE_OPTIONS } from '../../utils/theme-preference';
import { APP_LOCK_NEEDS_SCREEN_LOCK, authenticateUser, getAppLockEnabled, getScreenLock, setAppLockEnabled } from '../../utils/LocalAuth';
import { readWordsBehindLock } from '../../utils/words-behind-lock';
import { usePutAwayAfterLeave } from '../../utils/words-put-away';
import { KeeperProtectionPanel } from '../../components/KeeperProtectionPanel';
import { CommunityAdminsRow } from '../../components/CommunityAdminsRow';
import { KnownConsentCard } from '../../components/KnownConsentCard';
import { NoWordsNotice } from '../../components/NoWordsNotice';
import { AddWordsForm } from '../../components/AddWordsForm';
import { CopyClearsNote, NoScreenCapture, NoScreenLockNote } from '../../components/WordsOnScreen';
import { RecoveryKitButtons } from '../../components/RecoveryKitButtons';
import { copyWordsForAMinute } from '../../utils/words-clipboard';
import { ADD_WORDS_COPY, viewWordsOpens } from '../../utils/add-words';
import {
    NO_WORDS_CHECK_FIRST, NO_WORDS_CONNECT, NO_WORDS_MENU, NO_WORDS_SIGN_OUT_ALERT, NO_WORDS_VIEW_LINE, VIEW_WORDS_MENU,
    noWordsBeforeWipe,
} from '../../utils/no-words-copy';
import { RecoveryAlertBanner } from '../../components/RecoveryAlertBanner';
import { SsoEnrolSheet } from '../../components/SsoEnrolSheet';
import { protectionFrom } from '../../utils/protection-state';
import { enrolmentFromVault, vaultProtection, type KeeperEnrolmentResult } from '../../utils/keeper-enrolment';
import { hasVault, signInCopiesAt, VAULT_MESSAGES, VaultError, type SignInCopies } from '../../utils/vault';
import { copiesRuleForScreen } from '../../utils/copies-rule';
import { VaultMoveCard } from '../../components/VaultMoveCard';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../../utils/sso-providers';
import { signedPost, anchorUrl as getAnchorUrl } from '../../utils/node-post';
import { parseArchetype, FEEDBACK_LIVE, beanPoolSettingsEntries, CONTACT_VALUE_LIMIT, knockSwitchShown, PEEK_WORDS, t, word, formatNumber, type QuizResult } from '@beanpool/core';
import { openBeanPoolWebsite } from '../../utils/beanpool-links';
import { PricingGuideModal } from '../../components/PricingGuideModal';
import { useNodeProfile } from '../../utils/use-node-profile';
import { useOwnProfile } from '../../utils/use-own-profile';
import { nearbyListingsOn, areaRowLine } from '../../utils/member-area';
import { beansOn, effectiveFeatures, shareOutsideOn } from '../../utils/node-profile';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { NodeAdminEntry } from '../../components/NodeAdminEntry';
import { CommunityShapeSheet } from '../../components/CommunityShapeSheet';
import { howThisCommunityWorksLabelWords, howThisCommunityWorksSubtitleWords } from '../../components/settings/settings-lines';
import { askNodeRole, canManageNode } from '../../utils/node-admin';
import { MyKeyCodeCard } from '../../components/MyKeyCodeCard';
import { ChatMemoryCard } from '../../components/ChatMemoryCard';
import { CHAT_MEMORY_COPY } from '../../utils/chat-memory';
import { communityName } from '../../utils/community-name';
import { useGlobalEntry } from '../../utils/use-global-entry';
import { useGlobalGuestVisit } from '../../utils/use-global-guest-visit';
import { isGlobalInUse } from '../../utils/one-way-back';
import { OwnerWordsCard } from '../../components/OwnerWordsCard';
import { OneWayBackCard } from '../../components/OneWayBackCard';
import { BlockedFriendRemove } from '../../components/BlockedFriendRemove';
import { LanguageRow } from '../../components/LanguagePicker';
import {
    deleteFailedWords, deletePlanFailedWords, deletedButWords, keepsKeyWords, lastCommunityWords, listNameWords, reminderBeforeWords,
    settingsLineWords, vaultCopyStaysWords,
} from '../../components/settings/settings-lines';
import { signedRequestWords } from '../../components/signed-request-lines';
import { welcomeLineWords } from '../../components/welcome/welcome-lines';


function getDatabaseFilePaths(dbFilename: string): string[] {
    if (!FileSystem.documentDirectory) return [];
    const docDir = FileSystem.documentDirectory;
    
    if (Platform.OS === 'android') {
        const path = docDir.endsWith('/files/')
            ? docDir.slice(0, -7) + '/databases/' + dbFilename
            : docDir.includes('/files')
                ? docDir.replace('/files', '/databases') + dbFilename
                : docDir + 'databases/' + dbFilename;
        return [path];
    } else if (Platform.OS === 'ios') {
        const devPath = docDir + 'SQLite/' + dbFilename;
        const prodPath = docDir.endsWith('/Documents/')
            ? docDir.slice(0, -11) + '/Library/Application Support/SQLite/' + dbFilename
            : docDir.includes('/Documents')
                ? docDir.replace('/Documents', '/Library/Application Support/SQLite') + dbFilename
                : docDir + 'SQLite/' + dbFilename;
        return [devPath, prodPath];
    }
    return [docDir + 'SQLite/' + dbFilename];
}

export default function SettingsScreen() {
    const { theme, colors, themePreference, setThemePreference, patternEnabled, setPatternEnabled } = useTheme();
    const { identity, setIdentity } = useIdentity();

    const styles = useStyles(({ theme, colors, patternEnabled }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: patternEnabled ? colors.surface.page : (theme === 'dark' ? colors.surface.app : palette.grayAlt100) },
        content: { padding: 20, paddingTop: 16, paddingBottom: 48 },

        // ─── Identity Dashboard ───
        identityCard: {
            borderRadius: 20, marginBottom: 28, overflow: 'hidden',
            backgroundColor: palette.emerald950, // Premium very dark green
            shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 16, elevation: 6,
            borderWidth: 1, borderColor: palette.emerald800,
        },
        identityInner: {
            alignItems: 'center', paddingVertical: 28, paddingHorizontal: 20,
        },
        editBadge: {
            position: 'absolute', top: 16, right: 16,
            backgroundColor: palette.emerald800, paddingHorizontal: 12, paddingVertical: 6,
            borderRadius: 20, borderWidth: 1, borderColor: colors.brand.primary,
        },
        editBadgeText: { fontSize: 13, color: palette.emerald200, fontWeight: 'bold' },
        avatarWrap: {
            width: 96, height: 96, borderRadius: 48,
            marginBottom: 16, position: 'relative',
        },
        avatarRing: {
            position: 'absolute', top: -3, left: -3, right: -3, bottom: -3,
            borderRadius: 51, borderWidth: 2.5, borderColor: palette.emerald400,
        },
        callsignText: {
            fontSize: 24, fontWeight: '800', color: colors.text.inverse, letterSpacing: 0.5, marginBottom: 4,
        },
        communitySubtext: {
            fontSize: 13, color: palette.emerald200, textAlign: 'center',
            marginBottom: 8, paddingHorizontal: 12,
        },
        bioText: {
            fontSize: 14, color: palette.emerald200, lineHeight: 20, textAlign: 'center',
            marginBottom: 12, paddingHorizontal: 12, fontStyle: 'italic',
        },
        contactRow: {
            flexDirection: 'row', alignItems: 'center', marginBottom: 16,
            backgroundColor: palette.emerald900, paddingHorizontal: 12, paddingVertical: 6,
            borderRadius: 16, borderWidth: 1, borderColor: palette.emerald800,
        },
        contactText: { fontSize: 13, color: palette.emerald100, marginLeft: 6, fontWeight: '600' },
        pubkeyRow: {
            flexDirection: 'row', alignItems: 'center',
            backgroundColor: palette.emerald950, paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 20, borderWidth: 1, borderColor: palette.emerald800,
        },
        pubkeyText: { fontSize: 13, color: palette.emerald300, fontFamily: 'Courier', letterSpacing: 1 },

        // ─── Section Headers ───
        // Written in capitals in the words themselves (never textTransform, which upper-cases a translation by the
        // phone's rules, not its language's).
        sectionHeader: {
            fontSize: 11, fontWeight: '800', color: colors.text.muted, letterSpacing: 1,
            marginBottom: 8, marginTop: 24, marginLeft: 4,
        },

        // ─── Menu Groups ───
        menuGroup: {
            backgroundColor: colors.surface.card, borderRadius: 16,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8,
            elevation: 2, overflow: 'hidden',
        },
        menuBtn: {
            flexDirection: 'row', alignItems: 'center', padding: 14, paddingVertical: 13,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        menuBtnLast: { borderBottomWidth: 0 },
        reminderRow: {
            flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        reminderTick: {
            width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.accent.primary,
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        },
        reminderTickOn: { backgroundColor: colors.accent.fill },
        reminderTickMark: { color: colors.text.onAccent, fontSize: 14, fontWeight: '900', lineHeight: 16 },
        reminderLabel: { flex: 1, fontSize: 15, color: colors.text.body },
        reminderNote: { fontSize: 12, color: colors.text.secondary, paddingHorizontal: 14, paddingVertical: 10 },
        menuIconWrap: {
            width: 36, height: 36, borderRadius: 12,
            backgroundColor: theme === 'dark' ? 'rgba(34, 197, 94, 0.15)' : palette.green50,
            justifyContent: 'center', alignItems: 'center', marginRight: 12,
        },
        menuIcon: { fontSize: 18 },
        menuText: { fontSize: 15, fontWeight: '600', color: colors.text.body },
        menuSub: { fontSize: 12, color: colors.text.muted, marginTop: 1 },
        menuChevron: { fontSize: 22, color: colors.border.strong, fontWeight: '300', marginLeft: 8 },

        // ─── Toggle ───
        toggle: {
            width: 50, height: 28, borderRadius: 14,
            backgroundColor: colors.border.default, justifyContent: 'center', paddingHorizontal: 2,
        },
        toggleOn: { backgroundColor: colors.brand.fill },
        toggleThumb: {
            width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surface.card,
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
        },
        toggleThumbOn: { transform: [{ translateX: 22 }] },

        // ─── Appearance (Same as phone / Light / Dark) ───
        // Three equal segments that wrap rather than truncate: "Same as phone" takes two lines at
        // 320dp + 1.3x text, and every segment keeps a 48dp touch target. A longer language's words shrink (to 0.6) to
        // stay whole on their two lines.
        appearanceBlock: {
            padding: 14,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        appearanceHeader: { flexDirection: 'row', alignItems: 'center' },
        segmentRow: {
            flexDirection: 'row', marginTop: 12, padding: 3, gap: 3,
            borderRadius: 12, backgroundColor: colors.surface.subtle,
        },
        segment: {
            flex: 1, minHeight: 48, borderRadius: 9,
            alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 6,
        },
        segmentSelected: {
            backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.brand.primary,
        },
        segmentText: { fontSize: 13, fontWeight: '500', color: colors.text.secondary, textAlign: 'center' },
        segmentTextSelected: { fontWeight: '700', color: colors.text.heading },

        // ─── Danger Zone ───
        dangerGroup: {
            backgroundColor: colors.surface.card, borderRadius: 16, overflow: 'hidden',
            borderWidth: 1, borderColor: colors.feedback.danger.border,
        },

        // ─── Version ───
        versionText: {
            textAlign: 'center', marginTop: 32, fontSize: 12,
            color: colors.border.strong, fontWeight: '700', letterSpacing: 1.5,
        },

        // ─── Shared (sub-screens) ───
        card: {
            backgroundColor: colors.surface.card, borderRadius: 16, padding: 20,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8,
            elevation: 2, marginBottom: 24,
        },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 4, marginTop: 12 },
        value: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
        sectionTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 16 },
        input: {
            backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default,
            borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16,
        },
        // The brand pair, never a text token as a fill: text.heading and text.inverse are both white in dark (Damo, 29 Oct).
        primaryBtn: { backgroundColor: colors.brand.fill, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
        primaryBtnText: { color: colors.text.onBrand, fontSize: 16, fontWeight: 'bold' },
        backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
        backBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
        dangerBtn: { backgroundColor: colors.feedback.danger.bg, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 16, borderWidth: 1, borderColor: colors.feedback.danger.border },
        dangerBtnText: { color: colors.feedback.danger.fg, fontSize: 14, fontWeight: 'bold' },
        infoText: { fontSize: 14, color: colors.text.secondary, marginBottom: 16, lineHeight: 20 },
        errorText: { color: colors.feedback.danger.fg, marginBottom: 16, textAlign: 'center' },
        
        // Seed UI
        seedGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 16 },
        seedWord: { width: '48%', backgroundColor: colors.surface.subtle, padding: 12, borderRadius: 8, marginBottom: 12, flexDirection: 'row', alignItems: 'center' },
        seedWordNum: { color: colors.text.muted, fontSize: 12, marginRight: 8, width: 20, textAlign: 'right' },
        seedWordText: { fontSize: 16, fontWeight: '600', color: colors.text.body },
        uriBox: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.slate100,
            padding: 12, borderRadius: 8, borderWidth: 1,
            borderColor: theme === 'dark' ? colors.border.default : palette.slate200,
            marginBottom: 16, maxHeight: 100
        },
        uriText: { fontSize: 12, fontFamily: 'monospace', color: theme === 'dark' ? colors.text.secondary : palette.slate600 },

        // Contact visibility picker
        visibilitySection: { marginTop: 4, marginBottom: 16 },
        visibilityLabel: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginBottom: 8 },
        visibilityOption: {
            flexDirection: 'row', alignItems: 'center', gap: 12,
            padding: 14, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.card,
            marginBottom: 8,
        },
        visibilityOptionActive: {
            borderColor: colors.feedback.info.border, backgroundColor: colors.feedback.info.bg,
            shadowColor: colors.feedback.info.border, shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.15, shadowRadius: 4, elevation: 3,
        },
        visibilityEmoji: { fontSize: 20 },
        visibilityOptionLabel: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        visibilityOptionLabelActive: { color: theme === 'dark' ? colors.feedback.info.fg : palette.blue800 },
        visibilityOptionDesc: { fontSize: 12, color: colors.text.muted, marginTop: 1 },
        // The blue ink, not the fill: info.solid was 3.38:1 on info.bg in light, 4.35 in dark.
        visibilityOptionDescActive: { color: colors.feedback.info.fg },
        visibilityCheck: { fontSize: 18, fontWeight: '800', color: colors.feedback.info.fg },

        // ─── Archetype Card ───
    }));

    const [mode, setMode] = useState<'menu' | 'profile' | 'seed' | 'advanced' | 'wipe' | 'notifications' | 'diagnostics' | 'protection' | 'chatMemory'>('menu');

    // --- Protection state ---
    const [protectionResult, setProtectionResult] = useState<KeeperEnrolmentResult | null>(null);
    // Display name of the node the protection panel is describing. Kept separate from
    // `anchorUrl`, which is only assigned when the diagnostics panel runs and therefore
    // sits at 'Detecting...' in normal use.
    const [protectionNodeLabel, setProtectionNodeLabel] = useState<string | null>(null);
    const [protectionLoading, setProtectionLoading] = useState(false);
    /** Why the key vault couldn't say what protects this account (paused, unreachable, none in this build), or null. */
    const [protectionNote, setProtectionNote] = useState<string | null>(null);
    /** Where a copy made from this community goes, by its rule (vault rethink VR2): this build's place until it is read. */
    const [copiesAt, setCopiesAt] = useState<SignInCopies>(() => signInCopiesAt());
    const [showSsoSheet, setShowSsoSheet] = useState(false);
    /** Set before an SSO flow leaves the app, so the return trip does not reset the section. */
    const skipNextFocusResetRef = React.useRef(false);
    const [ssoEnrolProvider, setSsoEnrolProvider] = useState<SsoProvider>(Platform.OS === 'ios' ? 'apple' : 'google');
    /** The tick beside Protect with was on when it was tapped: the copy carries the list of communities (vault rethink VR5). */
    const [ssoListCommunities, setSsoListCommunities] = useState(false);
    const [revealWords, setRevealWords] = useState(false);
    const [revealLoading, setRevealLoading] = useState(false);
    const [mnemonicWords, setMnemonicWords] = useState<string | null>(null);
    const [copiedWords, setCopiedWords] = useState(false);
    const [showPricingGuide, setShowPricingGuide] = useState(false);
    // Whether this member holds a role, as NodeAdminEntry's ask of the node answered it. 'unknown' until it answers (or the
    // ask fails): a role holder's "How this community works" row sits in the Community admin group, so the plain COMMUNITY
    // section is drawn only on 'none', never while the question is still open.
    const [roleAsk, setRoleAsk] = useState<'unknown' | 'role' | 'none'>('unknown');
    const [shapeSheetOpen, setShapeSheetOpen] = useState(false);
    // The pricing guide is estimates in Beans: not offered on a community with Beans off (the worldwide one).
    const nodeProfile = useNodeProfile();
    const readerFeatures = useReaderFeatures();
    const activeFeatures = effectiveFeatures(nodeProfile?.features, readerFeatures.reader ?? readerFeatures.effective);
    const showsBeans = beansOn(nodeProfile?.features);
    // Your area (design DESIGN-global-sync-by-area §3.5): only on a community that gives each member the listings near
    // their area. The line is the node's value, read each time Settings comes into view (app/your-area.tsx changes it).
    const byArea = nearbyListingsOn(nodeProfile?.features);
    const [areaLine, setAreaLine] = useState('Checking…');
    useFocusEffect(
        React.useCallback(() => {
            if (!byArea) return;
            let cancelled = false;
            areaRowLine(identity).then((line) => { if (!cancelled) setAreaLine(line); });
            return () => { cancelled = true; };
        }, [byArea, identity?.publicKey]),
    );

    /**
     * Account Protection's words, put away: Hide, a second tap, or the member leaving the section or the tab (the tab
     * stays mounted, so its state would otherwise stay). The turn moves on, so a check still answering shows nothing, and
     * the next Show asks the phone's lock again (PR #1205 review 4112404314).
     */
    const protectionWordsTurnRef = React.useRef(0);
    const putProtectionWordsAway = React.useCallback(() => {
        protectionWordsTurnRef.current += 1;
        setRevealWords(false);
        setMnemonicWords(null);
    }, []);

    const handleRevealWords = async () => {
        if (revealWords) {
            putProtectionWordsAway();
            return;
        }
        if (!hasMnemonic(identity)) {
            Alert.alert(t("No recovery words found"), t("Your account key was generated without local passphrase words."));
            return;
        }
        const turn = protectionWordsTurnRef.current;
        setRevealLoading(true);
        try {
            // The phone's lock first, as View Recovery Phrase asks it: a check that does not pass shows nothing.
            const words = await readWordsBehindLock(identity, t('Confirm your security to view your recovery phrase.'));
            // Put away while the check was up (the member left): nothing is shown.
            if (turn !== protectionWordsTurnRef.current) return;
            if (words && Array.isArray(words)) {
                setMnemonicWords(words.join(' '));
                setRevealWords(true);
            }
        } catch (e) {
            Alert.alert(t("Error reading recovery words"), (e as Error).message);
        } finally {
            setRevealLoading(false);
        }
    };

    // Cleared from the clipboard a minute later, if it still holds them (utils/words-clipboard.ts).
    const handleCopyWords = async () => {
        if (!mnemonicWords) return;
        await copyWordsForAMinute(mnemonicWords);
        hapticTick();
        setCopiedWords(true);
        setTimeout(() => setCopiedWords(false), 2000);
    };

    // Resolves a human label for the node we are actually anchored to, preferring the
    // saved-node alias over the host. Reads the anchor directly rather than trusting
    // component state.
    const resolveCommunityLabel = React.useCallback(async (): Promise<string | null> => {
        try {
            const url = await getAnchorUrl();
            if (!url) return null;
            const nodes = await getSavedNodes();
            const match = nodes.find(n => n.url === url);
            if (match?.alias) return match.alias;
            try {
                return new URL(url).host || null;
            } catch {
                return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
            }
        } catch {
            return null;
        }
    }, []);

    const fetchProtectionStatus = async () => {
        // Where a copy made here goes: the community's rule (vault rethink VR2, utils/copies-rule.ts), else this build's
        // place. A community that keeps none shows its sentence and offers nothing; one that keeps them itself, or a build
        // without a key vault, lists the community's copies, as before the vault.
        const anchor = await getAnchorUrl().catch(() => null);
        const at = signInCopiesAt(anchor ? await copiesRuleForScreen(anchor) : undefined);
        setCopiesAt(at);
        if (at === 'none') {
            setProtectionResult(null);
            setProtectionNote(null);
            resolveCommunityLabel().then(setProtectionNodeLabel).catch(() => {});
            return;
        }
        // The vault's own line (didn't answer, paused) never sits above the community's copies.
        if (at === 'community') { setProtectionNote(null); return fetchCommunityProtectionStatus(); }
        setProtectionLoading(true);
        try {
            if (!identity) return;
            resolveCommunityLabel().then(setProtectionNodeLabel).catch(() => {});
            // BeanPool's key vault keeps the sign-in copies, for every community (utils/vault.ts). What it can't say
            // (paused or unreachable) is said in its own words, never shown as protection.
            setProtectionResult(await vaultProtection(identity));
            setProtectionNote(null);
        } catch (e) {
            setProtectionNote(e instanceof VaultError ? e.message : VAULT_MESSAGES.unreachable);
            console.warn('[Protection] the key vault could not say:', (e as Error).message);
        } finally {
            setProtectionLoading(false);
        }
    };

    /** What protects this account at the community the phone is set to: a build without a key vault. */
    const fetchCommunityProtectionStatus = async () => {
        setProtectionLoading(true);
        try {
            const url = await getAnchorUrl();
            if (!url || !identity) { setProtectionLoading(false); return; }
            resolveCommunityLabel().then(setProtectionNodeLabel).catch(() => {});
            const res = await signedPost(url, '/api/recovery/shares/status', {}, identity);
            if (!res.ok) { setProtectionLoading(false); return; }
            const body = await res.json() as {
                keepers: { holderType: string; count: number }[];
                enrolledSso?: string[];
                threshold: number;
                recoverable: boolean;
                total: number;
            };
            // Convert server status to KeeperEnrolmentResult for protectionFrom()
            const enrolled: ('hub' | 'member' | 'sso')[] = [];
            if (Array.isArray(body?.keepers)) {
                for (const k of body.keepers) {
                    for (let i = 0; i < (k.count || 0); i++) {
                        enrolled.push(k.holderType as 'hub' | 'member' | 'sso');
                    }
                }
            }
            setProtectionResult({
                enrolled,
                generation: 1,
                skipped: [],
                available: body.total,
                enrolledSso: body.enrolledSso ?? [],
                threshold: body.threshold,
                isSingleBlob: body.threshold === 1,
            });
        } catch (e) {
            console.warn('[Protection] fetch failed:', e);
        } finally {
            setProtectionLoading(false);
        }
    };

    const handleDisconnectSso = async (provider: SsoProvider) => {
        if (!identity) return;
        const provName = SSO_PROVIDER_NAMES[provider];
        let message: string;
        // The copies Account Protection listed: the key vault's, or (a build without one, or a community that keeps them
        // itself) the community's.
        const at = copiesAt === 'vault' ? 'vault' : 'community';
        if (at === 'vault') {
            // One copy covers every community (the key vault's), so disconnecting it does too: say so plainly. It removes
            // only the vault's copy (keeper-enrolment.ts disconnectSsoKeeper): one a community's server still keeps for
            // this sign-in (from before the vault, or a web-app join) stays, so the words never say nothing brings the
            // account back. A locked vault takes and removes no backups (apps/vault/README.md), so "within 30 days" can
            // run longer.
            message = t("On a new phone, this {name} account will no longer bring your account back from BeanPool's key vault, in any community. The key vault deletes its copy at once, and from its backups within 30 days, or later if the vault is paused in that time. If a community's server still keeps a copy for this sign-in, from before the key vault or from the web app, that copy stays and can still bring your account back there.", { name: provName });
        } else {
            // Name the community: without a vault this only ever affects recovery on THIS node, and saying
            // so plainly is the difference between a member knowing where they're covered
            // and assuming they're covered everywhere.
            const community = protectionNodeLabel || await resolveCommunityLabel();
            message = community
                ? t('On a new phone, this sign-in account will no longer be able to restore your account for {community}. Your other communities are unaffected.', { community })
                : t('This sign-in account will no longer be able to restore your account on a new phone.');
        }
        Alert.alert(
            t('Disconnect {name}?', { name: provName }),
            message,
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Disconnect'),
                    style: 'destructive',
                    onPress: async () => {
                        setProtectionLoading(true);
                        try {
                            const { disconnectSsoKeeper } = await import('../../utils/keeper-enrolment');
                            const res = await disconnectSsoKeeper(provider, identity, at);
                            if (!res.success && res.error) {
                                Alert.alert(t('Error'), settingsLineWords(res.error));
                            }
                            await fetchProtectionStatus();
                        } catch (e) {
                            Alert.alert(t('Error'), (e as Error).message);
                        } finally {
                            setProtectionLoading(false);
                        }
                    },
                },
            ]
        );
    };

    useEffect(() => {
        if (mode === 'protection') { fetchProtectionStatus(); }
    }, [mode]);
    const [dbStats, setDbStats] = useState<{ members: number, posts: number, transactions: number, messages: number, integrity: string } | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const [dbSize, setDbSize] = useState<string>(() => t('{size} MB', { size: formatNumber(0, 1) }));
    const [remoteStats, setRemoteStats] = useState<{ members: number, posts: number, transactions: number } | null>(null);
    const params = useLocalSearchParams<{ section?: string }>();

    // Location permission (relocated here from the global header)
    const [locationEnabled, setLocationEnabled] = useState(false);
    useEffect(() => {
        const checkPerms = () => {
            Location.getForegroundPermissionsAsync().then(({ status }) => setLocationEnabled(status === 'granted')).catch(() => {});
        };
        checkPerms();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                checkPerms();
            }
        });
        return () => sub.remove();
    }, []);
    const handleLocationToggle = async () => {
        const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
            Alert.alert(t('Location Enabled'), t('BeanPool currently has access to your location. To disable it, please visit your device Settings.'), [
                { text: t('Cancel'), style: 'cancel' },
                { text: t('Open Settings'), onPress: () => Linking.openSettings() },
            ]);
            return;
        }
        if (canAskAgain) {
            const res = await Location.requestForegroundPermissionsAsync();
            setLocationEnabled(res.status === 'granted');
        } else {
            Alert.alert(t('Permission Denied'), t('Location permission was denied. Please enable it in your device settings to use location features.'), [
                { text: t('Cancel'), style: 'cancel' },
                { text: t('Open Settings'), onPress: () => Linking.openSettings() },
            ]);
        }
    };

    // Reset to the main menu when settings is focused, or auto-open deep-linked sections.
    //
    // An SSO enrolment leaves the app entirely — Custom Tab, the Google sheet, or the Facebook app
    // takes the foreground and hands it back — so this screen re-focuses partway through the flow
    // and the reset threw the member out of Account Protection just as their provider connected.
    // A ref rather than reading sheet state directly, because focus can arrive after the sheet has
    // already closed.
    useFocusEffect(
        React.useCallback(() => {
            if (skipNextFocusResetRef.current) {
                skipNextFocusResetRef.current = false;
                return;
            }
            if (params.section === 'advanced') {
                setMode('advanced');
            } else if (params.section === 'profile') {
                setMode('profile');
            } else if (params.section === 'protection') {
                // _layout.tsx sends the member here when the node reports a recovery in
                // progress. Without this branch the alert's "Review" button dropped them
                // on the root menu with no sign of the attack.
                setMode('protection');
            } else if (params.section === 'delete') {
                // The not-recognised screen's closed page sends a member here whose account the community closed: Delete
                // account is the one request it still takes from their key (utils/mismatch-plan.ts CLOSED_ACCOUNT_DELETE).
                // Opened as its Permanently Delete Account button opens it.
                setMode('wipe');
                setPurgeConfirm('');
                setWipeType('purge');
                askDeletePlan();
            } else {
                setMode('menu');
            }
        }, [params.section])
    );

    // Notification preference state
    const [notifChat, setNotifChat] = useState(true);
    const [notifMarketplace, setNotifMarketplace] = useState(true);
    const [notifEscrow, setNotifEscrow] = useState(true);
    const [notifKnocks, setNotifKnocks] = useState(false);
    // "Requests to join" only where it changes something (core knockSwitchShown): not for an owner or admin, who is always
    // told, nor on a Known community, whose members are never told. Asked as the screen opens; a node that gave no answer
    // (offline, a timeout, a 5xx) is a role not known yet, so the switch waits (askNodeRole, never fetchMyNodeRole's "no role").
    const [knockSwitch, setKnockSwitch] = useState(false);
    const [notifLoading, setNotifLoading] = useState(false);
    // How long before an event starts this member wants to be told. The day before until they say otherwise
    // (the shared contract), and an empty list means no reminders at all.
    const [eventReminders, setEventReminders] = useState<number[]>(DEFAULT_REMINDER_OFFSETS);
    const saveEventReminders = async (next: number[]) => {
        setEventReminders(next);
        try {
            if (identity?.publicKey) {
                await signedRequest('/api/members/preferences', {
                    publicKey: identity.publicKey,
                    preferences: { [REMINDER_PREF_KEY]: next },
                });
            }
        } catch (e) { console.warn('[Prefs]', e); }
    };
    const [holidayMode, setHolidayMode] = useState(false);
    const [holidayLoading, setHolidayLoading] = useState(false);
    // Never the device-wide name: the loader fills it from this community's record (see knownCallsignRef).
    const [editCallsign, setEditCallsign] = useState('');
    const [avatar, setAvatar] = useState<string | null>(null);
    // The photo the member picked in THIS session, and nothing else. `avatar` above is what the
    // card DISPLAYS — after a sync it is the node's own `/api/avatar/…` URL, which is no photo
    // to publish (it points back at the node). Publishing what is displayed therefore replaced
    // the member's photo with a link to itself, or with an older copy, on every bio or name
    // Save. A Save only sends `avatar` when this is set.
    const [avatarPickedThisSession, setAvatarPickedThisSession] = useState<string | null>(null);
    // Callsign as held by the node we're currently anchored to. Callsigns are per-node
    // (unique per node, chosen at join), so the device-global identity.callsign is only
    // ever right by coincidence — display this instead and fall back while it loads.
    const [nodeCallsign, setNodeCallsign] = useState<string | null>(null);
    // The card's picture is this community's row as last read (utils/use-own-profile.ts), as the header's is: a photo that
    // a sync or a change made elsewhere brings follows at once, where the loader below waits for the next focus. Until that
    // row is read, and where it holds no photo, what the loader found: this community's row, never the phone-wide copy of a
    // photo chosen elsewhere (Profile S2). The name is the loader's first: it reads the same row, then the community's own answer
    // and a rename still waiting to be sent, which the row alone does not know; the row's name stands in until it has.
    const own = useOwnProfile();
    const cardCallsign = nodeCallsign || (own.read && own.callsign) || identity?.callsign || '';
    const cardAvatar = (own.read && own.avatarUrl) || avatar;
    const [communityLabel, setCommunityLabel] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [bio, setBio] = useState('');
    const [contact, setContact] = useState('');
    const [contactVisibility, setContactVisibility] = useState<'hidden' | 'trade_partners' | 'friends' | 'community'>('community');
    const [archetypeRaw, setArchetypeRaw] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [anchorUrl, setAnchorUrl] = useState<string>('Detecting...');
    // The name this community holds for this key, as last read: its own answer, else the cached row. The
    // Callsign field starts from it, and a Save sends a name only when the field differs from it, so a bio or
    // contact Save never renames the member here.
    const knownCallsignRef = React.useRef('');
    // What the member has touched since the editor opened. The editor shares its fields with the card, and the
    // loader below runs on its own (on focus, on a pull, when the identity changes): it refreshes what is not
    // being edited and never puts back what the member is typing.
    const editedRef = React.useRef({ callsign: false, bio: false, contact: false, avatar: false });
    // Bumped by every load and every Save. A probe that answers after a newer load or a Save started is stale.
    const profileLoadSeqRef = React.useRef(0);

    React.useEffect(() => {
        editedRef.current = { callsign: false, bio: false, contact: false, avatar: false };
        setEditCallsign(knownCallsignRef.current);
    }, [mode]);

    // Reads the profile from whichever node we are currently anchored to. `getDb()` is
    // keyed on `beanpool_anchor_url`, so this always resolves against the active node's
    // database without needing to be told which one that is.
    const loadProfileForCurrentNode = React.useCallback(async () => {
        if (!identity?.publicKey) return;
        const seq = ++profileLoadSeqRef.current;
        const showCommunityName = (name: string | null) => {
            setNodeCallsign(name);
            knownCallsignRef.current = name ?? '';
            if (!editedRef.current.callsign) setEditCallsign(name ?? '');
        };
        try {
            const profile = await getMemberProfile(identity.publicKey);
            const canonical = await getCanonicalProfile().catch(() => null);
            // Assign unconditionally. Setting this only when the node knows us would
            // leave the previous node's name on the card (and in the purge gate) after
            // switching to a node that has no profile for this key.
            showCommunityName(profile?.callsign || null);
            const edited = editedRef.current;
            // The picture likewise: assigned on every load, the row's photo, else none. Never the phone-wide copy of a photo
            // chosen in another community (Profile S2). The card falls through to this where the hook reads no photo (no row,
            // or a row without one), so leaving it alone where this community holds no row yet would keep the community
            // before's photo beside the header's preset.
            const cleaned = (profile?.avatar_url && profile.avatar_url !== 'null' && profile.avatar_url !== 'undefined' && profile.avatar_url.trim() !== '') ? profile.avatar_url : null;
            if (!edited.avatar) setAvatar(cleaned);
            {
                // Profile S2-W: bio and contact belong to this community alone; no fallback to canonical across communities.
                if (profile) {
                    if (!edited.bio) {
                        setBio(profile.bio ?? '');
                    }
                    if (!edited.contact) {
                        setContact(profile.contact_value ?? '');
                        setContactVisibility((profile.contact_visibility as any) || 'community');
                    }
                    if (profile.archetype) setArchetypeRaw(profile.archetype);
                    else if (canonical?.archetype) setArchetypeRaw(canonical.archetype);
                } else {
                    if (!edited.bio) setBio('');
                    if (!edited.contact) {
                        setContact('');
                        setContactVisibility('community');
                    }
                    if (canonical?.archetype) setArchetypeRaw(canonical.archetype);
                }
            }

            // Resolve the community label for "Your name in <community>"
            const label = await resolveCommunityLabel();
            setCommunityLabel(label);

            // On open and on pull-to-refresh: ask the active community for this key's own record
            const targetUrl = await getAnchorUrl().catch(() => null);
            if (targetUrl) {
                // A waiting name this community refused for good at a retry no one watched (db.ts pushProfileToServer):
                // said here once, in the community's words, as a Save's refusal is.
                const refusal = await takeNameRefusal(targetUrl, identity.publicKey);
                if (refusal) {
                    Alert.alert(
                        refusal.status === 409 ? t('Name Taken') : t('Could Not Save'),
                        refusal.message || t('The community node rejected this profile update. Please try again.')
                    );
                }
                const remoteName = await fetchNodeCallsign(targetUrl, identity.publicKey, identity.privateKey);
                if (remoteName) {
                    const activeAnchor = await getAnchorUrl().catch(() => null);
                    if (activeAnchor !== targetUrl) return;
                    // An offline edit waiting to be sent to THIS community wins until it is. The node still holds the old
                    // name, and writing it into the row here is what pillar-sync's retry would then publish. One waiting
                    // for another community is that community's (utils/pending-profile-sync.ts). Once the community has
                    // refused the waiting name for good, the name it holds is the one to show.
                    const waiting = await pendingProfileChange(targetUrl, identity.publicKey);
                    if (waiting && waiting.refusedCallsign === undefined) return;
                    // A newer load, or a Save, started while this one waited: its answer may predate the Save.
                    if (seq !== profileLoadSeqRef.current) return;

                    if (remoteName !== profile?.callsign) {
                        showCommunityName(remoteName);
                        // No photo: a portable one in this row reads as an unsent offline pick to the catch-up publish
                        // (avatar-value.ts), which would post it over a newer photo the node holds. COALESCE keeps
                        // whatever the row had.
                        await updateMemberProfile(identity.publicKey, {
                            callsign: remoteName,
                            bio: profile?.bio ?? undefined,
                            contact_value: profile?.contact_value ?? undefined,
                            contact_visibility: profile?.contact_visibility ?? undefined,
                            archetype: profile?.archetype ?? canonical?.archetype ?? undefined,
                        });
                    }
                    if (!identity.callsign?.trim()) {
                        const updated = await updateCallsign(remoteName);
                        if (updated) setIdentity(updated);
                    }
                }
            }
        } catch {
            // Non-fatal: the card falls back to the local identity.
        }
    }, [identity?.publicKey, identity?.privateKey, identity?.callsign, resolveCommunityLabel, setIdentity]);

    const handleRefresh = React.useCallback(async () => {
        setRefreshing(true);
        try {
            await loadProfileForCurrentNode();
        } finally {
            setRefreshing(false);
        }
    }, [loadProfileForCurrentNode]);

    React.useEffect(() => {
        void loadProfileForCurrentNode();
    }, [loadProfileForCurrentNode, anchorUrl]);

    // Re-read whenever the screen regains focus. Switching nodes from GlobalHeader
    // never touches this screen's state, and `anchorUrl` is only assigned when the
    // diagnostics panel runs — so focus is the one reliable signal that the anchored
    // node may have changed underneath us.
    useFocusEffect(
        React.useCallback(() => {
            void loadProfileForCurrentNode();
        }, [loadProfileForCurrentNode])
    );

    // Load holiday-mode state on mount (queried so an unset flag reads as OFF, not the pref default).
    React.useEffect(() => {
        (async () => {
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url && identity?.publicKey) {
                    const res = await fetch(`${url}/api/members/preferences?publicKey=${identity.publicKey}`);
                    if (res.ok) {
                        const prefs = await res.json();
                        setHolidayMode(prefs.holiday_mode === 'true');
                        setEventReminders(parseReminderOffsets(prefs[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS);
                    }
                }
            } catch { }
        })();
    }, []);

    const handleToggleHoliday = async () => {
        if (!identity?.publicKey || holidayLoading) return;
        const next = !holidayMode;
        setHolidayLoading(true);
        try {
            await signedRequest('/api/members/holiday', { enabled: next });
            setHolidayMode(next);
            Alert.alert(
                next ? t('🌴 Holiday mode on') : t('Welcome back'),
                next
                    ? t("Your offers are hidden and you won't get new trade requests. Turn this off anytime to come back.")
                    : t('Your offers are live again.')
            );
        } catch (e: any) {
            // Server blocks turning it on while trades are in progress — surface that message.
            Alert.alert(next ? t("Can't start holiday yet") : t('Update failed'), e?.message ? signedRequestWords(e.message) : t('Please try again.'));
        } finally {
            setHolidayLoading(false);
        }
    };

    const loadDiagnostics = async (opts?: { skipSync?: boolean }) => {
        setDiagLoading(true);
        setRemoteStats(null);
        try {
            if (!opts?.skipSync) {
                try {
                    const { requestSync } = await import('../../services/pillar-sync');
                    await requestSync();
                } catch (e) {}
            }
            const { getDatabaseStats } = await import('../../utils/db');
            const stats = await getDatabaseStats();
            setDbStats(stats);
            
            // Get database size with normalized review/prod checks
            const url = await AsyncStorage.getItem('beanpool_anchor_url');
            setAnchorUrl(url || 'Local discovery (or offline)');
            
            const dbFilename = getDatabaseFilenameForNode(url);
            const dbPaths = getDatabaseFilePaths(dbFilename);
            console.log('[Diagnostics] Computed Database Paths:', dbPaths);
            
            // Log local directory structures to diagnose exact database location
            try {
                const docDir = FileSystem.documentDirectory;
                console.log('[Diagnostics] FileSystem.documentDirectory:', docDir);
                if (docDir) {
                    const docFiles = await FileSystem.readDirectoryAsync(docDir);
                    console.log('[Diagnostics] Files in docDir:', docFiles);
                    try {
                        const sqFiles = await FileSystem.readDirectoryAsync(docDir + 'SQLite/');
                        console.log('[Diagnostics] Files in docDir/SQLite:', sqFiles);
                    } catch (e) {
                        console.log('[Diagnostics] No SQLite/ subfolder found in docDir');
                    }
                    if (Platform.OS === 'android') {
                        try {
                            const dbDir = docDir.replace('/files/', '/databases/');
                            const dbFiles = await FileSystem.readDirectoryAsync(dbDir);
                            console.log('[Diagnostics] Files in databases sibling dir:', dbFiles);
                        } catch (e) {
                            console.log('[Diagnostics] No databases sibling folder found');
                        }
                    }
                }
            } catch (err) {
                console.warn('[Diagnostics] Directory scan failed:', err);
            }

            let sizeBytes = 0;
            let fileFound = false;
            for (const p of dbPaths) {
                try {
                    const fileInfo = await FileSystem.getInfoAsync(p);
                    console.log(`[Diagnostics] File Info for ${p}:`, fileInfo);
                    if (fileInfo.exists) {
                        sizeBytes = fileInfo.size;
                        fileFound = true;
                        break;
                    }
                } catch {}
            }
            if (fileFound) {
                if (sizeBytes >= 1024 * 1024) {
                    setDbSize(t('{size} MB', { size: formatNumber(sizeBytes / 1024 / 1024, 2) }));
                } else {
                    setDbSize(t('{size} KB', { size: formatNumber(sizeBytes / 1024, 1) }));
                }
            } else {
                setDbSize(t('{size} MB', { size: formatNumber(0, 1) }));
            }

            // Fetch remote health stats for visual compare
            if (url && url.startsWith('http')) {
                try {
                    let cleanUrl = url.trim();
                    if (cleanUrl.endsWith('/')) {
                        cleanUrl = cleanUrl.slice(0, -1);
                    }
                    const res = await fetch(`${cleanUrl}/api/community/info?_t=${Date.now()}`);
                     if (res.ok) {
                        const data = await res.json();
                        await recordRequestSigning(cleanUrl, data);
                        let remoteTxCount = data.transactionCount || 0;
                        
                        // The member's own ledger is Beans: never asked where they are a preview (the global node).
                        const ownCount = await remoteOwnTransactionCount(cleanUrl, data, identity?.publicKey);
                        if (ownCount !== null) remoteTxCount = ownCount;

                        setRemoteStats({
                            members: data.memberCount || 0,
                            posts: data.postCount || 0,
                            transactions: remoteTxCount
                        });
                    }
                } catch (err) {
                    console.warn('[Diagnostics] Could not fetch remote stats for comparison:', err);
                }
            }
        } catch (e) {
            console.error('Failed loading diagnostics:', e);
        } finally {
            setDiagLoading(false);
        }
    };
    
    // Advanced subsystem state
    const [newAnchorInput, setNewAnchorInput] = useState('');
    const [changeConfirm, setChangeConfirm] = useState('');
    const [wipeConfirm, setWipeConfirm] = useState('');
    const [wipeType, setWipeType] = useState<'options' | 'local' | 'purge'>('options');
    const [purgeConfirm, setPurgeConfirm] = useState('');
    // What Permanently Delete Account does on this phone (delete-here.ts): the other saved communities are asked as the
    // member opens it, so the screen and its confirmation say whether the key stays. Null while they are asked.
    const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
    const [deletePlanError, setDeletePlanError] = useState<string | null>(null);
    const deletePlanTurnRef = React.useRef(0);
    const askDeletePlan = () => {
        const turn = ++deletePlanTurnRef.current;
        setDeletePlan(null);
        setDeletePlanError(null);
        if (!identity?.publicKey) return;
        planDelete(identity.publicKey)
            .then((plan) => { if (turn === deletePlanTurnRef.current) setDeletePlan(plan); })
            .catch((e: unknown) => {
                if (turn === deletePlanTurnRef.current) setDeletePlanError(e instanceof Error ? e.message : String(e));
            });
    };
    const [seedConfirm, setSeedConfirm] = useState('');
    const [seedVisible, setSeedVisible] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);
    // "Add your 12 words to this phone" (a phone that has none) just saved them: the seed screen says so once.
    const [wordsJustAdded, setWordsJustAdded] = useState(false);
    // Loaded at the moment of reveal, not when the screen mounts — the words should only be
    // read once the user has typed CONFIRM and passed the biometric check, which is also
    // exactly where the vault read belongs once there is a vault to read from.
    const [seedWords, setSeedWords] = useState<string[] | null>(null);

    /** View Recovery Phrase's words, put away when the member leaves its section or the tab, as Account Protection's are. */
    const seedWordsTurnRef = React.useRef(0);
    const putSeedWordsAway = React.useCallback(() => {
        seedWordsTurnRef.current += 1;
        setSeedVisible(false);
        setSeedWords(null);
    }, []);

    // Both reveals' words go when the member leaves their section (Back, another section) or the Settings tab, so each
    // Show asks the phone's lock again.
    useEffect(() => {
        if (mode !== 'protection') putProtectionWordsAway();
        if (mode !== 'seed') putSeedWordsAway();
    }, [mode, putProtectionWordsAway, putSeedWordsAway]);
    useFocusEffect(
        React.useCallback(() => () => {
            putProtectionWordsAway();
            putSeedWordsAway();
        }, [putProtectionWordsAway, putSeedWordsAway])
    );
    // And when the member comes back to the app after 15 seconds or more away, App Lock on or off.
    usePutAwayAfterLeave(revealWords, putProtectionWordsAway);
    usePutAwayAfterLeave(seedWords !== null, putSeedWordsAway);

    const handleShowSeedWords = async () => {
        const turn = seedWordsTurnRef.current;
        const words = await readWordsBehindLock(identity, t('Confirm your security to view your recovery phrase.'));
        // A check that did not pass shows nothing. Nor does one that answers after the member left.
        if (!words || turn !== seedWordsTurnRef.current) return;
        setSeedWords(words);
        setSeedVisible(true);
        await AsyncStorage.setItem('beanpool_identity_backed_up', 'true');
    };

    // View Recovery Phrase, from the menu and from Account Protection on a phone without words. The seed screen
    // shows the words, or on a phone with no copy opens "Add your 12 words" under one plain line (Marty, 2026-09-25).
    const openViewWords = () => {
        setSeedConfirm('');
        setSeedVisible(false);
        setWordsJustAdded(false);
        setMode('seed');
    };
    const viewWordsRow = hasMnemonic(identity) ? VIEW_WORDS_MENU : NO_WORDS_MENU;
    const [advancedLoading, setAdvancedLoading] = useState(false);
    const [resyncing, setResyncing] = useState(false);
    const [resyncModalVisible, setResyncModalVisible] = useState(false);
    const [resyncProgressStep, setResyncProgressStep] = useState(1);
    const [resyncTotalSteps, setResyncTotalSteps] = useState(5);
    const [resyncProgressStage, setResyncProgressStage] = useState('Initializing Database Reset...');
    const [appLockEnabled, setAppLockEnabledState] = useState(false);
    const onAppLockTurnedOn = React.useCallback(() => setAppLockEnabledState(true), []);
    const [showBlockedModal, setShowBlockedModal] = useState(false);
    // "Show me as a connection in common" (server SHOW_AS_CONNECTION_PREF), on unless turned off. null until the node says:
    // it is served to the member alone, so it is read with a signed request.
    const [showAsConnection, setShowAsConnection] = useState<boolean | null>(null);
    useEffect(() => {
        if (!identity?.publicKey) return;
        let cancelled = false;
        signedGet(`/api/members/preferences?publicKey=${identity.publicKey}`)
            .then(res => (res.ok ? res.json() : null))
            .then(prefs => { if (!cancelled && prefs && typeof prefs.show_as_connection_in_common === 'string') setShowAsConnection(prefs.show_as_connection_in_common !== 'false'); })
            .catch(e => console.warn('[Prefs] Could not read the connection-in-common setting:', e));
        return () => { cancelled = true; };
    }, [identity?.publicKey]);
    const [blockedUsersList, setBlockedUsersList] = useState<{ pubkey: string; callsign?: string }[]>([]);
    const [loadingBlockedList, setLoadingBlockedList] = useState(false);

    const handleOpenBlockedModal = async () => {
        setLoadingBlockedList(true);
        setShowBlockedModal(true);
        try {
            const pubkeys = await getBlockedUsers();
            const items = await Promise.all(pubkeys.map(async (pk) => {
                let callsign = pk.length > 16 ? `${pk.slice(0, 8)}...${pk.slice(-6)}` : pk;
                try {
                    const profile = await getMemberProfile(pk);
                    if (profile?.callsign) callsign = profile.callsign;
                } catch {}
                return { pubkey: pk, callsign };
            }));
            setBlockedUsersList(items);
        } catch (e) {
            console.error('[Settings] Failed to load blocked users list:', e);
        } finally {
            setLoadingBlockedList(false);
        }
    };

    useEffect(() => {
        getAppLockEnabled().then(setAppLockEnabledState);
    }, []);

    const handleToggleAppLock = async () => {
        // With no screen lock, "App Lock enabled" would ask nothing at the next launch. Turning it off never waits on this.
        if (!appLockEnabled && (await getScreenLock()) === 'none') {
            Alert.alert(t('Set a screen lock first'), settingsLineWords(APP_LOCK_NEEDS_SCREEN_LOCK));
            return;
        }
        const success = await authenticateUser(appLockEnabled ? t('Confirm your security to disable App Lock.') : t('Confirm your security to enable App Lock.'));
        if (success) {
            const newValue = !appLockEnabled;
            await setAppLockEnabled(newValue);
            setAppLockEnabledState(newValue);
            Alert.alert(t('Success'), newValue ? t('App Lock enabled.') : t('App Lock disabled.'));
        }
    };

    // Copy Words is drawn only once the words are shown: it copies what the phone's lock let through, for a minute.
    const handleCopySeed = async () => {
        const words = seedWords;
        if (!words) return;
        await copyWordsForAMinute(words.join(' '));
        hapticTick();
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    };
    const [savedNodes, setSavedNodes] = useState<(SavedNode & { status: 'pinging' | 'online' | 'offline', sizeBytes: number })[]>([]);
    const [newNodeAlias, setNewNodeAlias] = useState('');
    const [redeemInviteCode, setRedeemInviteCode] = useState('');
    const [redeemLoading, setRedeemLoading] = useState(false);
    // The global community's door for the account on this phone (utils/global-join-existing.ts), beside adding a
    // community by hand: offered when the one rule says `join` (utils/global-entry.ts): the door is open and the global
    // community itself has not said this key is a member. Never read from the saved list (DESIGN-global-entry §1, rule 1).
    const offerGlobal = useGlobalEntry(mode === 'advanced' && !!identity) === 'join';
    // Guest view first (utils/global-guest-visit.ts): the button opens the global community as a guest, unless the phone is
    // on it already (as a guest: the door is then the next step).
    const guestVisit = useGlobalGuestVisit();
    const onGlobalNow = isGlobalInUse(anchorUrl);

    React.useEffect(() => {
        if (mode === 'advanced') {
            AsyncStorage.getItem('beanpool_anchor_url').then(val => {
                setAnchorUrl(val || 'Local discovery (or offline)');
                if (val) setNewAnchorInput(val);
            });
            
            // Load and ping all saved nodes
            getSavedNodes().then(async nodes => {
                const enriched = await Promise.all(nodes.map(async node => {
                    let size = 0;
                    try {
                        const filename = getDatabaseFilenameForNode(node.url);
                        const paths = getDatabaseFilePaths(filename);
                        for (const p of paths) {
                            const fileInfo = await FileSystem.getInfoAsync(p);
                            if (fileInfo.exists) {
                                size = fileInfo.size;
                                break;
                            }
                        }
                    } catch(e) {}
                    return { ...node, status: 'pinging' as const, sizeBytes: size };
                }));
                setSavedNodes(enriched);

                // Ping them
                enriched.forEach((node, i) => {
                    const c = new AbortController();
                    const t = setTimeout(() => c.abort(), 3000);
                    fetch(`${node.url}/api/community/health`, { signal: c.signal })
                        .then(r => r.ok ? 'online' : 'offline')
                        .catch(() => 'offline')
                        .then(status => {
                            clearTimeout(t);
                            setSavedNodes(prev => {
                                const nw = [...prev];
                                nw[i] = { ...nw[i], status: status as 'online' | 'offline' };
                                return nw;
                            });
                        });
                });
            });
        }
    }, [mode]);

    // Chat memory lists the communities on this phone from the same list. Advanced reads it above, so before this a
    // visit straight to Chat memory showed "No communities on this phone yet." and no reset, the way out
    // DM_PIN_STORE_UNREAD_TEXT names. Read here too, keeping what Advanced already knows of each (status, size).
    React.useEffect(() => {
        if (mode !== 'chatMemory') return;
        let live = true;
        getSavedNodes().then((nodes) => {
            if (!live) return;
            setSavedNodes((prev) => nodes.map((node) => prev.find((p) => p.url === node.url) ?? { ...node, status: 'pinging' as const, sizeBytes: 0 }));
        }).catch(() => {});
        return () => { live = false; };
    }, [mode]);
    





    if (!identity) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.app }}>
                <Text style={{ fontSize: 18, color: 'red' }}>{t('Debug: Identity is null.')}</Text>
            </View>
        );
    }




    async function handlePickImage() {
        setShowAvatarPicker(true);
    }

    async function handleUpdateCallsign() {
        if (!identity) return;
        const newCallsign = editCallsign.trim();
        // The field started from this community's record. Left as it is, the Save is not a rename and sends no
        // name at all (the node keeps the one it has). With no record known yet the member has to give one.
        const knownCallsign = knownCallsignRef.current.trim();
        const renames = !knownCallsign || newCallsign !== knownCallsign;
        if (renames && newCallsign.length < 2) {
            Alert.alert(t('Error'), t('Callsign must be at least 2 characters.'));
            return;
        }
        profileLoadSeqRef.current++;
        setLoading(true);
        try {
            // Push the profile (callsign, avatar, bio, contact) to the node FIRST so it can
            // validate uniqueness before we commit anything locally. Only a TRANSPORT failure
            // falls through to the offline queue — an explicit rejection from the node aborts
            // the save, so local state can never drift from what the server accepted.
            let offline = false;
            // Whether the payload carries a name: once the node accepts it, a name waiting there is sent.
            let payloadCarriesName = false;
            // What this Save decided about the photo, kept in scope because the pending keys may
            // only be retired on the strength of what the payload actually carried.
            let avatarDecision: ProfilePublishAvatar | null = null;
            const url = await AsyncStorage.getItem('beanpool_anchor_url');
            // What waits for this community from an earlier offline Save (utils/pending-profile-sync.ts): only its own.
            const pending = await pendingProfileChange(url, identity.publicKey);
            // The name this Save stands for: one typed now, else a rename an earlier offline Save kept for this community.
            // Not the field's: it starts from the row, which the members sync writes the node's old name over, and sending
            // that would put the old name back on the node and retire the waiting one with it (#2461 review).
            let savedCallsign = renames ? newCallsign : (pending?.callsign || newCallsign);
            // A waiting name this community refused for good, still in the field (the row kept it): sent again only if the
            // member types it (#2461 review r4368601839). The community keeps the name it holds, and the row takes it.
            const refusedHere = !renames && pending?.refusedCallsign !== undefined && savedCallsign === pending.refusedCallsign;
            if (!url) {
                offline = true;
            } else {
                const payloadObj: any = {
                    publicKey: identity.publicKey,
                    bio: bio.trim(),
                    contact: contact.trim() ? { value: contact.trim(), visibility: contactVisibility } : null,
                };
                // An offline rename still waiting for pillar-sync's retry is a rename too: this Save may retire that retry
                // (retireParkedPickAfterPublish), so it carries the name the member chose, or the node keeps the old one
                // and the next answer from the community writes it back (#2439 review). `pending` is this community's
                // own: another community's name is not this one's to send.
                const pendingRename = !!pending && savedCallsign.length >= 2;
                if ((renames || pendingRename) && !refusedHere) payloadObj.callsign = savedCallsign;
                payloadCarriesName = payloadObj.callsign !== undefined;
                // The one shared rule decides, so this Save cannot disagree with the wizard or
                // with the pending-sync retry. It sends a photo picked in this session, else a
                // pick an earlier offline save parked and nothing has managed to publish yet;
                // for a plain bio/name/contact edit it sends nothing, which is how the node is
                // told "avatar unchanged" (it reads an explicit null as "clear it").
                avatarDecision = await resolveProfilePublishAvatar({ sessionPick: avatarPickedThisSession, parked: pending?.avatar });
                const publishAvatar = avatarDecision.avatar;
                if (publishAvatar) payloadObj.avatar = publishAvatar;
                if (archetypeRaw) {
                    const parsed = parseArchetype(archetypeRaw);
                    payloadObj.archetype = parsed ? JSON.stringify({
                        primary: parsed.primary,
                        secondary: parsed.secondary,
                        mode: parsed.mode,
                        updatedAt: parsed.updatedAt,
                    }) : archetypeRaw;
                }
                const bodyString = JSON.stringify(payloadObj);
                const headers = await buildSignedHeaders('POST', `${url}/api/profile/update`, bodyString, identity.privateKey, identity.publicKey);

                let res: Response | null = null;
                try {
                    res = await fetch(`${url}/api/profile/update`, {
                        method: 'POST',
                        headers,
                        body: bodyString,
                    });
                } catch (e: any) {
                    console.warn('[Profile] Node unreachable, queueing for background sync:', e);
                    offline = true;
                }

                if (res && !res.ok) {
                    // The node answered and said no — surface its reason and abort rather
                    // than committing a value the server has already rejected.
                    const answer = await res.json().catch(() => null);
                    const serverMsg = answer?.message;
                    // The waiting name refused for good leaves the change, so neither this screen nor the retry sends it
                    // again (utils/pending-profile-sync.ts). The member is told here.
                    if (pending && payloadObj.callsign !== undefined && payloadObj.callsign === pending.callsign && nameRefusedForGood(res.status, answer?.error)) {
                        await pendingNameRefused(url, pending, payloadObj.callsign);
                    }
                    Alert.alert(
                        res.status === 409 ? t('Name Taken') : t('Could Not Save'),
                        serverMsg || t('The community node rejected this profile update. Please try again.')
                    );
                    return;
                }
                if (refusedHere && res) {
                    const held = await res.json().then((b: any) => b?.profile?.callsign).catch(() => null);
                    if (typeof held === 'string' && held) savedCallsign = held;
                }
            }

            if (offline) {
                // Kept for THIS community (utils/pending-profile-sync.ts), never for the phone: its own sync sends it, and
                // a switch to another community neither sends it there nor clears it. A new name goes in it as well as in
                // the row, which the next members sync overwrites with the name the node still holds.
                // Park the session pick in it too, not only in the members row. The row
                // is the retry's only other source for it, and the first members sync to land
                // before the retry succeeds replaces it with the node's own URL — after which
                // the retry reads "the node has a photo" and publishes no avatar at all, so the
                // pick never reaches the node and nothing ever resends it. A bio-only save
                // stores nothing here and so still says nothing about the photo.
                const offlinePick = explicitEditAvatar(avatarPickedThisSession);
                await keepPendingProfileChange(url, identity.publicKey, { callsign: renames ? newCallsign : undefined, avatar: offlinePick });
                Alert.alert(t('Offline Mode'), t('Profile saved locally. It will be published automatically in the background when you reconnect to the network.'));
            } else if (avatarDecision) {
                // The node has accepted. A name this payload carried is no longer waiting there.
                if (payloadCarriesName) await pendingNameAccepted(url);
                // Retire the parked pick ONLY if this payload carried it
                // (or a newer pick that supersedes it): a bio-only Save publishes no photo, and
                // clearing the keys here used to disarm the retry for a pick that had reached
                // nothing — the member kept seeing it locally and it never left the phone.
                await retireParkedPickAfterPublish(avatarDecision, url);
            }

            // Commit locally now that the node has accepted (or we know we are offline)
            const localUpdate: any = {
                callsign: savedCallsign,
                bio: bio.trim(),
                contact_value: contact.trim(),
                contact_visibility: contact.trim() ? contactVisibility : 'hidden',
            };
            // Same rule locally: only a pick from this session is written back to the members
            // row. Writing `avatar` would put the node's own URL (or a stale canonical copy)
            // into the row as if the member had chosen it.
            if (avatarPickedThisSession) localUpdate.avatar_url = avatarPickedThisSession;
            if (archetypeRaw) localUpdate.archetype = archetypeRaw;
            await updateMemberProfile(identity.publicKey, localUpdate);
            // The card renders nodeCallsign, so it would keep showing the pre-edit name
            // until the screen remounted if we didn't move it here too.
            setNodeCallsign(savedCallsign);
            knownCallsignRef.current = savedCallsign;
            if (renames && newCallsign !== identity.callsign) {
                const updated = await updateCallsign(newCallsign);
                if (updated) setIdentity(updated);
            }

            setMode('menu');
        } catch (e: any) {
            Alert.alert(t('Error'), e?.message || t('Could not update profile.'));
        } finally {
            setLoading(false);
        }
    }


    async function handleSwitchNode(targetUrl: string) {
        if (targetUrl === anchorUrl) return;
        // Only a plain host[:port] becomes the phone's community (utils/node-url.ts).
        if (!isPlainNodeAddress(targetUrl)) {
            Alert.alert(t('Pivot Failed'), settingsLineWords(UNSAFE_NODE_ADDRESS_MESSAGE));
            return;
        }
        setAdvancedLoading(true);
        try {
            const { closeDB, initDB } = await import('../../utils/db');
            await closeDB(); 
            // The database is successfully suspended to Cold Storage.
            await AsyncStorage.setItem('beanpool_anchor_url', targetUrl);
            await initDB();
            // The update screen's block was the community left's (utils/community-switch.ts).
            communitySwitched();
            
            // Hard bounce the Application State Tree via the Welcome resolver
            router.replace('/welcome');
        } catch (e: any) {
            Alert.alert(t("Pivot Failed"), e.message);
        }
    }

    async function handleRedeemInvite() {
        if (!redeemInviteCode.trim()) return;
        setRedeemLoading(true);
        try {
            const { redeemInvite } = await import('../../utils/db');
            // Re-fetch the callsign just to be sure it's current
            await redeemInvite(redeemInviteCode.trim(), identity?.callsign || 'Unknown', identity);
            
            // Kick off a background sync immediately so they pull the node's ledger
            const { requestSync } = await import('../../services/pillar-sync');
            requestSync().catch(console.error);

            Alert.alert(t('Success'), t('Invite redeemed successfully on current node! Syncing data...'));
            setRedeemInviteCode('');
        } catch (e: any) {
            Alert.alert(t('Redemption Failed'), welcomeLineWords(e.message));
        } finally {
            setRedeemLoading(false);
        }
    }

    async function handleForgetNode(targetUrl: string) {
        if (targetUrl === anchorUrl) {
            const remainingNodes = savedNodes.filter(n => n.url !== targetUrl);
            if (remainingNodes.length === 0) {
                Alert.alert(t("Action Denied"), t("You cannot forget your only saved node. If you want to leave BeanPool completely, please use 'Delete Account' to destroy your identity."));
                return;
            }

            Alert.alert(
                t("Forget Active Node"),
                t("You are currently connected to this node. To forget it, you will automatically be switched to your next saved node."),
                [
                    { text: t("Cancel"), style: "cancel" },
                    {
                        text: t("Forget & Switch"),
                        style: "destructive",
                        onPress: async () => {
                            await removeSavedNode(targetUrl);
                            setSavedNodes(remainingNodes);
                            try {
                                const filename = getDatabaseFilenameForNode(targetUrl);
                                const paths = getDatabaseFilePaths(filename);
                                for (const p of paths) {
                                    await FileSystem.deleteAsync(p, { idempotent: true });
                                }
                                // Its cursors go with its copy, so a rejoin reads it whole.
                                const { syncCursorKeysOf } = await import('../../services/pillar-sync');
                                await AsyncStorage.multiRemove(syncCursorKeysOf(filename));
                            } catch(e) {}
                            
                            // Automatically pivot to the next available node
                            await handleSwitchNode(remainingNodes[0].url);
                        }
                    }
                ]
            );
            return;
        }

        Alert.alert(
            t("Forget Community?"),
            t('This removes "{address}" from your saved communities and deletes its local data from this phone. Your identity and other communities are not affected — you can rejoin later, but any unsynced local data for this community will be lost.', { address: targetUrl }),
            [
                { text: t("Cancel"), style: "cancel" },
                {
                    text: t("Forget"),
                    style: "destructive",
                    onPress: async () => {
                        await removeSavedNode(targetUrl);
                        setSavedNodes(prev => prev.filter(n => n.url !== targetUrl));
                        // Physically delete the dormant .db file from the OS folder
                        try {
                            const filename = getDatabaseFilenameForNode(targetUrl);
                            const paths = getDatabaseFilePaths(filename);
                            for (const p of paths) {
                                    await FileSystem.deleteAsync(p, { idempotent: true });
                            }
                            // Its cursors go with its copy, so a rejoin reads it whole.
                            const { syncCursorKeysOf } = await import('../../services/pillar-sync');
                            await AsyncStorage.multiRemove(syncCursorKeysOf(filename));
                        } catch(e) {}
                    }
                }
            ]
        );
    }

    async function handleForceResync(targetUrl: string) {
        if (resyncing) return; // guard against re-entry from either resync button
        Alert.alert(
            t("Force Resync"),
            t("This will delete your local database for this community and redownload everything from scratch."),
            [
                { text: t("Cancel"), style: "cancel" },
                {
                    text: t("Clear & Resync"),
                    style: "destructive",
                    onPress: async () => {
                        setResyncing(true);
                        setAdvancedLoading(true);
                        setResyncProgressStep(1);
                        setResyncTotalSteps(5);
                        setResyncProgressStage('Clearing Local Database Cache...');
                        setResyncModalVisible(true);
                        try {
                            const urlsToClear = [
                                targetUrl,
                                await AsyncStorage.getItem('beanpool_anchor_url'),
                                null,
                                'https://test.beanpool.org',
                                'https://review.beanpool.org:8443',
                                'https://beanpool.org:8443'
                            ];
                            const keysToRemove: string[] = [
                                'beanpool_last_version_check_time',
                                'beanpool_latest_known_version',
                                'pillar_sync_members_last_sync'
                            ];
                            // Each community caches its own minimum-app-version floor.
                            keysToRemove.push(...(await AsyncStorage.getAllKeys()).filter(k => k.startsWith('beanpool_min_app_version')));
                            // Every sync cursor of each copy, a held posts read among them: carried on, a whole read
                            // would resume below its key and never re-download the newest listings.
                            const { syncCursorKeysOf, performSyncWhenFree, forceResyncNotice } = await import('../../services/pillar-sync');
                            for (const u of urlsToClear) keysToRemove.push(...syncCursorKeysOf(getDatabaseFilenameForNode(u)));
                            // The copy first, then its cursors, as the wipes do: a sync running now stores nothing once the
                            // copy is cleared (pillar-sync copyGeneration), and one it stored before goes with the rest.
                            const { clearDB, initDB } = await import('../../utils/db');
                            await clearDB();
                            await initDB();
                            await AsyncStorage.multiRemove(keysToRemove);

                            // Perform full sync with live progress updates: after a sync already running, never instead of it.
                            const syncRes = await performSyncWhenFree((step, total, stage) => {
                                setResyncProgressStep(step);
                                setResyncTotalSteps(total);
                                setResyncProgressStage(stage);
                            });

                            if (!syncRes.success && syncRes.errorMessage) {
                                console.warn('[Resync] Sync finished with notice:', syncRes.errorMessage);
                            }

                            // Dismiss modal immediately when sync completes before post-sync checks or alerts
                            setResyncModalVisible(false);
                            setResyncing(false);
                            setAdvancedLoading(false);

                            if (identity?.publicKey) {
                                const { syncMessages } = await import('../../utils/db');
                                syncMessages(identity.publicKey).catch(() => {});
                            }

                            if (mode === 'diagnostics') {
                                await loadDiagnostics({ skipSync: true });
                            }
                            // "Success" only when its own sync re-read the copy; otherwise, plainly, that it will.
                            const notice = forceResyncNotice(syncRes);
                            Alert.alert(notice.title, notice.message);
                        } catch (e: any) {
                            setResyncModalVisible(false);
                            setResyncing(false);
                            setAdvancedLoading(false);
                            Alert.alert(t("Resync Error"), e?.message || String(e) || t("Failed to rebuild and re-sync."));
                        } finally {
                            setResyncing(false);
                            setAdvancedLoading(false);
                            setResyncModalVisible(false);
                        }
                    }
                }
            ]
        );
    }

    async function handleUpdateAnchor() {
        if (!newAnchorInput.trim()) {
            Alert.alert(t("Invalid URL"), t("Please enter a valid BeanPool Node IP address."));
            return;
        }

        setAdvancedLoading(true);
        try {
            // A bare public IP gets https://; http:// only for localhost and a LAN address (utils/node-address-scheme.ts).
            const finalAnchorUrl = withNodeScheme(newAnchorInput);
            // Only a plain host[:port] becomes the phone's community (utils/node-url.ts); refused before anything moves.
            if (!isPlainNodeAddress(finalAnchorUrl)) throw new Error(UNSAFE_NODE_ADDRESS_MESSAGE);
            await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);
            // A switch too: the update screen asks the community now in use at once, whatever fails below
            // (utils/community-switch.ts).
            communitySwitched();
            // Inject alias to native node matrix
            const { addSavedNode, markGuestNode, clearGuestNode } = await import('../../utils/nodes');
            await addSavedNode(finalAnchorUrl, newNodeAlias.trim() || undefined);

            // Record whether this is a deliberate guest visit. Pointing at a community you
            // are not a member of is legitimate — you browse read-only, then register from
            // the People tab — but it probes identically to a mistyped address, so the root
            // layout needs the intent written down or it ejects you to node-mismatch and you
            // never reach the Register screen.
            if (identity?.publicKey) {
                try {
                    // Signed by the key (utils/membership-probe.ts): the community answers only its own key.
                    const probe = await fetchMembership(finalAnchorUrl, identity);
                    if (probe.ok) {
                        const data = await probe.json();
                        if (data?.isMember) {
                            await clearGuestNode(finalAnchorUrl);
                        } else {
                            await markGuestNode(finalAnchorUrl);
                        }
                    }
                } catch {
                    // Unreachable node: leave the marker alone. 'unknown' recognition never
                    // diverts, so nothing ejects the member while the node is down.
                }
            }

            const { closeDB, initDB } = await import('../../utils/db');
            await closeDB();
            await initDB();

            const { requestSync } = await import('../../services/pillar-sync');
            requestSync()
                .catch((err: any) => console.error("Sync caught an error:", err));

            Alert.alert(t("Node Added"), t("You have successfully connected to the new community."));
            setAnchorUrl(finalAnchorUrl);
        } catch (e: any) {
            Alert.alert(t("Update Failed"), settingsLineWords(String(e.message || e)));
        } finally {
            setAdvancedLoading(false);
        }
    }

    async function handleLocalWipe() {
        if (wipeConfirm !== 'WIPE') {
            Alert.alert(t("Warning"), t("You must type exactly '{word}' to remove your account from this device.", { word: 'WIPE' }));
            return;
        }
        const success = await authenticateUser(t('Confirm authentication to sign out of this device.'));
        if (!success) return;

        async function signOutNow() {
            setAdvancedLoading(true);
            try {
                // Its push alerts stop (signed by its key, so before the wipe), its saved communities and
                // their cached copies go, then the key and the rest of its app storage.
                await signOutOfThisPhone(identity, { namesCopiesSaved: true });
                setIdentity(null);
            } catch (e: any) {
                Alert.alert(t("Sign Out Failed"), e.message || t("Failed to sign out."));
            } finally {
                setAdvancedLoading(false);
            }
        }

        /**
         * The names list's locked copies are saved and confirmed before the wipe (design §5). One the server didn't confirm
         * gets the words first, and nothing is blocked: "Sign out anyway" always signs out.
         */
        async function signOutAfterNamesCopies() {
            setAdvancedLoading(true);
            let words: ReturnType<typeof namesSignOutWords> = null;
            try {
                words = namesSignOutWords(await namesCopiesBeforeSignOut(identity));
            } finally {
                setAdvancedLoading(false);
            }
            if (!words) return signOutNow();
            Alert.alert(settingsLineWords(NAMES_COPY.title), settingsLineWords(words.text), [
                { text: settingsLineWords(NAMES_COPY.tryAgain), onPress: () => void signOutAfterNamesCopies() },
                // The names list's own "Export as PDF" (names-list.tsx).
                ...(words.pdf ? [{ text: settingsLineWords(NAMES_COPY.savePdf), onPress: () => router.push('/names-list') }] : []),
                { text: settingsLineWords(NAMES_COPY.signOutAnyway), style: 'destructive' as const, onPress: () => void signOutNow() },
            ]);
        }

        Alert.alert(
            t("Sign Out (Device Only)"),
            hasMnemonic(identity)
                ? t("This removes your private key and local database from this phone. Your account remains safely stored on the community node and can be restored anytime with your 12-word recovery phrase.")
                : settingsLineWords(NO_WORDS_SIGN_OUT_ALERT),
            [
                { text: t("Cancel"), style: "cancel" },
                {
                    text: t("Sign Out"),
                    style: "destructive",
                    onPress: () => void signOutAfterNamesCopies()
                }
            ]
        );
    }

    async function handleNodePurge() {
        if (!identity) return;
        // Asked as the screen opened, and the button waits for it: the member confirms what the plan says, and exactly
        // that happens.
        const plan = deletePlan;
        if (!plan) return;
        // Accept either the node-held callsign (what the profile card shows) or the
        // device-global one — they differ per node, and demanding the invisible one
        // would leave the user typing the name in front of them and being rejected.
        const purgeNames = [nodeCallsign, identity.callsign]
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map(c => c.trim().toLowerCase());
        if (purgeConfirm !== 'DELETE' && !purgeNames.includes(purgeConfirm.trim().toLowerCase())) {
            Alert.alert(t("Warning"), t("You must type exactly '{word}' or '{name}' to permanently purge your account.", { word: 'DELETE', name: nodeCallsign || identity.callsign || 'CALLSIGN' }));
            return;
        }
        const success = await authenticateUser(t('Confirm authentication to permanently purge your account from the node.'));
        if (!success) return;

        const words = hasMnemonic(identity);
        const keptFor = plan.kind === 'this-one' ? listNameWords(plan.keeps.map((c) => c.name)) : '';

        function showPurgeOutcome(outcome: DeleteOutcome) {
            if (!identity || !plan) return;
            switch (outcome.kind) {
                case 'not-deleted':
                    Alert.alert(t("Purge Failed"), deleteFailedWords(outcome.reason || t("Failed to purge account from node. Active deals holding Beans in trust may need to be completed or cancelled first."), words));
                    return;
                case 'left-unfinished':
                    Alert.alert(t("Account Deleted Here"), deletedButWords(plan.hereName, outcome.reason, true, words));
                    return;
                case 'left':
                    Alert.alert(
                        t("Account Deleted Here"),
                        words
                            ? t('Your account at {here} has been permanently deleted. Your key and 12 words stay on this phone for {communities}.', { here: plan.hereName, communities: keptFor })
                            : t('Your account at {here} has been permanently deleted. Your key stays on this phone for {communities}.', { here: plan.hereName, communities: keptFor }),
                    );
                    // Through Welcome for the next community, as switching community does.
                    router.replace('/welcome');
                    return;
                case 'vault-copy-stays':
                    // The account here is deleted and the key is still on the phone: the member chooses, and the
                    // phone is wiped only by their answer (utils/delete-here.ts finishLastDelete).
                    Alert.alert(
                        t("Vault Copy Not Removed"),
                        vaultCopyStaysWords(plan.hereName, outcome),
                        [
                            { text: t("Try Again"), onPress: () => { void finishPurgeAtLast('try-again'); } },
                            { text: t("Delete Anyway"), style: "destructive", onPress: () => { void finishPurgeAtLast('delete-anyway'); } },
                        ],
                        { cancelable: false },
                    );
                    return;
                case 'wipe-unfinished':
                    Alert.alert(t("Account Purged"), deletedButWords(plan.hereName, outcome.reason, false, words));
                    return;
                case 'wiped':
                    setIdentity(null);
                    Alert.alert(t("Account Purged"), t("Your account and profile have been permanently purged from the community node."));
                    return;
            }
        }

        async function finishPurgeAtLast(choice: VaultCopyChoice) {
            if (!identity) return;
            setAdvancedLoading(true);
            try {
                const outcome = await finishLastDelete(identity, choice);
                showPurgeOutcome(outcome);
            } finally {
                setAdvancedLoading(false);
            }
        }

        // Whole sentences per variant: where it deletes, and whether the 12 words could have undone it.
        const purgeWhat = plan.kind === 'this-one'
            ? (words
                ? t('This will permanently delete your profile, listings, and data at {here}. Your Bean balance there will be settled with its Commons Pool. This CANNOT be undone, even with your 12-word phrase.', { here: plan.hereName })
                : t('This will permanently delete your profile, listings, and data at {here}. Your Bean balance there will be settled with its Commons Pool. This CANNOT be undone.', { here: plan.hereName }))
            : (words
                ? t('This will permanently delete your profile, listings, and data from the community node and wipe this phone. Your Bean balance will be settled with the Commons Pool. This CANNOT be undone, even with your 12-word phrase.')
                : t('This will permanently delete your profile, listings, and data from the community node and wipe this phone. Your Bean balance will be settled with the Commons Pool. This CANNOT be undone.'));
        Alert.alert(
            t("Permanent Node Purge"),
            plan.kind === 'this-one'
                ? `${purgeWhat}\n\n${keepsKeyWords(plan, words)}`
                : `${purgeWhat}\n\n${lastCommunityWords(plan, words, hasVault())}`,
            [
                { text: t("Cancel"), style: "cancel" },
                {
                    text: t("Permanently Purge"),
                    style: "destructive",
                    onPress: async () => {
                        setAdvancedLoading(true);
                        try {
                            // The node deletes the account here; only once it has, the phone leaves this community
                            // (other communities keep the key) or is wiped as Sign Out wipes it (the last one).
                            const outcome = await deleteAccountHere(identity, plan);
                            showPurgeOutcome(outcome);
                        } finally {
                            setAdvancedLoading(false);
                        }
                    }
                }
            ]
        );
    }

    // Account Protection's ways back (vault rethink VR0, design §4.5), in a build with BeanPool's key vault: the 12 words
    // first, then the sign-in row, which names the vault before Protect with is tapped. A build without a vault draws
    // the panel above the words, exactly as before.
    const waysBack = hasVault();
    const protectionPanel = (
        <KeeperProtectionPanel
            colors={colors}
            protection={protectionFrom(protectionResult)}
            communityName={protectionNodeLabel || undefined}
            hasWords={hasMnemonic(identity)}
            waysBack={waysBack}
            copiesAt={copiesAt}
            onProtectSso={Platform.OS !== 'web' ? (prov, listCommunities) => {
                if (prov) setSsoEnrolProvider(prov);
                setSsoListCommunities(listCommunities);
                skipNextFocusResetRef.current = true;
                setShowSsoSheet(true);
            } : undefined}
            onDisconnectSso={Platform.OS !== 'web' ? handleDisconnectSso : undefined}
            listCommunitiesFor={identity?.publicKey}
        />
    );

    return (
        // KeyboardAwareScrollView scrolls the focused field (e.g. Edit Profile → Bio) above the keyboard and adds
        // the keyboard's height as bottom space itself. The old KeyboardAvoidingView did nothing on Android
        // (behavior undefined) and the extra bottom padding let the page scroll, but nothing moved the field into view.
        <KeyboardAwareScrollView
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingBottom: 48 }]}
            bottomOffset={16}
            refreshControl={
                // Also inside the profile editor: the loader refreshes only the fields the member has not touched.
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor={colors.brand.primary}
                    colors={[colors.brand.primary]}
                    progressBackgroundColor={colors.surface.card}
                />
            }
        >
            {/* A known community's consent (community modes slice 6): offered, never required. */}
            <KnownConsentCard />

            {/* ─── Identity Dashboard Card ─── */}
            <View style={styles.identityCard}>
                <View style={styles.identityInner}>
                    {/* Edit button — top-right corner */}
                    <Pressable style={styles.editBadge} onPress={() => setMode('profile')} accessibilityRole="button">
                        <Text style={styles.editBadgeText}>{t('✏️ Edit')}</Text>
                    </Pressable>

                    {/* Avatar */}
                    {/* Rendered through MemberAvatar, like every other avatar in the app. A raw
                        react-native Image was given the local members row verbatim — which since
                        #725 is the RELATIVE `/api/avatar/<pk>?size=thumb` the node emits, and
                        RN Image cannot load a relative path. The card showed an empty ring while
                        My Profile showed the photo. MemberAvatar resolves the path against the
                        anchor node and falls back to initials, never to a blank circle. Same
                        96px, same ring, same tap target and labels. */}
                    <Pressable onPress={() => setMode('profile')} style={styles.avatarWrap} accessibilityRole="button" accessibilityLabel={t('Edit profile')}>
                        <MemberAvatar
                            avatarUrl={cardAvatar}
                            updatedAt={cardAvatar === own.avatarUrl ? own.updatedAt : undefined}
                            pubkey={identity.publicKey}
                            callsign={cardCallsign}
                            size={96}
                        />
                        <View style={styles.avatarRing} />
                    </Pressable>

                    {/* Callsign */}
                    <Text style={styles.callsignText}>{cardCallsign}</Text>

                    {/* Community name: names are per community */}
                    {communityLabel ? (
                        <Text style={styles.communitySubtext} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                            {t('Your name in {name}', { name: communityLabel })}
                        </Text>
                    ) : null}

                    {/* Bio */}
                    {bio ? <Text style={styles.bioText}>{bio}</Text> : null}

                    {/* Contact */}
                    {contact ? (
                        <View style={styles.contactRow}>
                            <Text style={{ fontSize: 13 }}>📱</Text>
                            <Text style={styles.contactText}>{contact}</Text>
                        </View>
                    ) : null}

                    {/* Public Key — truncated, tap to copy */}
                    <Pressable
                        style={styles.pubkeyRow}
                        accessibilityRole="button"
                        accessibilityLabel={t('Copy public key')}
                        onPress={async () => {
                            await Clipboard.setStringAsync(identity.publicKey);
                            Alert.alert(t('Copied'), t('Public key copied to clipboard.'));
                        }}
                    >
                        <Text style={styles.pubkeyText}>
                            {identity.publicKey.slice(0, 6)}...{identity.publicKey.slice(-6)}
                        </Text>
                        <Text style={{ fontSize: 12, marginLeft: 6 }}>📋</Text>
                    </Pressable>
                </View>
            </View>

            {mode === 'menu' && (
                <>
                {/* Mirrors the PWA, which mounts this at the top of the root settings
                    screen. An active recovery against this account must be visible
                    without first navigating into a sub-screen. */}
                <RecoveryAlertBanner onStopSuccess={fetchProtectionStatus} />
                {/* A sign-in copy a community still keeps, moved to BeanPool's key vault with one sign-in (utils/vault-move.ts). */}
                <VaultMoveCard onMoved={() => { void fetchProtectionStatus(); }} />
                {/* Owners and admins only — the node answers the role; see components/NodeAdminEntry.tsx. */}
                <NodeAdminEntry styles={styles} fallbackCommunityName={protectionNodeLabel} onAppLockTurnedOn={onAppLockTurnedOn} onRoleChange={(r) => setRoleAsk(canManageNode(r) ? 'role' : 'none')} activeFeatures={activeFeatures} />
                {/* Owners only: "Check your 12 words" (sealed-keys.md §7); see components/OwnerWordsCard.tsx. */}
                <OwnerWordsCard styles={styles} />
                {roleAsk === 'none' && (
                    <>
                        <Text style={styles.sectionHeader}>{t("COMMUNITY")}</Text>
                        <View style={styles.menuGroup}>
                            <Pressable
                                style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                                onPress={() => setShapeSheetOpen(true)}
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
                        </View>
                    </>
                )}
                <Text style={styles.sectionHeader}>{t("ACCOUNT & IDENTITY")}</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={() => router.push('/profile-setup')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>✨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Re-run Setup")}</Text>
                            <Text style={styles.menuSub}>{t("Update your name & photo, and how BeanPool works")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    <Pressable style={styles.menuBtn} onPress={() => { setMode('protection'); }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Account Protection")}</Text>
                            <Text style={styles.menuSub}>{t("Manage how you get back into your account")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    {/* The member's reset of one community's chat memory (DM pins, design §3.4 amendment 6 §3): the way out the
                        "couldn't read who this community's chats are with" sentence names. */}
                    <Pressable style={styles.menuBtn} onPress={() => setMode('chatMemory')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💬</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t(CHAT_MEMORY_COPY.row)}</Text>
                            <Text style={styles.menuSub}>{t(CHAT_MEMORY_COPY.rowSub)}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>


                    <Pressable style={styles.menuBtn} onPress={() => router.push('/pulse')} accessibilityRole="button" accessibilityLabel={t("The Pulse community feed")}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🗞️</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("The Pulse")}</Text>
                            <Text style={styles.menuSub}>{t("What your neighbours are creating and posting")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    <Pressable style={styles.menuBtn} onPress={() => router.push('/channels')} accessibilityRole="button" accessibilityLabel={t("Channels and showcase")}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📡</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Channels & Showcase")}</Text>
                            <Text style={styles.menuSub}>{t("Link the places you already post your work")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    <Pressable style={styles.menuBtn} onPress={() => router.push('/pulse-intake')} accessibilityRole="button" accessibilityLabel={t("Share post to Pulse")}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>✨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Share to Pulse")}</Text>
                            <Text style={styles.menuSub}>{t("Manually share a post from your channels")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    {/* The links this member shared outside the community (front doors S6, app/shared-outside.tsx): only where it allows it. */}
                    {shareOutsideOn(nodeProfile?.features) && (
                        <Pressable style={styles.menuBtn} onPress={() => router.push('/shared-outside' as any)} accessibilityRole="button" testID="settings-shared-outside">
                            <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔗</Text></View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.menuText}>{t(PEEK_WORDS.sharedOutside)}</Text>
                            </View>
                            <Text style={styles.menuChevron}>›</Text>
                        </Pressable>
                    )}

                    <Pressable style={styles.menuBtn} onPress={() => router.push('/pair-device')} accessibilityRole="button" accessibilityLabel={t('Link a device')} accessibilityHint={t('Copies your own account to a browser, to use BeanPool there as you')}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📲</Text></View>
                        {/* Not "Manage this community from a computer" (NodeAdminEntry), which signs a browser into the community's Settings. Older apps: "Use your account on another device", before it "Link Another Device" (Marty, 16 Oct: renamed). */}
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t('Link a device')}</Text>
                            <Text style={styles.menuSub}>{t('Copies your own account to a browser, to use BeanPool there as you')}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={openViewWords} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔑</Text></View>
                        {/* On every phone. With no copy of the words here, the line under it says so and the row opens the add form. */}
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{settingsLineWords(viewWordsRow.title)}</Text>
                            <Text style={styles.menuSub}>{settingsLineWords(viewWordsRow.sub)}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── Community Pricing Guide ─── */}
                {showsBeans && (
                <>
                <Text style={styles.sectionHeader}>{t("COMMUNITY PRICING GUIDE")}</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => setShowPricingGuide(true)} accessibilityRole="button" accessibilityLabel={t("Open Community Pricing Guide")}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💡</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Browse 500+ Item Estimates")}</Text>
                            <Text style={styles.menuSub}>{t("Search benchmark community prices & report feedback")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>
                </>
                )}

                {/* ─── App Settings ─── */}
                <Text style={styles.sectionHeader}>{t("APP SETTINGS")}</Text>
                <View style={styles.menuGroup}>
                    {/* Appearance: follow the phone, or always light / dark */}
                    <View style={styles.appearanceBlock}>
                        <View style={styles.appearanceHeader}>
                            <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌙</Text></View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.menuText}>{t("Appearance")}</Text>
                                <Text style={styles.menuSub}>{t("Light or dark, or the same as your phone")}</Text>
                            </View>
                        </View>
                        <View style={styles.segmentRow} accessibilityRole="radiogroup" accessibilityLabel={t("Appearance")}>
                            {THEME_PREFERENCE_OPTIONS.map((option) => {
                                const { value } = option;
                                const selected = themePreference === value;
                                return (
                                    <Pressable
                                        key={value}
                                        style={[styles.segment, selected && styles.segmentSelected]}
                                        accessibilityRole="radio"
                                        accessibilityLabel={t(option.label)}
                                        accessibilityState={{ checked: selected }}
                                        onPress={() => setThemePreference(value)}
                                    >
                                        <Text style={[styles.segmentText, selected && styles.segmentTextSelected]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>{t(option.label)}</Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>

                    {/* Language: per device, live; each language in its own name (components/LanguagePicker.tsx). */}
                    <LanguageRow styles={styles} />

                    {/* Background pattern: the doodle wallpaper, or a plain colour. Per device. */}
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🎨</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Background pattern")}</Text>
                            <Text style={styles.menuSub}>{t("Doodles behind the app, or a plain background")}</Text>
                        </View>
                        <Pressable
                            style={[styles.toggle, patternEnabled && styles.toggleOn]}
                            accessibilityRole="switch"
                            accessibilityLabel={t("Background pattern")}
                            accessibilityState={{ checked: patternEnabled }}
                            onPress={() => setPatternEnabled(!patternEnabled)}
                        >
                            <View style={[styles.toggleThumb, patternEnabled && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>

                    {/* App Lock Switch */}
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔒</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("App Lock")}</Text>
                            <Text style={styles.menuSub}>{t("Asks for your phone's screen lock when BeanPool opens")}</Text>
                        </View>
                        <Pressable 
                            style={[styles.toggle, appLockEnabled && styles.toggleOn]} 
                            accessibilityRole="button" 
                            accessibilityLabel={t("Toggle App Lock")} 
                            accessibilityState={{ checked: appLockEnabled }} 
                            onPress={handleToggleAppLock}
                        >
                            <View style={[styles.toggleThumb, appLockEnabled && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                    <Pressable style={styles.menuBtn} onPress={async () => {
                        setMode('notifications');
                        setNotifLoading(true);
                        try {
                            const url = await AsyncStorage.getItem('beanpool_anchor_url');
                            if (url && identity?.publicKey) {
                                const res = await fetch(`${url}/api/members/preferences?publicKey=${identity.publicKey}`);
                                if (res.ok) {
                                    const prefs = await res.json();
                                    setNotifChat(prefs.notify_chat !== 'false');
                                    setNotifMarketplace(prefs.notify_marketplace !== 'false');
                                    setEventReminders(parseReminderOffsets(prefs[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS);
                                    setNotifEscrow(prefs.notify_escrow !== 'false');
                                    setNotifKnocks(prefs.notify_knocks === 'true');
                                }
                                if (identity.privateKey) setKnockSwitch(knockSwitchShown(nodeProfile?.features, (await askNodeRole(url, identity))?.role));
                            }
                        } catch (e) { console.warn('[Prefs] Failed to fetch preferences:', e); }
                        setNotifLoading(false);
                    }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔔</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Notification Preferences")}</Text>
                            <Text style={styles.menuSub}>{t("Control push alerts by category")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📍</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Location")}</Text>
                            <Text style={styles.menuSub}>{locationEnabled ? t('Enabled — used for nearby posts & map') : t('Disabled — tap to enable')}</Text>
                        </View>
                        <Pressable
                            style={[styles.toggle, locationEnabled && styles.toggleOn]}
                            accessibilityRole="button"
                            accessibilityLabel={t("Toggle Location permission")}
                            accessibilityState={{ checked: locationEnabled }}
                            onPress={handleLocationToggle}
                        >
                            <View style={[styles.toggleThumb, locationEnabled && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                    {byArea && (
                        <Pressable
                            style={styles.menuBtn}
                            onPress={() => router.push('/your-area' as any)}
                            accessibilityRole="button"
                            accessibilityLabel={t('Your area: {area}', { area: settingsLineWords(areaLine) })}
                            testID="settings-your-area"
                        >
                            <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🗺️</Text></View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.menuText}>{t("Your area")}</Text>
                                <Text style={styles.menuSub}>{settingsLineWords(areaLine)}</Text>
                            </View>
                            <Text style={styles.menuChevron}>›</Text>
                        </Pressable>
                    )}
                    {/* Holiday Mode — pause your presence; hides your offers, stops new requests */}
                    <View style={[styles.menuBtn, styles.menuBtnLast]}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌴</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Holiday Mode")}</Text>
                            <Text style={styles.menuSub}>{holidayMode ? t("You're away — offers hidden, no new requests") : t('Going away? Hide your offers and pause requests')}</Text>
                        </View>
                        <Pressable
                            style={[styles.toggle, holidayMode && styles.toggleOn, holidayLoading && { opacity: 0.5 }]}
                            accessibilityRole="button"
                            accessibilityLabel={t("Toggle Holiday Mode")}
                            accessibilityState={{ checked: holidayMode }}
                            disabled={holidayLoading}
                            onPress={handleToggleHoliday}
                        >
                            <View style={[styles.toggleThumb, holidayMode && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                </View>

                {/* ─── BeanPool: the members' sheet, Suggest a change (goes to beanpool.org, not this community's node), the website ─── */}
                <Text style={styles.sectionHeader}>{t("BEANPOOL")}</Text>
                <View style={styles.menuGroup}>
                    {beanPoolSettingsEntries(FEEDBACK_LIVE).map((entry, i, all) => {
                        const last = i === all.length - 1 ? styles.menuBtnLast : null;
                        if (entry === 'help') return (
                            <Pressable key={entry} style={[styles.menuBtn, last]} onPress={() => router.push('/beanpool')} accessibilityRole="button" accessibilityLabel={t("BeanPool: help and how it works")}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🫘</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Help & how it works")}</Text>
                                    <Text style={styles.menuSub}>{t("How to use every part of the app, the rules, questions")}</Text>
                                </View>
                                <Text style={styles.menuChevron}>›</Text>
                            </Pressable>
                        );
                        // Only while FEEDBACK_LIVE: the same suggest-change screen the BeanPool sheet opens.
                        if (entry === 'suggest') return (
                            <Pressable key={entry} style={[styles.menuBtn, last]} onPress={() => router.push('/suggest-change')} accessibilityRole="button" accessibilityLabel={t("Suggest a change to BeanPool")}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💬</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Suggest a change")}</Text>
                                    <Text style={styles.menuSub}>{t("Ideas and problems go to the BeanPool project team")}</Text>
                                </View>
                                <Text style={styles.menuChevron}>›</Text>
                            </Pressable>
                        );
                        return (
                            <Pressable key={entry} style={[styles.menuBtn, last]} onPress={() => { void openBeanPoolWebsite(); }} accessibilityRole="link" accessibilityLabel={t("beanpool.org, opens in your browser")}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌐</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>beanpool.org</Text>
                                    <Text style={styles.menuSub}>{t("The BeanPool project website")}</Text>
                                </View>
                                <Text style={styles.menuChevron}>›</Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* ─── Legal & Privacy ─── */}
                <Text style={styles.sectionHeader}>{t("LEGAL & PRIVACY")}</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={handleOpenBlockedModal} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚫</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>{t("Manage Blocked Users")}</Text>
                        <Text style={styles.menuChevron} aria-hidden={true} importantForAccessibility="no">›</Text>
                    </Pressable>
                    {showAsConnection !== null && (
                        <View style={styles.menuBtn}>
                            <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🤝</Text></View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.menuText}>{t("Show me as a connection in common")}</Text>
                                <Text style={styles.menuSub}>{t("When you and two people are friends both ways, each can see your name on the other's profile")}</Text>
                            </View>
                            <Pressable style={[styles.toggle, showAsConnection && styles.toggleOn]} accessibilityRole="switch" accessibilityLabel={t("Show me as a connection in common")} accessibilityState={{ checked: showAsConnection }} onPress={async () => {
                                const next = !showAsConnection; setShowAsConnection(next);
                                try {
                                    if (identity?.publicKey) await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { show_as_connection_in_common: next } });
                                } catch (e: any) {
                                    setShowAsConnection(!next);
                                    Alert.alert(t('Not saved'), e?.message ? signedRequestWords(e.message) : t('Your community could not save that.'));
                                }
                            }}>
                                <View style={[styles.toggleThumb, showAsConnection && styles.toggleThumbOn]} />
                            </Pressable>
                        </View>
                    )}
                    <Pressable style={styles.menuBtn} onPress={() => Linking.openURL('https://beanpool.org/privacy.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>{t("Privacy Policy")}</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={styles.menuBtn} onPress={() => Linking.openURL('https://beanpool.org/terms.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>⚖️</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>{t("Terms of Service & EULA")}</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => Linking.openURL('https://beanpool.org/safety.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚸</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>{t("Child Safety Standards")}</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── Advanced ─── */}
                <Text style={styles.sectionHeader}>{t("SYSTEM")}</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={async () => {
                        setMode('diagnostics');
                        await loadDiagnostics();
                    }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📊</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{t("Database Health & Stats")}</Text>
                            <Text style={styles.menuSub}>{t("Local storage metrics & integrity checks")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => setMode('advanced')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>⚙️</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText} adjustsFontSizeToFit minimumFontScale={0.75}>{t("Saved communities")}</Text>
                            <Text style={styles.menuSub}>{t("Switch, forget or refresh the communities on this phone")}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── Danger Zone ─── */}
                <View style={{ marginTop: 24 }}>
                    <View style={styles.dangerGroup}>
                        <Pressable 
                            style={[styles.menuBtn, styles.menuBtnLast]} 
                            onPress={() => { 
                                setMode('wipe'); 
                                setWipeType('options'); 
                                setWipeConfirm(''); 
                                setPurgeConfirm(''); 
                            }} 
                            accessibilityRole="button" 
                            accessibilityHint={t("Choose to remove account from device or permanently delete from node")}
                        >
                            <View style={[styles.menuIconWrap, { backgroundColor: theme === 'dark' ? colors.feedback.danger.bg : palette.red50 }]}><Text style={styles.menuIcon}>⚠️</Text></View>
                            <Text style={[styles.menuText, { flex: 1, color: colors.feedback.danger.fg }]}>{t("Account Deletion & Sign Out")}</Text>
                            <Text style={[styles.menuChevron, { color: palette.red300 }]}>›</Text>
                        </Pressable>
                    </View>
                </View>

                {/* ─── Version Footer ─── */}
                <Text style={styles.versionText}>
                    {t('BEANPOOL OS {version} (Build {build})', { version: appConfig.expo.version, build: Platform.OS === 'ios' ? appConfig.expo.ios.buildNumber : String(appConfig.expo.android.versionCode) })}
                </Text>
                </>
            )}

            {mode === 'protection' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("🛡️ Account Protection")}</Text>
                    <Text style={styles.infoText}>
                        {t("This is how you get back into your account if you lose your phone.")}
                    </Text>

                    {/* The code a chat partner checks when their phone says the key behind your name changed. Worked out
                        from this phone's key alone, so it never waits behind the sign-in answer below (#1873 review, finding 9):
                        an in-person check works with a slow network or none. */}
                    <MyKeyCodeCard publicKey={identity?.publicKey} />

                    {/* Only the sign-in part waits for its answer (the key vault's, up to 20 s, or the community's): the
                        12 words below never wait behind it (PR #1336 review finding 9). */}
                    {protectionLoading ? (
                        <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 20 }} accessibilityLabel={t("Checking your sign-in accounts")} />
                    ) : (
                        <>
                            <RecoveryAlertBanner onStopSuccess={fetchProtectionStatus} />
                            {/* In by 12 words with no sign-in: one way back, said plainly, with the sign-in offered (two-doors §2.5). */}
                            <OneWayBackCard place="settings" colors={colors} />
                            <VaultMoveCard onMoved={() => { void fetchProtectionStatus(); }} />
                            {protectionNote && (
                                <Text style={[styles.infoText, { marginBottom: 12 }]} accessibilityLiveRegion="polite">{settingsLineWords(protectionNote)}</Text>
                            )}
                            {!waysBack && protectionPanel}
                        </>
                    )}

                    <>
                        {/* On every phone. With the words it shows them here; on a phone with no copy (restored with a
                            sign-in) it says so in one line and opens "Add your 12 words" (openViewWords). With a key vault
                            it is the first way back, and the sign-in row follows it (waysBack). */}
                        <View style={waysBack
                            ? { marginTop: 12, marginBottom: 16 }
                            : { marginTop: 24, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                            <Text style={{ color: colors.text.heading, fontSize: 16, fontWeight: 'bold', marginBottom: 8 }} accessibilityRole={waysBack ? 'header' : undefined}>
                                {waysBack ? t('🔑 Your 12 words') : t("🔑 12 Recovery Words")}
                            </Text>
                            <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 12 }}>
                                {waysBack && <><Text>{t('Always work, anywhere.')}</Text>{' '}</>}
                                {hasMnemonic(identity)
                                    ? (waysBack
                                        ? t('On this phone: keep them private and never share them with anyone.')
                                        : t('Your 12 recovery words can restore your account on any device. Keep them private and never share them with anyone.'))
                                    : settingsLineWords(NO_WORDS_VIEW_LINE)}
                            </Text>

                            {!(hasMnemonic(identity) && revealWords) ? (
                                <Pressable
                                    style={{
                                        backgroundColor: colors.surface.card,
                                        borderColor: colors.border.default,
                                        borderWidth: 1,
                                        borderRadius: 12,
                                        padding: 14,
                                        alignItems: 'center',
                                    }}
                                    onPress={hasMnemonic(identity) ? handleRevealWords : openViewWords}
                                    disabled={revealLoading}
                                    accessibilityRole="button"
                                    // The visible words, one key for both, the emoji outside it (WCAG 2.5.3).
                                    accessibilityLabel={t("Show My 12 Recovery Words")}
                                    accessibilityHint={hasMnemonic(identity) ? undefined : settingsLineWords(NO_WORDS_MENU.sub)}
                                >
                                    <Text style={{ color: colors.text.heading, fontWeight: '600', fontSize: 15 }}>
                                        <Text>👁️</Text> {t("Show My 12 Recovery Words")}
                                    </Text>
                                </Pressable>
                            ) : (
                                <View style={{ backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 16 }}>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                                        <NoScreenCapture>
                                        {mnemonicWords?.split(' ').map((word, idx) => (
                                            <View
                                                key={`${word}-${idx}`}
                                                accessible={true}
                                                accessibilityLabel={t('Word {n}: {word}', { n: idx + 1, word })}
                                                style={{ backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, flexDirection: 'row', alignItems: 'center' }}
                                            >
                                                <Text style={{ color: colors.text.muted, fontSize: 11, marginRight: 6 }}>{idx + 1}.</Text>
                                                <Text style={{ color: colors.text.heading, fontWeight: '600', fontSize: 14 }}>{word}</Text>
                                            </View>
                                        ))}
                                        </NoScreenCapture>
                                    </View>

                                    <View style={{ flexDirection: 'row', gap: 10 }}>
                                        <Pressable
                                            style={{ flex: 1, backgroundColor: colors.brand.fill, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}
                                            onPress={handleCopyWords}
                                            accessibilityRole="button"
                                            accessibilityLabel={copiedWords ? t("Recovery words copied to clipboard") : t("Copy 12 recovery words to clipboard")}
                                        >
                                            <Text style={{ color: colors.text.inverse, fontWeight: 'bold', fontSize: 14 }}>
                                                {copiedWords ? t('✅ Copied!') : t('📋 Copy Words')}
                                            </Text>
                                        </Pressable>
                                        <Pressable
                                            style={{ backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center' }}
                                            onPress={putProtectionWordsAway}
                                            accessibilityRole="button"
                                            accessibilityLabel={t("Hide 12 recovery words")}
                                        >
                                            <Text style={{ color: colors.text.body, fontWeight: '600', fontSize: 14 }}>{t("Hide")}</Text>
                                        </Pressable>
                                    </View>
                                    <View style={{ marginTop: 10 }}>
                                        <RecoveryKitButtons words={mnemonicWords ? mnemonicWords.split(' ') : null} colors={colors} />
                                    </View>
                                    <CopyClearsNote style={{ color: colors.text.secondary, fontSize: 12, lineHeight: 17, marginTop: 10 }} />
                                    <NoScreenLockNote style={{ color: colors.text.secondary, fontSize: 12, lineHeight: 17, marginTop: 8 }} />
                                </View>
                            )}
                        </View>

                        {/* The sign-in row, second, once the key vault has answered (the words above never wait for it). */}
                        {waysBack && !protectionLoading && protectionPanel}

                        {/* The third way back (vault rethink VR3): your community's admins, where the community keeps copies itself,
                            never in the global community; or wherever it already keeps this member's copy. */}
                        <CommunityAdminsRow communityName={protectionNodeLabel || undefined} />

                        {/* Every place a copy of this key is kept, as far as this phone can ask, since when, and removing
                            them (vault rethink VR1, design §5.1): app/ways-back.tsx. In every build: a community's copies
                            are listed there too. */}
                        <Pressable style={[styles.menuBtn, { borderBottomWidth: 0, minHeight: 48 }]} onPress={() => router.push('/ways-back')} accessibilityRole="button">
                            <View style={{ flex: 1 }}>
                                <Text style={styles.menuText}>{t('Where your account can be brought back from')}</Text>
                                <Text style={styles.menuSub}>{t('Every copy, since when, and removing them')}</Text>
                            </View>
                            <Text style={styles.menuChevron} accessibilityElementsHidden importantForAccessibility="no">›</Text>
                        </Pressable>

                        {Platform.OS === 'web' && (
                            <View style={{ backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border, borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 8 }}>
                                <Text style={{ color: colors.text.body, fontSize: 14, lineHeight: 20 }}>
                                    {t("The web version of BeanPool runs inside your hub's server, which means it can't safely manage recovery keys. Your 12 words are the only way back on the web.")}
                                </Text>
                                <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 8 }}>
                                    {t("For sign-in account recovery (Apple, Google), use the BeanPool app on your phone.")}
                                </Text>
                            </View>
                        )}
                    </>

                    <Pressable
                        style={[styles.backBtn, { marginTop: 16 }]}
                        onPress={() => setMode('menu')}
                        accessibilityRole="button"
                    >
                        <Text style={styles.backBtnText}>{t("← Back")}</Text>
                    </Pressable>
                </View>
            )}

            <SsoEnrolSheet
                visible={showSsoSheet}
                provider={ssoEnrolProvider}
                copiesAt={copiesAt}
                listCommunities={ssoListCommunities}
                onClose={() => setShowSsoSheet(false)}
                // The community's rule moved on since this screen read it, and nothing was linked: read it again, words and all.
                onCopiesChanged={() => { void fetchProtectionStatus(); }}
                onEnrolled={(result) => {
                    setShowSsoSheet(false);
                    // Kept at the community (a build without a vault, or a community that keeps copies itself): it answers
                    // the deposit with every sign-in it keeps, as before.
                    if (result.keptAt === 'community' || !hasVault()) {
                        setCopiesAt('community');
                        setProtectionResult(result);
                        return;
                    }
                    // The sign-in just linked, beside what was linked already; then the vault's own word on all of them.
                    setProtectionResult(prev => enrolmentFromVault([...(prev?.enrolledSso ?? []), ...(result.enrolledSso ?? [])]));
                    void fetchProtectionStatus();
                }}
            />

            {mode === 'profile' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("Edit Profile")}</Text>
                    
                    {/* Avatar Picker */}
                    <View style={{ alignItems: 'center', marginBottom: 20 }}>
                        <Pressable onPress={handlePickImage} style={{ alignItems: 'center' }} accessibilityRole="button" accessibilityLabel={t("Change profile photo")}>
                            <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.border.default, overflow: 'hidden' }}>
                                {/* Same resolver as the card above, for the same reason. The
                                    camera glyph stays the empty state: here it is an invitation
                                    to pick a photo, not a broken picture. */}
                                {avatar && avatar !== 'null' && avatar !== 'undefined' && avatar.trim() !== '' ? (
                                    <MemberAvatar
                                        avatarUrl={avatar}
                                        pubkey={identity.publicKey}
                                        callsign={nodeCallsign || identity.callsign}
                                        size={96}
                                    />
                                ) : (
                                    <Text style={{ fontSize: 32 }}>📷</Text>
                                )}
                            </View>
                            <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 8 }}>{t("Tap to change photo")}</Text>
                        </Pressable>
                    </View>

                    <Text style={styles.label}>{t("CALLSIGN")}</Text>
                    <TextInput
                        style={styles.input}
                        value={editCallsign}
                        onChangeText={(v) => { editedRef.current.callsign = true; setEditCallsign(v); }}
                        maxLength={32}
                        accessibilityLabel={t("Callsign")}
                    />

                    <Text style={styles.label}>{t("BIO")}</Text>
                    <TextInput
                        style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                        value={bio}
                        onChangeText={(v) => { editedRef.current.bio = true; setBio(v); }}
                        multiline
                        maxLength={200}
                        placeholder={t("A short bio about yourself...")}
                        placeholderTextColor={colors.text.secondary}
                        accessibilityLabel={t("Bio")}
                    />

                    <Text style={styles.label}>{t("CONTACT DETAILS")}</Text>
                    <TextInput
                        style={styles.input}
                        value={contact}
                        onChangeText={(v) => { editedRef.current.contact = true; setContact(v); }}
                        // The node refuses a longer one (#1493), and a refused save would keep the background profile sync retrying.
                        maxLength={CONTACT_VALUE_LIMIT.chars}
                        placeholder={t("Phone, email, or WhatsApp")}
                        placeholderTextColor={colors.text.secondary}
                        accessibilityLabel={t("Contact details")}
                    />

                    {contact.trim().length > 0 && (
                        <View style={styles.visibilitySection}>
                            <Text style={styles.visibilityLabel}>{t("Who can see this?")}</Text>
                            {([
                                { value: 'hidden' as const, emoji: '🔒', label: word('Hidden', 'who can see your contact details'), desc: word('Only you can see it') },
                                { value: 'trade_partners' as const, emoji: '🤝', label: word('Trade Partners'), desc: word('Visible when you enter a trade') },
                                { value: 'friends' as const, emoji: '👥', label: word('Friends'), desc: word('People you have added as friends') },
                                { value: 'community' as const, emoji: '🌍', label: word('Community'), desc: word('Anyone on this node') },
                            ]).map(opt => {
                                const isActive = contactVisibility === opt.value;
                                return (
                                    <Pressable
                                        key={opt.value}
                                        style={[styles.visibilityOption, isActive && styles.visibilityOptionActive]}
                                        onPress={() => { editedRef.current.contact = true; setContactVisibility(opt.value); }}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: isActive }}
                                    >
                                        <Text style={styles.visibilityEmoji}>{opt.emoji}</Text>
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.visibilityOptionLabel, isActive && styles.visibilityOptionLabelActive]}>{t(opt.label)}</Text>
                                            <Text style={[styles.visibilityOptionDesc, isActive && styles.visibilityOptionDescActive]}>{t(opt.desc)}</Text>
                                        </View>
                                        {isActive && <Text style={styles.visibilityCheck}>✓</Text>}
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}

                    <Pressable
                        style={styles.primaryBtn}
                        onPress={handleUpdateCallsign}
                        disabled={loading}
                        accessibilityRole="button"
                        accessibilityLabel={loading ? t("Saving profile...") : t("Save Profile")}
                        accessibilityState={{ disabled: loading, busy: loading }}
                    >
                        {loading ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={styles.primaryBtnText}>{t("Save Profile")}</Text>}
                    </Pressable>
                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t("Cancel")}</Text>
                    </Pressable>
                </View>
            )}



            {mode === 'notifications' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("🔔 Notification Preferences")}</Text>
                    <Text style={styles.infoText}>
                        {t("Control which push notifications wake up your device. Changes are saved automatically.")}
                    </Text>

                    {notifLoading ? (
                        <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 20 }} />
                    ) : (
                        <View style={styles.menuGroup}>
                            <View style={styles.menuBtn}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💬</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Direct Messages")}</Text>
                                    <Text style={styles.menuSub}>{t("Get notified when someone messages you")}</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifChat && styles.toggleOn]} accessibilityRole="button" accessibilityLabel={t("Direct messages notifications")} accessibilityState={{ checked: notifChat }} onPress={async () => {
                                    const next = !notifChat; setNotifChat(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_chat: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifChat && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                            <View style={styles.menuBtn}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📬</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Marketplace Activity")}</Text>
                                    <Text style={styles.menuSub}>{t("Requests, approvals & rejections")}</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifMarketplace && styles.toggleOn]} accessibilityRole="button" accessibilityLabel={t("Marketplace activity notifications")} accessibilityState={{ checked: notifMarketplace }} onPress={async () => {
                                    const next = !notifMarketplace; setNotifMarketplace(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_marketplace: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifMarketplace && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                            <View style={knockSwitch ? styles.menuBtn : [styles.menuBtn, styles.menuBtnLast]}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔒</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Held in Trust & System")}</Text>
                                    <Text style={styles.menuSub}>{t("Credits held in trust, released, or disputed")}</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifEscrow && styles.toggleOn]} accessibilityRole="button" accessibilityLabel={t("Held in trust and system notifications")} accessibilityState={{ checked: notifEscrow }} onPress={async () => {
                                    const next = !notifEscrow; setNotifEscrow(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_escrow: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifEscrow && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                            {knockSwitch && (
                                <View style={[styles.menuBtn, styles.menuBtnLast]}>
                                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚪</Text></View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.menuText}>{t("Requests to join")}</Text>
                                        <Text style={styles.menuSub}>{t("When someone asks to join your community")}</Text>
                                    </View>
                                    <Pressable style={[styles.toggle, notifKnocks && styles.toggleOn]} accessibilityRole="button" accessibilityLabel={t("Requests to join notifications")} accessibilityState={{ checked: notifKnocks }} onPress={async () => {
                                        const next = !notifKnocks; setNotifKnocks(next);
                                        try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_knocks: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                    }}>
                                        <View style={[styles.toggleThumb, notifKnocks && styles.toggleThumbOn]} />
                                    </Pressable>
                                </View>
                            )}
                        </View>
                    )}

                    {/* Event reminders (decision 2). Ticks rather than switches: this is one setting with
                        several answers, and "Off" is one of them, not a fourth category of alert. They ride
                        the Marketplace category, so they stop when that switch does — which the line says. */}
                    {!notifLoading && (
                        <View style={styles.menuGroup}>
                            <View style={styles.menuBtn}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>⏰</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>{t("Event reminders")}</Text>
                                    <Text style={styles.menuSub}>{t("Before an event you are going to, or interested in, starts")}</Text>
                                </View>
                            </View>
                            {REMINDER_OFFSETS.map(minutes => {
                                const on = eventReminders.includes(minutes);
                                return (
                                    <Pressable
                                        key={minutes}
                                        style={styles.reminderRow}
                                        onPress={() => saveEventReminders(normaliseReminderOffsets(
                                            on ? eventReminders.filter(m => m !== minutes) : [...eventReminders, minutes]
                                        ))}
                                        accessibilityRole="checkbox"
                                        accessibilityLabel={reminderBeforeWords(minutes)}
                                        accessibilityState={{ checked: on }}
                                    >
                                        <View style={[styles.reminderTick, on && styles.reminderTickOn]}>
                                            {on && <Text style={styles.reminderTickMark}>✓</Text>}
                                        </View>
                                        <Text style={styles.reminderLabel} numberOfLines={2}>{reminderBeforeWords(minutes)}</Text>
                                    </Pressable>
                                );
                            })}
                            <Pressable
                                style={[styles.reminderRow, styles.menuBtnLast]}
                                onPress={() => { if (eventReminders.length > 0) saveEventReminders([]); }}
                                accessibilityRole="checkbox"
                                accessibilityLabel={t('Off', undefined, 'event reminders')}
                                accessibilityState={{ checked: eventReminders.length === 0 }}
                            >
                                <View style={[styles.reminderTick, eventReminders.length === 0 && styles.reminderTickOn]}>
                                    {eventReminders.length === 0 && <Text style={styles.reminderTickMark}>✓</Text>}
                                </View>
                                <Text style={styles.reminderLabel} numberOfLines={2}>{t('Off', undefined, 'event reminders')}</Text>
                            </Pressable>
                            <Text style={styles.reminderNote}>
                                {t("Reminders arrive with your Marketplace alerts, so they stop if you switch those off. You can change the reminder on any one event.")}
                            </Text>
                        </View>
                    )}

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t("← Back")}</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'chatMemory' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t(CHAT_MEMORY_COPY.title)}</Text>
                    <ChatMemoryCard
                        communities={savedNodes.map((n) => ({ url: n.url, name: communityName({ url: n.url, alias: n.alias }) }))}
                        onReset={resetDmChatMemory}
                    />
                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t('← Back')}</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'advanced' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("Saved communities")}</Text>
                    <Text style={styles.infoText}>
                        {t("The communities this phone has joined. Your key and 12 words are the same in each; switch to one to use it.")}
                    </Text>

                    {savedNodes.map((node, i) => {
                        const isActive = node.url === anchorUrl;
                        return (
                            <View key={i} style={[{ padding: 12, borderWidth: isActive ? 2 : 1, borderColor: isActive ? colors.accent.primary : colors.border.default, borderRadius: 14, marginBottom: 10 }]}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                        <Text style={{ fontSize: 16 }}>{node.status === 'pinging' ? '🟡' : node.status === 'online' ? '🟢' : '🔴'}</Text>
                                        <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.text.heading }}>{node.url}</Text>
                                    </View>
                                    <Text style={{ fontSize: 12, color: colors.text.secondary, fontWeight: 'bold' }}>{t('{size} MB', { size: formatNumber(node.sizeBytes / 1024 / 1024, 1) })}</Text>
                                </View>
                                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                                    {!isActive ? (
                                        <Pressable style={{ flex: 1, backgroundColor: colors.surface.subtle, padding: 8, borderRadius: 6, alignItems: 'center' }} onPress={() => handleSwitchNode(node.url)} disabled={advancedLoading} accessibilityRole="button">
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: theme === 'dark' ? colors.text.body : palette.gray700 }}>{advancedLoading ? t('Switching...') : t('Switch to this community')}</Text>
                                        </Pressable>
                                    ) : (
                                        <View style={{ flex: 1, backgroundColor: colors.accent.tint, padding: 8, borderRadius: 6, alignItems: 'center' }}>
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: colors.accent.primary }}>{t("Active Node")}</Text>
                                        </View>
                                    )}
                                    {!isActive && (
                                        <Pressable style={{ padding: 8, backgroundColor: theme === 'dark' ? colors.feedback.danger.bg : palette.red100, borderRadius: 6 }} onPress={() => handleForgetNode(node.url)} accessibilityRole="button" accessibilityHint={t("Removes this community and deletes its local data from this device")}>
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: colors.feedback.danger.fg }}>{t("Forget")}</Text>
                                        </Pressable>
                                    )}
                                </View>

                                {isActive && (
                                    <View style={{ marginTop: 12, padding: 12, backgroundColor: colors.surface.subtle, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                        <Text style={{ fontSize: 13, fontWeight: 'bold', color: theme === 'dark' ? colors.text.body : palette.gray700, marginBottom: 8 }}>{t("Have an invite code for this community?")}</Text>
                                        <View style={{ flexDirection: 'row', gap: 8 }}>
                                            <TextInput
                                                style={{ flex: 1, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 6, paddingHorizontal: 10, height: 36, fontSize: 13, color: theme === 'dark' ? colors.text.body : undefined }}
                                                placeholder={t("Invite Code (e.g. INV-...)")}
                                                placeholderTextColor={theme === 'dark' ? colors.text.muted : undefined}
                                                value={redeemInviteCode}
                                                onChangeText={setRedeemInviteCode}
                                                autoCapitalize="characters"
                                                accessibilityLabel={t("Invite code")}
                                            />
                                            <Pressable
                                                style={{ backgroundColor: colors.brand.fill, paddingHorizontal: 16, borderRadius: 6, justifyContent: 'center' }}
                                                onPress={handleRedeemInvite}
                                                disabled={redeemLoading || !redeemInviteCode.trim()}
                                                accessibilityRole="button"
                                            >
                                                {redeemLoading ? <ActivityIndicator size="small" color={colors.text.inverse} /> : <Text style={{ color: colors.text.inverse, fontWeight: 'bold', fontSize: 13 }}>{t("Redeem")}</Text>}
                                            </Pressable>
                                        </View>
                                        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-start', paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                                            <Pressable style={{ backgroundColor: theme === 'dark' ? colors.feedback.danger.bg : palette.red50, padding: 8, borderRadius: 6, borderWidth: 1, borderColor: theme === 'dark' ? colors.feedback.danger.border : palette.red300 }} onPress={() => handleForceResync(node.url)} accessibilityRole="button" accessibilityHint={t("Deletes the local database for this community and redownloads everything")}>
                                                <Text style={{ fontSize: 12, fontWeight: 'bold', color: colors.feedback.danger.fg }}>{t("Clear this phone's copy and download again")}</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                )}
                            </View>
                        );
                    })}

                    <Text style={[styles.infoText, { marginTop: 6, marginBottom: 4 }]}>
                        {t('Run this community? Owners and admins see a Manage row at the top of Settings.')}
                    </Text>

                    <View style={{ height: 1, backgroundColor: colors.border.default, marginVertical: 24 }} />

                    {offerGlobal && (
                        <>
                            <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }}>{t("Join the global community")}</Text>
                            {/* Guest view first, as the web opens its lobby (utils/global-guest-visit.ts): the global community
                                opens as a guest, where the header's Join pill leads to the door. On it already as a guest:
                                the door itself. */}
                            {onGlobalNow ? (
                                <>
                                    <Text style={styles.infoText}>{t("Meet people from everywhere and find communities near you, as the account on this phone. Sign in once: your key and your 12 words stay the same, and nothing changes in your other communities.")}</Text>
                                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]} onPress={() => router.push('/join-global')} accessibilityRole="button">
                                        <Text style={styles.primaryBtnText}>{t("🌍 Join the global community")}</Text>
                                    </Pressable>
                                </>
                            ) : (
                                <>
                                    <Text style={styles.infoText}>{t("Meet people from everywhere and find communities near you. Look around first as a guest, then tap Join at the top to join as the account on this phone: your key and your 12 words stay the same, and nothing changes in your other communities.")}</Text>
                                    <Pressable
                                        style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, guestVisit.visiting && { opacity: 0.5 }]}
                                        onPress={() => { void guestVisit.visit(); }}
                                        disabled={guestVisit.visiting}
                                        accessibilityRole="button"
                                        accessibilityLabel={guestVisit.visiting ? t('Loading') : t('🌍 Look around the global community')}
                                        accessibilityState={{ disabled: guestVisit.visiting, busy: guestVisit.visiting }}
                                        testID="settings-global-visit"
                                    >
                                        {guestVisit.visiting ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={styles.primaryBtnText}>{t('🌍 Look around the global community')}</Text>}
                                    </Pressable>
                                </>
                            )}
                            <View style={{ height: 1, backgroundColor: colors.border.default, marginVertical: 24 }} />
                        </>
                    )}

                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }}>{t("Add a community by address")}</Text>
                    <Text style={styles.infoText}>{t("Connect to a community by typing its address. Your phone will save it to this list and switch to it.")}</Text>

                    <Text style={styles.label}>{t("COMMUNITY NAME (OPTIONAL)")}</Text>
                    <TextInput
                        style={styles.input}
                        value={newNodeAlias}
                        onChangeText={setNewNodeAlias}
                        placeholder={t("e.g. My Secret Base")}
                        placeholderTextColor={colors.text.secondary}
                        autoCapitalize="words"
                        autoCorrect={false}
                        accessibilityLabel={t("Community name (optional)")}
                    />

                    <Text style={styles.label}>{t("COMMUNITY ADDRESS")}</Text>
                    <TextInput
                        style={styles.input}
                        value={newAnchorInput}
                        onChangeText={setNewAnchorInput}
                        placeholder={t('e.g. {address}', { address: 'http://192.168.1.55' })}
                        placeholderTextColor={colors.text.secondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        accessibilityLabel={t("Community address")}
                    />
                    
                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, advancedLoading && { opacity: 0.5 }]} onPress={handleUpdateAnchor} disabled={advancedLoading} accessibilityRole="button">
                        {advancedLoading ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={styles.primaryBtnText}>{t("Add & Connect")}</Text>}
                    </Pressable>

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t("← Back")}</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'diagnostics' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("📊 Database Diagnostics & Health")}</Text>
                    <Text style={styles.infoText}>
                        {t("Transparency metrics for your local off-grid database cache. Structural check verifies zero data corruption natively.")}
                    </Text>

                    {diagLoading ? (
                        <View style={{ marginVertical: 40, alignItems: 'center' }}>
                            <ActivityIndicator size="large" color={colors.accent.primary} />
                            <Text style={{ marginTop: 12, color: colors.text.secondary, fontWeight: '600' }}>{t("Running Structural Integrity Check...")}</Text>
                        </View>
                    ) : (
                        <>
                             {/* Database Health & Sync Status Indicator */}
                             <View style={{ backgroundColor: colors.surface.subtle, padding: 14, borderRadius: 12, marginBottom: 20 }}>
                                 <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                      <Text style={{ fontWeight: 'bold', color: theme === 'dark' ? colors.text.body : palette.gray700 }}>{t("Database Status:")}</Text>
                                      {(() => {
                                          const hasIntegrityError = dbStats && dbStats.integrity !== 'ok';
                                          const isSynced = !remoteStats || (dbStats && 
                                              dbStats.members === remoteStats.members &&
                                              dbStats.posts === remoteStats.posts);

                                          let pillBg: string = palette.emerald100;
                                          let pillBorder: string = palette.emerald400;
                                          let textColor: string = palette.emerald800;
                                          let displayText = t('🟢 Healthy & Synced');

                                          if (hasIntegrityError) {
                                              pillBg = palette.red100;
                                              pillBorder = palette.red300;
                                              textColor = palette.red700;
                                              displayText = t('🔴 Corrupted: {detail}', { detail: dbStats?.integrity ?? '' });
                                          } else if (!remoteStats) {
                                              pillBg = colors.border.default;
                                              pillBorder = colors.border.strong;
                                              textColor = palette.gray600;
                                              displayText = t('⚪ Offline / Local-First');
                                          } else if (!isSynced) {
                                              pillBg = palette.orange100;
                                              pillBorder = palette.orange300;
                                              textColor = palette.orange700;
                                              displayText = t('⚠️ Out of Sync');
                                          }

                                          return (
                                              <View style={{ backgroundColor: pillBg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: pillBorder }}>
                                                  <Text style={{ color: textColor, fontWeight: 'bold', fontSize: 13 }}>
                                                      {displayText}
                                                  </Text>
                                              </View>
                                          );
                                      })()}
                                 </View>
                             </View>

                            {/* Stats Grid */}
                            <Text style={styles.label}>{t("LOCAL RECORD CACHE")}</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 }}>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>👥</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{formatNumber(dbStats?.members ?? 0)}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>{t('Cached Members')}</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: dbStats?.members === remoteStats.members ? colors.brand.primary : colors.feedback.warning.fg, fontWeight: 'bold', marginTop: 4 }}>
                                            {dbStats?.members === remoteStats.members ? t('🟢 Node In Sync') : t('⚠️ Node has {n}', { n: remoteStats.members })}
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>🛒</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{formatNumber(dbStats?.posts ?? 0)}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>{t('Active Posts')}</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: dbStats?.posts === remoteStats.posts ? colors.brand.primary : colors.feedback.warning.fg, fontWeight: 'bold', marginTop: 4 }}>
                                            {dbStats?.posts === remoteStats.posts ? t('🟢 Node In Sync') : t('⚠️ Node has {n}', { n: remoteStats.posts })}
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>💸</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{formatNumber(dbStats?.transactions ?? 0)}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>{t('Your Ledger Deals')}</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: colors.brand.primary, fontWeight: 'bold', marginTop: 4 }}>
                                            {t('🟢 Node History ({n})', { n: remoteStats.transactions })}
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>💬</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }}>{formatNumber(dbStats?.messages ?? 0)}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }}>{t('Messages')}</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: colors.brand.primary, fontWeight: 'bold', marginTop: 4 }}>
                                            {t("🟢 Local First Offline")}
                                        </Text>
                                    )}
                                </View>
                            </View>

                            {/* Storage allocation */}
                            <Text style={styles.label}>{t("STORAGE ALLOCATION")}</Text>
                            <View style={{ backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 20 }}>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <Text style={{ fontSize: 13, color: colors.text.secondary, fontWeight: '600' }}>{t("Active DB File size:")}</Text>
                                    <Text style={{ fontSize: 13, color: colors.text.heading, fontWeight: 'bold' }}>{dbSize}</Text>
                                </View>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                                    <Text style={{ fontSize: 13, color: colors.text.secondary, fontWeight: '600' }}>{t("Active Connection Node:")}</Text>
                                    {/* An address, cut at 32 characters; the two placeholders before one is known are words, shown whole. */}
                                    <Text style={{ fontSize: 11, color: colors.text.secondary, fontFamily: 'monospace' }}>
                                        {!anchorUrl || anchorUrl === 'Detecting...' ? t('Detecting...')
                                            : anchorUrl === 'Local discovery (or offline)' ? t('Local discovery (or offline)')
                                            : `${anchorUrl.slice(0, 32)}${anchorUrl.length > 32 ? '...' : ''}`}
                                    </Text>
                                </View>
                            </View>

                            {/* Action Buttons */}
                            <Pressable
                                style={[styles.primaryBtn, { backgroundColor: colors.accent.fill, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }]}
                                onPress={() => loadDiagnostics()}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: 16 }}>🔄</Text>
                                <Text style={[styles.primaryBtnText, { color: colors.text.onAccent }]}>{t("Re-Run Structural Diagnostic Check")}</Text>
                            </Pressable>

                            {/* Re-Sync Database Button */}
                            <Pressable
                                style={[styles.primaryBtn, { backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }, resyncing && { opacity: 0.6 }]}
                                onPress={() => handleForceResync(anchorUrl)}
                                disabled={resyncing}
                                accessibilityRole="button"
                                accessibilityState={{ busy: resyncing, disabled: resyncing }}
                                accessibilityHint={t("Deletes the local database and redownloads everything from scratch")}
                            >
                                {resyncing ? (
                                    <>
                                        <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                                        <Text style={[styles.primaryBtnText, { color: colors.feedback.danger.fg }]}>{t("Clearing & re-syncing…")}</Text>
                                    </>
                                ) : (
                                    <>
                                        <Text style={{ fontSize: 16 }}>⚡</Text>
                                        <Text style={[styles.primaryBtnText, { color: colors.feedback.danger.fg }]}>{t("Force Clear & Re-Sync Database")}</Text>
                                    </>
                                )}
                            </Pressable>
                        </>
                    )}

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t("← Back")}</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'seed' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t("🔑 Recovery Phrase")}</Text>
                    {viewWordsOpens(identity) === 'add-words' ? (
                        <>
                            {/* No copy on this phone: the form, open, under the one plain line (its intro,
                                NO_WORDS_VIEW_LINE). Checked on the phone against this account, sent nowhere. */}
                            <AddWordsForm
                                colors={colors}
                                onCancel={() => setMode('menu')}
                                onAdded={(updated) => {
                                    setIdentity(updated);
                                    setWordsJustAdded(true);
                                }}
                            />
                            {/* For a member without them on paper: the way back is a connected sign-in. */}
                            <View style={{ marginTop: 16 }}>
                                <NoWordsNotice
                                    kind="way-back"
                                    colors={colors}
                                    action={{ label: settingsLineWords(NO_WORDS_CONNECT), onPress: () => setMode('protection') }}
                                />
                            </View>
                        </>
                    ) : (
                        <>
                            {wordsJustAdded && (
                                <View style={{ backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 16 }}>
                                    <Text style={{ color: colors.feedback.success.fg, fontSize: 13, lineHeight: 18, fontWeight: '600' }} accessibilityLiveRegion="polite">
                                        ✅ {settingsLineWords(ADD_WORDS_COPY.done)}
                                    </Text>
                                </View>
                            )}
                            {!seedVisible ? (
                                <>
                                    <Text style={styles.infoText}>
                                        {t("Your 12-word recovery phrase allows you to restore your identity on any device. Anyone with these words can control your account.")}
                                    </Text>
                                    <Text style={styles.label}>{t("TYPE '{word}' TO VIEW SEED", { word: 'CONFIRM' })}</Text>
                                    <TextInput
                                        style={[styles.input, { textAlign: 'center', fontWeight: 'bold' }]}
                                        value={seedConfirm}
                                        onChangeText={setSeedConfirm}
                                        placeholder="CONFIRM"
                                        placeholderTextColor={colors.text.secondary}
                                        autoCapitalize="characters"
                                        autoCorrect={false}
                                        accessibilityLabel={t('Type {word} to view recovery phrase', { word: 'CONFIRM' })}
                                    />
                                    <Pressable
                                        style={[styles.primaryBtn, seedConfirm !== 'CONFIRM' && { opacity: 0.5 }]}
                                        onPress={handleShowSeedWords}
                                        disabled={seedConfirm !== 'CONFIRM'}
                                        accessibilityRole="button"
                                    >
                                        <Text style={styles.primaryBtnText}>{t("Show Recovery Phrase")}</Text>
                                    </Pressable>
                                </>
                            ) : (
                                <>
                                    <Text style={[styles.infoText, { color: colors.feedback.danger.fg, fontWeight: 'bold' }]}>
                                        {t("Never share this phrase with anyone. Write it down on paper and keep it secure.")}
                                    </Text>
                                    <View style={styles.seedGrid}>
                                        {/*
                                          One accessibility node per cell. As two separate
                                          Texts a screen reader stops on "1." and then on
                                          "apple", so hearing twelve words in order takes
                                          twenty-four stops and leaves the listener to pair
                                          the numbers with the words themselves.
                                        */}
                                        <NoScreenCapture>
                                        {seedWords?.map((word, i) => (
                                            <View
                                                key={i}
                                                style={styles.seedWord}
                                                accessible={true}
                                                accessibilityLabel={t('Word {n}: {word}', { n: i + 1, word })}
                                            >
                                                <Text style={styles.seedWordNum}>{i + 1}.</Text>
                                                <Text style={styles.seedWordText}>{word}</Text>
                                            </View>
                                        ))}
                                        </NoScreenCapture>
                                    </View>
                                    <Pressable
                                        style={[styles.primaryBtn, { backgroundColor: colors.brand.fill, marginTop: 16 }]}
                                        onPress={handleCopySeed}
                                        accessibilityRole="button"
                                    >
                                        <Text style={styles.primaryBtnText}>
                                            {seedCopied ? t('✅ Copied!') : t('📋 Copy Words')}
                                        </Text>
                                    </Pressable>
                                    <View style={{ marginTop: 12 }}>
                                        <RecoveryKitButtons words={seedWords} colors={colors} />
                                    </View>
                                    <CopyClearsNote style={[styles.infoText, { marginTop: 10, marginBottom: 0 }]} />
                                    <NoScreenLockNote style={[styles.infoText, { marginTop: 8, marginBottom: 0 }]} />
                                </>
                            )}
                        </>
                    )}
                    <Pressable style={[styles.backBtn, { marginTop: 24 }]} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>{t("← Back")}</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'wipe' && (
                <View style={styles.card}>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.feedback.danger.fg, marginBottom: 8 }}>
                        {t('Account Deletion & Sign Out')}
                    </Text>

                    {wipeType === 'options' && (
                        <View style={{ gap: 14, marginTop: 4 }}>
                            <Text style={styles.infoText}>
                                {t("Choose whether to sign out of this device or permanently purge your account from the community node.")}
                            </Text>

                            {/* Option 1: Device Sign Out */}
                            <View style={{ backgroundColor: theme === 'dark' ? colors.surface.subtle : '#f8fafc', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, gap: 8 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Text style={{ fontSize: 18 }}>🚪</Text>
                                    <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.text.heading }}>
                                        {t("Remove from This Device Only")}
                                    </Text>
                                </View>
                                <Text style={{ fontSize: 13, color: colors.text.secondary, lineHeight: 18 }}>
                                    {hasMnemonic(identity)
                                        ? t('Clears your private key and local database from this phone. Your account and listings remain active on the community node and can be restored anytime with your 12-word recovery phrase.')
                                        : t('{sentence} {next}', { sentence: t('Clears your private key and local database from this phone. Your account and listings remain active on the community node.'), next: settingsLineWords(noWordsBeforeWipe()) })}
                                </Text>
                                <Pressable
                                    style={{
                                        backgroundColor: colors.surface.card,
                                        borderWidth: 1,
                                        borderColor: colors.border.default,
                                        minHeight: 44,
                                        paddingVertical: 12,
                                        paddingHorizontal: 14,
                                        borderRadius: 10,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        marginTop: 4,
                                    }}
                                    onPress={() => {
                                        setWipeConfirm('');
                                        setWipeType('local');
                                    }}
                                    accessibilityRole="button"
                                    // The visible words, one key for both, the arrow outside it (WCAG 2.5.3).
                                    accessibilityLabel={t("Sign Out (Device Only)")}
                                    accessibilityHint={t("Opens the confirmation to sign out of this device")}
                                >
                                    <Text style={{ color: colors.text.heading, fontSize: 13, fontWeight: 'bold' }}>
                                        {t("Sign Out (Device Only)")} <Text>→</Text>
                                    </Text>
                                </Pressable>
                            </View>

                            {/* Option 2: Permanent Node Purge */}
                            <View style={{ backgroundColor: colors.feedback.danger.bg, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.feedback.danger.border, gap: 8 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Text style={{ fontSize: 18 }}>🗑️</Text>
                                    <Text style={{ fontSize: 15, fontWeight: 'bold', color: colors.feedback.danger.fg }}>
                                        {t("Permanently Delete Account & Node Data")}
                                    </Text>
                                </View>
                                <Text style={{ fontSize: 13, color: colors.feedback.danger.fg, lineHeight: 18 }}>
                                    {settingsLineWords(DELETE_CARD_LINE)} <Text style={{ fontWeight: 'bold' }}>{hasMnemonic(identity) ? t('Cannot be undone, even with your 12-word phrase.') : t('Cannot be undone.')}</Text>
                                </Text>
                                <Pressable
                                    style={{
                                        backgroundColor: colors.feedback.danger.solid,
                                        minHeight: 44,
                                        paddingVertical: 12,
                                        paddingHorizontal: 14,
                                        borderRadius: 10,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        marginTop: 4,
                                    }}
                                    onPress={() => {
                                        setPurgeConfirm('');
                                        setWipeType('purge');
                                        askDeletePlan();
                                    }}
                                    accessibilityRole="button"
                                    // The visible words, one key for both, the arrow outside it (WCAG 2.5.3); the rest in the hint.
                                    accessibilityLabel={t("Permanently Delete Account")}
                                    accessibilityHint={t("Opens the confirmation to delete your account and node data")}
                                >
                                    <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: 'bold' }}>
                                        {t("Permanently Delete Account")} <Text>→</Text>
                                    </Text>
                                </Pressable>
                            </View>

                            <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button" accessibilityLabel={t("Back to Settings")}>
                                <Text style={styles.backBtnText}><Text>←</Text> {t("Back to Settings")}</Text>
                            </Pressable>
                        </View>
                    )}

                    {wipeType === 'local' && (
                        <View style={{ gap: 12, marginTop: 4 }}>
                            <Text style={styles.infoText}>
                                {hasMnemonic(identity)
                                    ? t('This will remove your private key and local database from this phone. You will need your 12-word recovery phrase to restore access later.')
                                    : t('This will remove your private key and local database from this phone.')}
                            </Text>

                            {hasMnemonic(identity) ? (
                                <View style={{ backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border, borderRadius: 12, padding: 12, gap: 8 }}>
                                    <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, lineHeight: 18 }}>
                                        {t("Have you backed up your 12 words? They are your primary way back into your account.")}
                                    </Text>
                                    <Pressable
                                        style={{ backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.feedback.warning.border, padding: 10, borderRadius: 8, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                                        onPress={() => { setSeedConfirm(''); setSeedVisible(false); setMode('seed'); }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t("View Recovery Words First")}
                                    >
                                        <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700' }}><Text>🔑</Text> {t("View Recovery Words First")}</Text>
                                    </Pressable>
                                </View>
                            ) : (
                                <NoWordsNotice
                                    kind="before-wipe"
                                    colors={colors}
                                    action={{ label: settingsLineWords(NO_WORDS_CHECK_FIRST), onPress: () => setMode('protection') }}
                                />
                            )}

                            <Text style={styles.label}>{t("TYPE '{word}' TO CONFIRM DEVICE SIGN OUT", { word: 'WIPE' })}</Text>
                            <TextInput
                                style={[styles.input, { textAlign: 'center', fontWeight: 'bold', color: colors.text.heading, borderColor: colors.border.default }]}
                                value={wipeConfirm}
                                onChangeText={setWipeConfirm}
                                placeholder="WIPE"
                                placeholderTextColor={colors.text.secondary}
                                autoCapitalize="characters"
                                autoCorrect={false}
                                accessibilityLabel={t('Type {word} to confirm sign out', { word: 'WIPE' })}
                            />

                            <Pressable 
                                style={[
                                    styles.dangerBtn, 
                                    { 
                                        backgroundColor: colors.brand.fill,
                                        borderColor: colors.border.default,
                                        minHeight: 48,
                                        justifyContent: 'center',
                                    }, 
                                    (advancedLoading || wipeConfirm !== 'WIPE') && { opacity: 0.5 }
                                ]} 
                                onPress={handleLocalWipe} 
                                disabled={advancedLoading || wipeConfirm !== 'WIPE'} 
                                accessibilityRole="button"
                                // The visible words, one key for both, the emoji outside it (WCAG 2.5.3); the rest in the hint.
                                accessibilityLabel={advancedLoading ? t('Signing Out...') : t('Confirm Sign Out')}
                                accessibilityHint={t('Signs you out of this device')}
                                accessibilityState={{ disabled: advancedLoading || wipeConfirm !== 'WIPE' }}
                            >
                                <Text style={[styles.dangerBtnText, { color: colors.text.onBrand }]}>
                                    {advancedLoading ? t('Signing Out...') : <><Text>🚪</Text> {t('Confirm Sign Out')}</>}
                                </Text>
                            </Pressable>

                            <Pressable style={styles.backBtn} onPress={() => setWipeType('options')} accessibilityRole="button" accessibilityLabel={t("Choose Another Option")}>
                                <Text style={styles.backBtnText}><Text>←</Text> {t("Choose Another Option")}</Text>
                            </Pressable>
                        </View>
                    )}

                    {wipeType === 'purge' && (() => {
                        const purgeNames = [nodeCallsign, identity?.callsign]
                            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
                            .map(c => c.trim().toLowerCase());
                        const typedPurge = purgeConfirm.trim().toLowerCase();
                        const isPurgeInputValid = purgeConfirm === 'DELETE' || purgeNames.includes(typedPurge);
                        // The button waits for the other communities' answers: the confirmation says what stays.
                        const purgeBlocked = advancedLoading || !isPurgeInputValid || !deletePlan;
                        const words = hasMnemonic(identity);

                        return (
                            <View style={{ gap: 12, marginTop: 4 }}>
                                <View style={{ backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, borderRadius: 12, padding: 12 }}>
                                    <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 18, fontWeight: 'bold' }}>
                                        {t("⚠️ Warning: Irreversible Node Purge")}
                                    </Text>
                                    <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 18, marginTop: 4 }}>
                                        {deletePlan
                                            ? t('This will permanently delete your profile, listings, and messages at {here}.', { here: deletePlan.hereName })
                                            : t('This will permanently delete your profile, listings, and messages at this community.')}
                                    </Text>
                                </View>

                                {/* What stays on this phone: the key for the other communities, or nothing at the last one. */}
                                {!deletePlan && !deletePlanError && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityLiveRegion="polite">
                                        <ActivityIndicator size="small" color={colors.text.secondary} />
                                        <Text style={[styles.infoText, { flex: 1 }]}>{settingsLineWords(DELETE_CHECKING_LINE)}</Text>
                                    </View>
                                )}
                                {deletePlanError && (
                                    <View style={{ gap: 8 }}>
                                        <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 18 }} accessibilityLiveRegion="polite">
                                            {deletePlanFailedWords(deletePlanError)}
                                        </Text>
                                        <Pressable style={styles.backBtn} onPress={askDeletePlan} accessibilityRole="button" accessibilityLabel={t("Check your other communities again")}>
                                            <Text style={styles.backBtnText}>{t("Try Again")}</Text>
                                        </Pressable>
                                    </View>
                                )}
                                {deletePlan?.kind === 'this-one' && (
                                    <View style={{ backgroundColor: colors.feedback.info.bg, borderWidth: 1, borderColor: colors.feedback.info.border, borderRadius: 12, padding: 12, gap: 6 }}>
                                        <Text style={{ color: colors.text.body, fontSize: 13, lineHeight: 18 }}>
                                            🔑 {keepsKeyWords(deletePlan, words)}
                                        </Text>
                                        <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18 }}>{settingsLineWords(SIGN_OUT_INSTEAD_LINE)}</Text>
                                    </View>
                                )}
                                {deletePlan?.kind === 'last' && (words ? (
                                    <View style={{ backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border, borderRadius: 12, padding: 12, gap: 8 }}>
                                        <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, lineHeight: 18 }}>
                                            {lastCommunityWords(deletePlan, true, hasVault())}
                                        </Text>
                                        <Pressable
                                            style={{ backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.feedback.warning.border, padding: 10, borderRadius: 8, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                                            onPress={() => { setSeedConfirm(''); setSeedVisible(false); setMode('seed'); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t("View Recovery Words First")}
                                        >
                                            <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700' }}><Text>🔑</Text> {t("View Recovery Words First")}</Text>
                                        </Pressable>
                                    </View>
                                ) : (
                                    <View style={{ gap: 8 }}>
                                        <Text style={styles.infoText}>{lastCommunityWords(deletePlan, false, hasVault())}</Text>
                                        <NoWordsNotice
                                            kind="before-wipe"
                                            colors={colors}
                                            action={{ label: settingsLineWords(NO_WORDS_CHECK_FIRST), onPress: () => setMode('protection') }}
                                        />
                                    </View>
                                ))}

                                <Text style={styles.label}>{t("TYPE '{word}' OR '{name}' TO CONFIRM", { word: 'DELETE', name: nodeCallsign || identity?.callsign || 'CALLSIGN' })}</Text>
                                <TextInput
                                    style={[styles.input, { textAlign: 'center', fontWeight: 'bold', color: colors.feedback.danger.fg, borderColor: colors.feedback.danger.border }]}
                                    value={purgeConfirm}
                                    onChangeText={setPurgeConfirm}
                                    placeholder="DELETE"
                                    placeholderTextColor={colors.text.secondary}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    accessibilityLabel={t('Type {word} or your callsign to confirm permanent node purge', { word: 'DELETE' })}
                                />

                                <Pressable 
                                    style={[
                                        styles.dangerBtn, 
                                        { minHeight: 48, justifyContent: 'center' },
                                        purgeBlocked && { opacity: 0.5 }
                                    ]}
                                    onPress={handleNodePurge}
                                    disabled={purgeBlocked}
                                    accessibilityRole="button"
                                    // The visible words, one key for both, the emoji outside it (WCAG 2.5.3); "from node" is the hint's.
                                    accessibilityLabel={advancedLoading ? t('Purging Account...') : t('Permanently Purge Account')}
                                    accessibilityHint={deletePlan?.kind === 'this-one'
                                        ? t('Irreversibly deletes account data at this community; this phone keeps your key for your other communities')
                                        : t('Irreversibly deletes account data from the community node and wipes this phone')}
                                    accessibilityState={{ disabled: purgeBlocked }}
                                >
                                    <Text style={styles.dangerBtnText}>
                                        {advancedLoading ? t('Purging Account...') : <><Text>🔥</Text> {t('Permanently Purge Account')}</>}
                                    </Text>
                                </Pressable>

                                <Pressable style={styles.backBtn} onPress={() => setWipeType('options')} accessibilityRole="button" accessibilityLabel={t("Choose Another Option")}>
                                    <Text style={styles.backBtnText}><Text>←</Text> {t("Choose Another Option")}</Text>
                                </Pressable>
                            </View>
                        );
                    })()}
                </View>
            )}

            {/* Its light look is its own (slate), so only the dark theme's colours go in. */}
            <AvatarPickerSheet
                visible={showAvatarPicker}
                colors={theme === 'dark' ? colors : undefined}
                onClose={() => setShowAvatarPicker(false)}
                onSelectImage={(uri) => {
                    const cleaned = (uri && uri !== 'null' && uri !== 'undefined' && uri.trim() !== '') ? uri : null;
                    editedRef.current.avatar = true;
                    setAvatar(cleaned);
                    setAvatarPickedThisSession(cleaned);
                }}
            />

            {/* Step-by-Step Database Resync Progress Modal */}
            <Modal visible={resyncModalVisible} transparent animationType="fade">
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
                    <View style={{ width: '100%', maxWidth: 340, backgroundColor: theme === 'dark' ? colors.surface.card : '#ffffff', borderRadius: 20, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: colors.border.default, elevation: 10 }}>
                        <ActivityIndicator size="large" color={colors.brand.primary} style={{ marginBottom: 16 }} />
                        
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, textAlign: 'center', marginBottom: 8 }}>
                            {t("Rebuilding Database")}
                        </Text>
                        
                        <Text style={{ fontSize: 13, color: colors.brand.primary, fontWeight: 'bold', textAlign: 'center', marginBottom: 16 }}>
                            {t('Step {step} of {total} ({percent}%)', { step: resyncProgressStep, total: resyncTotalSteps, percent: Math.round((resyncProgressStep / resyncTotalSteps) * 100) })}
                        </Text>

                        {/* Progress Bar Container */}
                        <View style={{ width: '100%', height: 8, backgroundColor: colors.surface.app, borderRadius: 4, overflow: 'hidden', marginBottom: 16, borderWidth: 1, borderColor: colors.border.default }}>
                            <View style={{ width: `${Math.round((resyncProgressStep / resyncTotalSteps) * 100)}%`, height: '100%', backgroundColor: colors.brand.fill }} />
                        </View>

                        <Text style={{ fontSize: 12, color: colors.text.muted, textAlign: 'center', lineHeight: 18 }}>
                            {settingsLineWords(resyncProgressStage)}
                        </Text>

                        <Text style={{ fontSize: 11, color: colors.text.secondary, textAlign: 'center', marginTop: 12, fontStyle: 'italic' }}>
                            {t("Restoring members, posts, deals, and ratings. Please do not close the app.")}
                        </Text>
                    </View>
                </View>
            </Modal>

            {/* Blocked Users Management Modal */}
            <Modal visible={showBlockedModal} transparent animationType="slide" onRequestClose={() => setShowBlockedModal(false)}>
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
                    <View style={{ backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '80%', borderWidth: 1, borderColor: colors.border.default }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                            <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }}>{t("🚫 Blocked Users")}</Text>
                            <Pressable accessibilityRole="button" accessibilityLabel={t("Close blocked users modal")} onPress={() => setShowBlockedModal(false)} style={{ padding: 4 }}>
                                <Text style={{ fontSize: 18, color: colors.text.muted, fontWeight: 'bold' }}>✕</Text>
                            </Pressable>
                        </View>

                        {loadingBlockedList ? (
                            <ActivityIndicator size="large" color={colors.brand.primary} style={{ marginVertical: 32 }} />
                        ) : blockedUsersList.length === 0 ? (
                            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                                <Text style={{ fontSize: 14, color: colors.text.secondary }}>{t("You currently have no blocked users.")}</Text>
                            </View>
                        ) : (
                            <>
                                <ScrollView style={{ maxHeight: 300, marginBottom: 16 }}>
                                    {blockedUsersList.map(item => (
                                        <View key={item.pubkey} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                                <View style={{ flex: 1, marginRight: 12 }}>
                                                    <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.body }} numberOfLines={1}>
                                                        {item.callsign}
                                                    </Text>
                                                    <Text style={{ fontSize: 11, color: colors.text.muted }} numberOfLines={1}>
                                                        {item.pubkey.slice(0, 16)}...
                                                    </Text>
                                                </View>
                                                <Pressable
                                                    accessibilityRole="button"
                                                    style={{ backgroundColor: colors.feedback.danger.bg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.danger.border }}
                                                    onPress={async () => {
                                                        await unblockUser(item.pubkey);
                                                        setBlockedUsersList(prev => prev.filter(u => u.pubkey !== item.pubkey));
                                                    }}
                                                >
                                                    <Text style={{ color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 12 }}>{t("Unblock")}</Text>
                                                </Pressable>
                                            </View>
                                            {identity?.publicKey && (
                                                <BlockedFriendRemove myKey={identity.publicKey} pubkey={item.pubkey} callsign={item.callsign || item.pubkey.slice(0, 8)} />
                                            )}
                                        </View>
                                    ))}
                                </ScrollView>

                                <Pressable
                                    accessibilityRole="button"
                                    style={{ backgroundColor: colors.surface.app, paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.feedback.danger.border, marginBottom: 8 }}
                                    onPress={async () => {
                                        Alert.alert(t('Unblock All'), t('Are you sure you want to unblock all users?'), [
                                            { text: t('Cancel'), style: 'cancel' },
                                            {
                                                text: t('Unblock All'),
                                                style: 'destructive',
                                                onPress: async () => {
                                                    await clearBlocklist();
                                                    setBlockedUsersList([]);
                                                }
                                            }
                                        ]);
                                    }}
                                >
                                    <Text style={{ color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 14 }}>{t("Unblock All")}</Text>
                                </Pressable>
                            </>
                        )}
                    </View>
                </View>
            </Modal>

            {/* Community Pricing Guide Modal */}
            <PricingGuideModal
                isOpen={showPricingGuide}
                onClose={() => setShowPricingGuide(false)}
            />

            <CommunityShapeSheet
                features={activeFeatures}
                visible={shapeSheetOpen}
                onClose={() => setShapeSheetOpen(false)}
            />
        </KeyboardAwareScrollView>
    );
}

