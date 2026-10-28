/**
 * SettingsPage — Identity management, recovery phrase,
 * database diagnostics, notification preferences, and subsystem controls.
 */

import { AREA_STEP_WORDS, LANGS, describeArea, formatNumber, isLang, knockSwitchShown, t, tn } from '@beanpool/core';
import { AreaStep, areaFailureWords } from '../components/AreaStep';
import { readMyArea, recallAreaPlace, rememberAreaPlace, senderForMe, useNearbyLimits, writeArea, type MemberArea } from '../lib/member-area';
import { useState, useEffect, useRef } from 'react';
import { type BeanPoolIdentity, wipeIdentity, getMnemonic, hasMnemonic, seedViewedKey } from '../lib/identity';
import { clearAccountStorage } from '../lib/device-prefs';
import { clearHomeCache } from '../lib/home-cache';
import {
    WEB_DELETE_CARD_LINE, WEB_DELETE_CHECKING_LINE, hostOf, leaveThisCommunity, planWebDelete, purgeHere, webDeleteFailedLine,
    webDeletedButLine, webKeepsKeyLine, webLastCommunityLine, WEB_VAULT_COPY_LINE, type WebDeletePlan,
} from '../lib/delete-here';
import {
    getMemberProfile, updateMemberProfile, redeemInvite, getMemberPreferences, setHolidayModeApi, type MemberProfile,
    getFriends, removeFriendApi,
    getNodeApiUrl, getStoredNodeApiUrl, setNodeApiUrl, testNodeConnection, getNotificationPreferences,
    updateNotificationPreferences, getNodeStats, getSignInRecovery, request,
} from '../lib/api';
import { signInNames } from '../lib/join-recovery';
import { useCommunityInfo } from '../lib/features';
import { globalCommunityLink, isAppsGlobal, phoneLaterLines, usePhoneBrowser } from '../lib/global-entry';
import { isInstalled, useDeferredInstallPrompt, clearDeferredPrompt, DesktopInstallSteps } from '../components/InstallPrompt';
import { StoreBadges, ApkDownloadLink } from '../components/UsePhoneAppCard';
import { webAppAddress, webAppHost } from '../lib/former-address';
import { RecoveryKitButton } from '../components/RecoveryKitButton';
import { noWordsHere, SignInRecoveryLine, waysBackWithoutWords } from '../components/SignInRecoveryLine';
import { WaysBackSection } from '../components/WaysBackSection';
import { MemberAvatar } from '../components/MemberAvatar';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, normaliseReminderOffsets, parseReminderOffsets,
} from '../lib/event-extras';
import { ProfilePage } from './ProfilePage';
import { type ThemePreference, THEME_PREFERENCE_OPTIONS } from '../lib/useTheme';
import { LANGUAGE_NAMES, WORDS_FEEDBACK_URL } from '../lib/language';
import { useLanguage } from '../lib/useLanguage';
import { LanguageLoadNote } from '../components/LanguageSwitch';
import { loadPatternPreference, setPatternPreference } from '../lib/usePatternBackground';
import { RecoveryAlertBanner } from '../components/RecoveryAlertBanner';
import { NodeAdminLink } from '../components/NodeAdminLink';
import { OwnerWordsCheck } from '../components/OwnerWordsCheck';
import { OwnerUnlockCard } from '../components/OwnerUnlockCard';
import { NewAccountCard } from '../components/NewAccountCard';
import { OneWayBackCard } from '../components/OneWayBack';
import { keyLineWords } from '../components/key-lines';
import { saidWords, type Said } from '../components/WebJoin';
import type { LinkResult } from '../lib/link-signin';
import { ModerationPauseCard } from '../components/ModerationPauseCard';
import { KnownConsentCard } from '../components/KnownConsentCard';
import { ArchetypeQuizModal } from '../components/ArchetypeQuizModal';
import { SuggestChangeForm } from '../components/SuggestChangeForm';
import { parseArchetype, ARCHETYPES, FEEDBACK_LIVE, BEANPOOL_WEBSITE_URL, beanPoolSettingsEntries, type QuizResult } from '@beanpool/core';
import { MemberGuide } from '../components/MemberGuide';
import { BoldWords } from '../components/BoldWords';
import { Sentence } from '../components/Sentence';
import { loadBlocklist, unblockUser, clearBlocklist, onBlocklistUpdated, getBlocklistFullNote } from '../lib/blocklist';
import { clearSyncCursor } from '../lib/sync';
import { WEB_COPY_CLEARS_LINE, anotherCopyMade, copyWordsForAMinute, leftTheWordsScreen } from '../lib/words-clipboard';

const PURGE_CONFIRM_WORD = 'DELETE';
const BEANPOOL_DOMAIN = 'beanpool.org';

interface Props {
    identity: BeanPoolIdentity;
    onIdentityUpdated: (identity: BeanPoolIdentity) => void;
    onBack: () => void;
    themePreference: ThemePreference;
    onThemePreferenceChange: (preference: ThemePreference) => void;
    initialMode?: 'menu' | 'profile' | 'advanced' | 'seed' | 'diagnostics' | 'notifications' | 'blocked-users' | 'suggest' | 'guide' | 'area';
    /** With initialMode 'guide': the guide page to open at (Home's Tips card, Read more); absent: its front page. */
    initialGuidePage?: string | null;
    onReRunSetup?: () => void;
    /** Version reported by the connected node, when its health check has answered. */
    nodeVersion?: string;
    /** Open the owners' "Check your 12 words" card (from the home prompt's "Check now"). */
    openOwnerWordsCheck?: boolean;
    /** A sign-in that came back to be added to this account (App.tsx, lib/link-signin.ts): what came of it. */
    linkResult?: LinkResult | null;
}

/** One reminder offset as the tick row says it: the phone's words (components/settings/settings-lines.ts reminderBeforeWords). */
function reminderBeforeWords(minutes: number): string {
    switch (minutes) {
        case 10080: return t('1 week before');
        case 1440: return t('1 day before');
        case 120: return t('2 hours before');
        case 60: return t('1 hour before');
        case 30: return t('30 minutes before');
        // lib/event-extras writes any other offset as "{n} minutes", one form for both.
        default: return tn(minutes, '{n} minutes before', '{n} minutes before');
    }
}

function ToggleSwitch({
    checked,
    onChange,
    disabled,
    label,
    activeBgClass = 'bg-bp-commit-fill border-bp-commit-fill',
    inactiveBgClass = 'bg-nature-200 dark:bg-nature-700 border-nature-300 dark:border-nature-600',
}: {
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
    label?: string;
    activeBgClass?: string;
    inactiveBgClass?: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={onChange}
            disabled={disabled}
            style={{ width: '48px', height: '26px' }}
            className={`rounded-full relative cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 transition-colors duration-300 border shrink-0 disabled:opacity-50 ${
                checked ? activeBgClass : inactiveBgClass
            }`}
        >
            <span
                style={{
                    width: '20px',
                    height: '20px',
                    top: '2px',
                    transform: checked ? 'translateX(22px)' : 'translateX(2px)',
                }}
                className="block rounded-full bg-white shadow-md transition-transform duration-300 absolute"
            />
        </button>
    );
}

/**
 * Settings → Language: the same choice as the first screen's switch, kept in this browser only. Every language but
 * English is a machine draft until native speakers have read it (design M4): one line says so, with where to tell us.
 */
function LanguageRow() {
    const [lang, choose] = useLanguage();
    const value = isLang(lang) ? lang : 'en';
    return (
        <div data-testid="settings-language" className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800">
            <label className="flex items-center gap-3 cursor-pointer">
                <span className="text-xl" aria-hidden="true">🌐</span>
                <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-bold text-nature-900 dark:text-white">{t('Language')}</div>
                    <div className="text-xs text-nature-500 dark:text-nature-400">{t('The words of the app, on this device')}</div>
                </div>
            </label>
            <select
                aria-label={t('Language')}
                value={value}
                onChange={(e) => { if (isLang(e.target.value)) void choose(e.target.value); }}
                className="mt-3 w-full min-h-[48px] px-3 rounded-xl border border-border-input bg-nature-50 dark:bg-nature-800 text-[15px] text-nature-900 dark:text-white cursor-pointer"
            >
                {LANGS.map((l) => <option key={l} value={l} lang={l}>{LANGUAGE_NAMES[l]}</option>)}
            </select>
            <LanguageLoadNote className="mt-2 empty:mt-0" />
            {value !== 'en' && (
                <p data-testid="settings-language-draft" className="mt-2 flex flex-wrap gap-x-1 text-xs leading-relaxed text-nature-600 dark:text-nature-300">
                    <span>{t('These translations are new.')}</span>
                    <a href={WORDS_FEEDBACK_URL} target="_blank" rel="noopener noreferrer" className="underline font-semibold text-nature-800 dark:text-nature-100">
                        {t('Tell us what reads wrong')}
                    </a>
                </p>
            )}
        </div>
    );
}


export function SettingsPage({ identity, onIdentityUpdated, onBack, themePreference, onThemePreferenceChange, initialMode, initialGuidePage, onReRunSetup, nodeVersion, openOwnerWordsCheck, linkResult }: Props) {
    const [mode, setMode] = useState<'menu' | 'profile' | 'advanced' | 'seed' | 'diagnostics' | 'notifications' | 'blocked-users' | 'suggest' | 'guide' | 'area'>(initialMode || 'menu');
    // Your area (design DESIGN-global-sync-by-area §3.5): only on a community that gives each member the listings near
    // their area. The line is the node's value (GET /api/community/me), with the town typed in this browser.
    const areaLimits = useNearbyLimits();
    const [myArea, setMyArea] = useState<MemberArea | null | undefined>(undefined);
    const [areaLoaded, setAreaLoaded] = useState(false);
    // The node's sentence when it says this key isn't a member (a private preview, a closed account), in place of "Not set".
    const [areaRefusal, setAreaRefusal] = useState<string | null>(null);
    const [areaError, setAreaError] = useState<string | null>(null);
    const [areaClearing, setAreaClearing] = useState(false);
    const loadMyArea = () => {
        setAreaLoaded(false);
        readMyArea().then((a) => {
            if (a && 'sentence' in a) { setAreaRefusal(a.sentence); setMyArea(undefined); }
            else { setAreaRefusal(null); setMyArea(a); }
            setAreaLoaded(true);
        });
    };
    useEffect(() => { if (areaLimits) loadMyArea(); }, [areaLimits]);
    const areaLine = !areaLoaded ? t('Checking…') : areaRefusal ?? (myArea === undefined ? t("Couldn't check right now") : describeArea(myArea, recallAreaPlace()));
    const clearMyArea = async () => {
        setAreaClearing(true);
        setAreaError(null);
        const result = await writeArea(senderForMe, null);
        setAreaClearing(false);
        if (!result.ok) { setAreaError(areaFailureWords(result.error)); return; }
        rememberAreaPlace(null);
        setMyArea(null);
    };

    useEffect(() => {
        if (initialMode) {
            setMode(initialMode);
        }
    }, [initialMode]);

    // App Preferences & Toggles
    const [patternEnabled, setPatternEnabled] = useState(loadPatternPreference);
    const [useModernMarkers, setUseModernMarkers] = useState(() => {
        return localStorage.getItem('beanpool_modern_markers') !== 'false';
    });

    const handleToggleModernMarkers = () => {
        const next = !useModernMarkers;
        setUseModernMarkers(next);
        localStorage.setItem('beanpool_modern_markers', String(next));
    };

    // Track whether the member has ever viewed their 12 words in Settings.
    // This is deliberately stored in localStorage, not on the server — the server
    // cannot see a PWA member's phrase and should not know whether they've saved it.
    const [seedViewed, setSeedViewed] = useState(() => {
        return localStorage.getItem(seedViewedKey(identity.publicKey)) === 'true';
    });

    // Whether a sign-in also brings this account back (G11-c): the node's list, asked once. Undefined while asking,
    // null when it could not be asked; neither is drawn as "connected" or "not connected".
    const [signInRecovery, setSignInRecovery] = useState<string[] | null | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        getSignInRecovery().then((r) => { if (!cancelled) setSignInRecovery(r); });
        return () => { cancelled = true; };
    }, [identity.publicKey]);
    const signInRecoveryNames = signInRecovery ? signInNames(signInRecovery) : null;
    // Whether this browser holds the 12 words. One restored from a sign-in copy without them (web-restore.ts) does not:
    // nothing here tells it to save, view or rely on words it hasn't got, and each place says what brings it back.
    const hasWords = hasMnemonic(identity);
    // The same account on a phone (DESIGN-global-entry-fable.md §D), in the sign-in card; and on a local community, the
    // global community its node names (§B.3). Nothing of either before the node's info arrives, or when it names none.
    const communityInfo = useCommunityInfo();
    const pageHost = webAppHost();
    const phoneLater = phoneLaterLines({
        where: 'settings', appsGlobal: isAppsGlobal(communityInfo, pageHost), host: webAppAddress(), hasWords, signIns: signInRecoveryNames,
    });
    const globalCommunity = globalCommunityLink(communityInfo, pageHost);

    // Holiday mode
    const [holidayMode, setHolidayMode] = useState(false);
    const [holidayLoading, setHolidayLoading] = useState(false);

    // "Show me as a connection in common" (server SHOW_AS_CONNECTION_PREF): on unless turned off, served to you alone.
    // null until the node says (an older node never does, and then the row isn't shown).
    const [showAsConnection, setShowAsConnection] = useState<boolean | null>(null);
    const [showAsConnectionError, setShowAsConnectionError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getMemberPreferences(identity.publicKey)
            .then(prefs => {
                if (cancelled) return;
                setHolidayMode(prefs.holiday_mode === 'true');
                if (typeof prefs.show_as_connection_in_common === 'string') setShowAsConnection(prefs.show_as_connection_in_common !== 'false');
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [identity.publicKey]);

    const handleToggleShowAsConnection = async () => {
        if (showAsConnection === null) return;
        const next = !showAsConnection;
        setShowAsConnection(next);
        setShowAsConnectionError(null);
        try {
            await updateNotificationPreferences(identity.publicKey, { show_as_connection_in_common: next });
        } catch (e: any) {
            setShowAsConnection(!next);
            setShowAsConnectionError(e?.message || t('Your community could not save that. Try again.'));
        }
    };

    const handleToggleHoliday = async () => {
        if (holidayLoading) return;
        const next = !holidayMode;
        setHolidayLoading(true);
        try {
            await setHolidayModeApi(next);
            setHolidayMode(next);
        } catch (e) {
            window.alert(e instanceof Error ? e.message : t('Could not update holiday mode.'));
        } finally {
            setHolidayLoading(false);
        }
    };

    // Notification Preferences
    const [notifLoading, setNotifLoading] = useState(false);
    const [notifChat, setNotifChat] = useState(true);
    const [notifMarketplace, setNotifMarketplace] = useState(true);
    const [notifEscrow, setNotifEscrow] = useState(true);
    const [notifKnocks, setNotifKnocks] = useState(false);
    // Whether "Requests to join" means anything to this member (core knockSwitchShown): their node role, as the node says
    // it. Not known yet (or no answer): the switch waits.
    const [nodeRole, setNodeRole] = useState<unknown>(undefined);
    useEffect(() => {
        let alive = true;
        request<{ role?: unknown }>('GET', '/api/node-admin/me')
            .then(r => { if (alive) setNodeRole(typeof r?.role === 'string' ? r.role : null); })
            .catch(() => { /* unknown: no switch */ });
        return () => { alive = false; };
    }, [identity.publicKey]);

    // How long before an event starts this member wants to be told. The day before until they say otherwise
    // (the shared contract), and an empty list means no reminders at all.
    const [eventReminders, setEventReminders] = useState<number[]>(DEFAULT_REMINDER_OFFSETS);

    const loadNotificationPreferences = async () => {
        setNotifLoading(true);
        try {
            const prefs = await getNotificationPreferences(identity.publicKey);
            if (prefs) {
                setNotifChat(prefs.notify_chat !== 'false' && prefs.notify_chat !== false);
                setNotifMarketplace(prefs.notify_marketplace !== 'false' && prefs.notify_marketplace !== false);
                setNotifEscrow(prefs.notify_escrow !== 'false' && prefs.notify_escrow !== false);
                setNotifKnocks(prefs.notify_knocks === 'true' || prefs.notify_knocks === true);
                setEventReminders(parseReminderOffsets(prefs[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS);
            }
        } catch (e) {
            console.warn('[NotifPrefs] Failed:', e);
        } finally {
            setNotifLoading(false);
        }
    };

    /**
     * Tick or untick one reminder. Saved on the spot, like the switches above it: there is no Save button
     * on this screen, and adding one only for this row would be the odd one out.
     */
    const handleToggleReminder = async (minutes: number) => {
        const next = normaliseReminderOffsets(
            eventReminders.includes(minutes) ? eventReminders.filter(m => m !== minutes) : [...eventReminders, minutes]
        );
        setEventReminders(next);
        try {
            await updateNotificationPreferences(identity.publicKey, { [REMINDER_PREF_KEY]: next });
        } catch (e) {
            console.warn('[NotifPrefs] Save failed:', e);
        }
    };

    /** Off: no reminders for any event, unless one of them is given its own. */
    const handleRemindersOff = async () => {
        setEventReminders([]);
        try {
            await updateNotificationPreferences(identity.publicKey, { [REMINDER_PREF_KEY]: [] });
        } catch (e) {
            console.warn('[NotifPrefs] Save failed:', e);
        }
    };

    const handleToggleNotif = async (key: 'chat' | 'marketplace' | 'escrow' | 'knocks') => {
        const nextChat = key === 'chat' ? !notifChat : notifChat;
        const nextMkt = key === 'marketplace' ? !notifMarketplace : notifMarketplace;
        const nextEscrow = key === 'escrow' ? !notifEscrow : notifEscrow;
        const nextKnocks = key === 'knocks' ? !notifKnocks : notifKnocks;

        if (key === 'chat') setNotifChat(nextChat);
        if (key === 'marketplace') setNotifMarketplace(nextMkt);
        if (key === 'escrow') setNotifEscrow(nextEscrow);
        if (key === 'knocks') setNotifKnocks(nextKnocks);

        try {
            await updateNotificationPreferences(identity.publicKey, {
                notify_chat: nextChat,
                notify_marketplace: nextMkt,
                notify_escrow: nextEscrow,
                notify_knocks: nextKnocks,
            });
        } catch (e) {
            console.warn('[NotifPrefs] Save failed:', e);
        }
    };

    // Blocked Members: the list the community keeps for this account (lib/blocklist), read from it when this opens.
    // A read that failed says so (never "no blocked members"), and so does an unblock the community didn't take.
    const [blockedUsersList, setBlockedUsersList] = useState<{ pubkey: string; callsign?: string }[]>([]);
    const [loadingBlockedList, setLoadingBlockedList] = useState(false);
    const [blockedListError, setBlockedListError] = useState<string | null>(null);
    const [blockedActionError, setBlockedActionError] = useState<string | null>(null);
    /** The key being unblocked, or 'all' for Unblock All, while the community answers. */
    const [blockedBusy, setBlockedBusy] = useState<string | null>(null);
    /** Said while blocks wait in this browser because the list on the community is full (lib/blocklist). */
    const [blockedFullNote, setBlockedFullNote] = useState<string | null>(null);
    const blockedNames = useRef(new Map<string, string>());
    /**
     * Blocked members who are still your friends. A block does not end a friendship (guide settings/blocking.md), and the
     * web hides a blocked member from your lists, so "Also remove from friends" here ends it in one step, through the
     * same route as any removal (POST /api/friends/remove); the block stays. Nothing is offered when the read fails.
     */
    const [blockedFriends, setBlockedFriends] = useState<Set<string>>(new Set());
    /** Blocked members taken off your friends here, said on their row. */
    const [removedFriends, setRemovedFriends] = useState<Set<string>>(new Set());
    /** The latest list asked to show: an older one whose names come in after it never replaces it. */
    const blockedShown = useRef(0);

    const showBlockedList = async (pubkeys: string[]) => {
        const shown = ++blockedShown.current;
        setBlockedFullNote(getBlocklistFullNote());
        const items = await Promise.all(pubkeys.map(async (pk) => {
            let callsign = blockedNames.current.get(pk) ?? (pk.length > 16 ? `${pk.slice(0, 8)}...${pk.slice(-6)}` : pk);
            if (!blockedNames.current.has(pk)) {
                try {
                    const profile = await getMemberProfile(pk);
                    if (profile?.callsign) {
                        callsign = profile.callsign;
                        blockedNames.current.set(pk, callsign);
                    }
                } catch {}
            }
            return { pubkey: pk, callsign };
        }));
        if (shown === blockedShown.current) setBlockedUsersList(items);
    };

    const loadBlockedList = async () => {
        setLoadingBlockedList(true);
        setBlockedListError(null);
        getFriends(identity.publicKey)
            .then(friends => setBlockedFriends(new Set(friends.map(f => f.publicKey))))
            .catch(() => setBlockedFriends(new Set()));
        try {
            await showBlockedList(await loadBlocklist());
        } catch (e: any) {
            setBlockedListError(e?.message || t('Couldn’t load your blocked members from your community. Try again.'));
        } finally {
            setLoadingBlockedList(false);
        }
    };

    useEffect(() => {
        if (mode === 'blocked-users') {
            setBlockedActionError(null);
            loadBlockedList();
            const unsub = onBlocklistUpdated((pubkeys) => {
                showBlockedList(pubkeys).catch(() => {});
            });
            return unsub;
        }
    }, [mode]);

    const unblockFromList = async (pubkey: string) => {
        setBlockedActionError(null);
        setBlockedBusy(pubkey);
        try {
            await unblockUser(pubkey);
        } catch (e: any) {
            setBlockedActionError(e?.message || t('That did not go through. Please try again.'));
        } finally {
            setBlockedBusy(null);
        }
    };

    const removeBlockedFriend = async (pubkey: string, callsign: string) => {
        if (!window.confirm(t('Remove {name} from your friends? They stay blocked. They can notice a removal.', { name: callsign }))) return;
        setBlockedActionError(null);
        setBlockedBusy(`friend:${pubkey}`);
        try {
            await removeFriendApi(identity.publicKey, pubkey);
            setBlockedFriends(prev => { const next = new Set(prev); next.delete(pubkey); return next; });
            setRemovedFriends(prev => new Set(prev).add(pubkey));
        } catch (e: any) {
            setBlockedActionError(e instanceof TypeError
                ? t('Couldn’t reach your community, so they are still your friend. Check your connection and try again.')
                : (e?.message || t('That did not go through, so they are still your friend. Please try again.')));
        } finally {
            setBlockedBusy(null);
        }
    };

    const unblockEveryone = async () => {
        if (!window.confirm(t('Are you sure you want to unblock all members?'))) return;
        setBlockedActionError(null);
        setBlockedBusy('all');
        try {
            await clearBlocklist();
        } catch (e: any) {
            setBlockedActionError(e?.message || t('That did not go through. Please try again.'));
        } finally {
            setBlockedBusy(null);
        }
    };



    // Database Diagnostics
    const [diagLoading, setDiagLoading] = useState(false);
    const [storageEstimate, setStorageEstimate] = useState<string>(() => t('Detecting...'));
    const [dbStats, setDbStats] = useState<any>(null);

    const loadDiagnostics = async () => {
        setDiagLoading(true);
        try {
            const stats = await getNodeStats();

            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                if (est.usage) {
                    setStorageEstimate(t('{size} MB', { size: formatNumber(est.usage / (1024 * 1024), 2) }));
                } else {
                    setStorageEstimate(t('< 1 MB'));
                }
            } else {
                setStorageEstimate(t('Local Web Storage'));
            }

            let memberCount = 0;
            let postCount = 0;
            try {
                const keys = Object.keys(localStorage);
                memberCount = keys.filter(k => k.includes('member')).length;
                postCount = keys.filter(k => k.includes('post') || k.includes('offer')).length;
            } catch {}

            setDbStats({
                integrity: 'ok',
                members: stats ? stats.members : memberCount,
                posts: stats ? stats.posts : postCount,
                transactions: stats?.transactions ?? 0,
                messages: 0
            });
        } catch (e) {
            console.warn('[Diagnostics] Failed:', e);
        } finally {
            setDiagLoading(false);
        }
    };

    // Seed phrase copy
    const [seedCopied, setSeedCopied] = useState(false);

    // Read through the accessor rather than off the identity, so the vault (Phase C) — which
    // is also what gets these words out of plaintext IndexedDB — lands without touching this
    // screen. Held in state because that read is asynchronous and a render cannot await.
    const [seedWords, setSeedWords] = useState<string[] | null>(null);
    useEffect(() => {
        // Gated on being ON the recovery screen, not merely on Settings existing.
        //
        // Reading on mount works today, and would be wrong the moment there is a vault:
        // opening Settings for any reason at all — to change a notification toggle — would
        // fire a password or biometric prompt for words the user never asked to see. It
        // also kept them decrypted in component state for as long as Settings stayed open.
        // Native gets this for free by loading at the reveal; the PWA has no reveal step,
        // so entering the screen is the equivalent moment.
        if (mode !== 'seed') {
            setSeedWords(null);
            return;
        }
        let cancelled = false;
        getMnemonic(identity).then(w => {
            if (cancelled) return;
            setSeedWords(w);
            // Mark as viewed HERE — when the words are actually on screen — rather than on
            // the button that navigates here. A mis-tap that bounces straight back out
            // would otherwise permanently clear the one warning standing between the member
            // and silent browser eviction.
            if (w && w.length > 0) {
                localStorage.setItem(seedViewedKey(identity.publicKey), 'true');
                setSeedViewed(true);
            }
        });
        return () => { cancelled = true; };
    }, [identity, mode]);

    // On the clipboard for a minute, then cleared if nothing else can have been copied since (lib/words-clipboard.ts).
    const handleCopySeed = async () => {
        const words = await getMnemonic(identity);
        if (!words) return;
        if (!(await copyWordsForAMinute(words.join(' ')))) return;
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    };
    // Leaving the words screen, the page can no longer vouch that nothing else was copied since.
    useEffect(() => {
        if (mode !== 'seed') return;
        return leftTheWordsScreen;
    }, [mode]);

    // Redeem invite & Node settings
    const [redeemInviteCode, setRedeemInviteCode] = useState('');
    const [redeemLoading, setRedeemLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [profile, setProfile] = useState<MemberProfile | null>(null);
    const [showQuizModal, setShowQuizModal] = useState(false);
    const [quizInitialMode, setQuizInitialMode] = useState<'quick' | 'deep'>('quick');

    const handleQuizComplete = async (quizResult: QuizResult) => {
        const publicArchetype = JSON.stringify({
            primary: quizResult.primary,
            secondary: quizResult.secondary,
            mode: quizResult.mode,
            updatedAt: quizResult.updatedAt,
        });
        try {
            const res = await updateMemberProfile(identity.publicKey, { archetype: publicArchetype });
            if (res?.profile) {
                setProfile(res.profile);
            } else {
                setProfile(prev => prev ? { ...prev, archetype: JSON.stringify(quizResult) } : {
                    publicKey: identity.publicKey,
                    callsign: identity.callsign,
                    avatar: null,
                    bio: '',
                    contact: null,
                    archetype: JSON.stringify(quizResult),
                });
            }
        } catch (e) {
            console.warn('[Archetype] Save failed:', e);
            throw e;
        }
    };
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [deletionMode, setDeletionMode] = useState<'none' | 'options' | 'confirm_local' | 'confirm_purge' | 'purged'>('none');
    // A lib/delete-here sentence as it came, or this screen's own (Said: held as a function, set with () => …).
    const [purgeError, setPurgeError] = useState<Said | null>(null);
    const [purgeCallsignInput, setPurgeCallsignInput] = useState('');
    const [isPurging, setIsPurging] = useState(false);
    // What Permanently Delete Account does in this browser (lib/delete-here): asked as the member opens it, so the
    // screen says whether the key stays. Null while the page's own node is asked.
    const [deletePlan, setDeletePlan] = useState<WebDeletePlan | null>(null);
    const [purgedNote, setPurgedNote] = useState<string | null>(null);
    const deletePlanTurn = useRef(0);
    const openPurge = () => {
        setDeletionMode('confirm_purge');
        setPurgeError(null);
        setPurgeCallsignInput('');
        setDeletePlan(null);
        const turn = ++deletePlanTurn.current;
        void planWebDelete(identity.publicKey).then((plan) => {
            if (turn === deletePlanTurn.current) setDeletePlan(plan);
        });
    };

    // Members never pick the node address (Marty, card signin-two-names, 15 Oct: "Keep refusing, hide the setting"): the
    // account-move QR (#1983) refuses a second address, so an address the phone doesn't know would strand them. The editor
    // is a development build's; a browser that already has one stored says which and can reset it.
    const showNodeUrlEditor = import.meta.env.DEV;
    const [storedNodeUrl] = useState(() => getStoredNodeApiUrl());
    const [customNodeUrl, setCustomNodeUrl] = useState(() => getNodeApiUrl());
    const [testingNode, setTestingNode] = useState(false);
    const [nodeTestResult, setNodeTestResult] = useState<{ ok: boolean; callsign?: string; latencyMs?: number; error?: string } | null>(null);

    const handleTestNodeConnection = async () => {
        if (!customNodeUrl.trim()) return;
        setTestingNode(true);
        setNodeTestResult(null);
        const res = await testNodeConnection(customNodeUrl.trim());
        setNodeTestResult(res);
        setTestingNode(false);
    };

    const handleSaveNodeUrl = () => {
        setNodeApiUrl(customNodeUrl.trim() || null);
        window.location.reload();
    };

    const handleResetNodeUrl = () => {
        setNodeApiUrl(null);
        setCustomNodeUrl('');
        window.location.reload();
    };

    useEffect(() => {
        getMemberProfile(identity.publicKey).then(setProfile).catch(() => {});
    }, [identity.publicKey, mode]);

    const fingerprint = identity.publicKey.slice(0, 16) + '…';

    async function handleRedeemInvite() {
        if (!redeemInviteCode.trim()) return;
        setRedeemLoading(true);
        setError(null);
        setSuccess(null);
        try {
            // Signed with the key it names (the node registers no key a redeem isn't signed by).
            await redeemInvite(redeemInviteCode.trim(), identity.publicKey, identity.callsign, identity);
            setSuccess(t('Invite redeemed successfully on current node!'));
            setRedeemInviteCode('');
        } catch (e: any) {
            setError(e.message || t('Redemption failed.'));
        } finally {
            setRedeemLoading(false);
        }
    }

    async function handleForceResync() {
        if (window.confirm(t('Are you sure you want to clear the local client cache and force a complete resync from this community node?'))) {
            setLoading(true);
            setError(null);
            setSuccess(null);
            try {
                sessionStorage.clear();
                // Home's last answer is this browser's cache of the community too (lib/home-cache.ts); a Home still open in
                // another tab drops its copy and reads afresh, never writing the old one back.
                await clearHomeCache('cleared');
                clearSyncCursor();
                localStorage.removeItem('beanpool-sync-state');
                localStorage.removeItem(`bp_offline_invites_${identity.publicKey}`);
                localStorage.removeItem('bp_geo_settings');
                localStorage.removeItem('bp_peer_prefs');
                localStorage.removeItem('beanpool-privacy-tier');

                setSuccess(t('Cache cleared. Resynced & reloading application...'));
                setTimeout(() => {
                    // Cleared AGAIN immediately before the reload. The WebSocket stays open
                    // during this 1.5s message, so a broadcast arriving in the meantime runs a
                    // coordinated sync and persists a fresh cursor — quietly undoing the clear
                    // the member just asked for, and leaving "force a complete resync" doing a
                    // delta instead.
                    clearSyncCursor();
                    window.location.reload();
                }, 1500);
            } catch (e: any) {
                setError(t('Resync failed: {error}', { error: e.message }));
                setLoading(false);
            }
        }
    }

    if (mode === 'guide') {
        // The members' sheet and manual, full screen. Its Suggest a change opens the same form as the Settings row.
        // From Home's Tips card it opens at the tip's page; Back from there walks to the guide's front page, then Settings.
        return <MemberGuide onBack={() => setMode('menu')} onSuggest={() => setMode('suggest')} initialPage={initialGuidePage ?? undefined} />;
    }

    return (
        <div className="flex justify-center p-4 min-h-screen page-surface transition-colors">
            <div className="max-w-3xl w-full mt-2 pb-32">
                {/* Header */}
                <div className="flex items-center mb-6">
                    <button
                        onClick={onBack}
                        className="text-nature-600 dark:text-nature-400 font-semibold text-sm cursor-pointer border-none bg-transparent hover:text-nature-900 dark:hover:text-white"
                    >
                        {t('← Back')}
                    </button>
                    <h2 className="flex-1 text-center text-xl font-bold text-nature-950 dark:text-white tracking-tight m-0 transition-colors">
                        {t('Settings')}
                    </h2>
                    <div className="w-12" />
                </div>

                {/* Identity Card */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 mb-6 shadow-soft border border-nature-200 dark:border-nature-800 transition-colors relative">
                    {/* In the card's flow, above the photo: a longer language's words (ru "Редактировать профиль") ran over the
                        photo when it sat in the corner (e2e/words-w3-screens-check.mjs). */}
                    <div className="flex justify-end -mt-2 -mr-2 mb-1">
                        <button
                            onClick={() => setMode('profile')}
                            className="max-w-full break-words text-xs font-bold text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-1.5 rounded-full border border-terra-200 dark:border-terra-800/60 cursor-pointer hover:bg-terra-100 dark:hover:bg-terra-900/60 dark:hover:text-terra-300 transition-all"
                        >
                            {t('✏️ Edit Profile')}
                        </button>
                    </div>
                    <div className="flex justify-center mb-4">
                        <div className="w-20 h-20 rounded-full border-4 border-terra-300 dark:border-terra-600 flex items-center justify-center text-3xl bg-oat-50 dark:bg-nature-800 shadow-inner overflow-hidden transition-colors">
                            <MemberAvatar avatarUrl={profile?.avatar} pubkey={identity.publicKey} callsign={identity.callsign} size={72} />
                        </div>
                    </div>
                    <div className="text-center mb-4">
                        <div className="text-xl font-extrabold text-nature-950 dark:text-white">{identity.callsign}</div>
                        {profile?.bio && <div className="text-xs text-nature-500 dark:text-nature-400 italic mt-1">{profile.bio}</div>}
                    </div>

                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">{t('Public Key')}</div>
                    <div className="text-sm font-mono text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-2 rounded-lg border border-terra-100 dark:border-terra-800/50 transition-colors break-all mb-3 flex items-center justify-between">
                        <span>{fingerprint}</span>
                        <button
                            onClick={() => {
                                anotherCopyMade();
                                navigator.clipboard.writeText(identity.publicKey);
                                alert(t('Public Key copied to clipboard'));
                            }}
                            className="text-xs border-none bg-transparent cursor-pointer"
                            title={t('Copy Public Key')}
                        >
                            📋
                        </button>
                    </div>

                    {/* Two versions, named: the node you are talking to, and the app in this
                        browser. Collapsing them into one number hides a stale cached bundle. */}
                    <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs text-nature-500 dark:text-nature-400 pt-2 border-t border-nature-100 dark:border-nature-800">
                        <span className="min-w-0 break-words"><Sentence text={t('Node: {address}')} parts={{ address: <code className="font-mono text-nature-700 dark:text-nature-300 break-all">{window.location.host}</code> }} />{nodeVersion && <span className="font-mono ml-1">{t('v{version}', { version: nodeVersion })}</span>}</span>
                        <span className="whitespace-nowrap" aria-label={t('App version {version}', { version: __APP_VERSION__ })}>{t('App v{version}', { version: __APP_VERSION__ })}</span>
                    </div>
                </div>

                {mode === 'menu' && (
                    <div className="space-y-6">
                        <RecoveryAlertBanner identity={identity} />
                        {/* A paused member only, until a moderator lifts it (G3). */}
                        <ModerationPauseCard />
                        {/* An account made with 12 words alone, for as long as it has no sign-in: one way back, and a
                            sign-in to add (two-doors design §2.5). With the result of one that just came back. */}
                        <OneWayBackCard identity={identity} placement="settings" onSeeWords={() => setMode('seed')} result={linkResult} />
                        {/* A new account only, until the node says its limits are over (G11-e). */}
                        <NewAccountCard />
                        {/* A known community only, until the member agrees to what its admins can see (slice 6); never blocks. */}
                        <KnownConsentCard />
                        {/* Owners and admins only — the node answers the role. */}
                        <NodeAdminLink />
                        {/* Owners only: "Check your 12 words" (sealed-keys.md §7). */}
                        <OwnerWordsCheck identity={identity} startOpen={openOwnerWordsCheck} hasWords={hasWords} />
                        {/* Owners only, remembered: take over or restore with this browser (sealed keys slice 6). */}
                        <OwnerUnlockCard identity={identity} />
                        {/* ─── COMMUNITY WORKING STYLE ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                                {t('COMMUNITY WORKING STYLE')}
                            </div>
                            {(() => {
                                const parsed = parseArchetype(profile?.archetype);
                                const primary = parsed ? ARCHETYPES[parsed.primary] : null;
                                const secondary = parsed ? ARCHETYPES[parsed.secondary] : null;

                                if (parsed && primary) {
                                    return (
                                        <div className="bg-white dark:bg-nature-900 rounded-2xl p-5 shadow-sm border border-nature-200 dark:border-nature-800 space-y-3">
                                            <div className="flex items-center gap-3">
                                                <span className="text-3xl select-none" aria-hidden="true">{primary.emoji}</span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="min-w-0 text-[15px] font-bold text-nature-950 dark:text-white break-words">
                                                            {t(primary.name)}
                                                        </span>
                                                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent shrink-0">
                                                            {parsed.mode === 'deep' ? t('27 Qs') : t('9 Qs')}
                                                        </span>
                                                    </div>
                                                    <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 break-words">
                                                        {t(primary.tagline)}
                                                    </div>
                                                </div>
                                            </div>

                                            <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 leading-relaxed m-0">
                                                {t(primary.description)}
                                            </p>

                                            {secondary && (
                                                <div className="inline-block px-3 py-1 rounded-full bg-oat-100 dark:bg-nature-800 text-xs font-semibold text-nature-800 dark:text-nature-300 border border-nature-200 dark:border-nature-700">
                                                    {t('Secondary Rhythm: {emoji} {name}', { emoji: secondary.emoji, name: t(secondary.name) })}
                                                </div>
                                            )}

                                            <div className="border-t border-nature-100 dark:border-nature-800 pt-3">
                                                <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2">
                                                    {t('🌟 What you tend to enjoy')}
                                                </div>
                                                <ul className="space-y-1.5 m-0 p-0 list-none">
                                                    {primary.superpowers.map((_, i) => (
                                                        <li key={i} className="flex items-start gap-2 text-xs text-nature-700 dark:text-nature-300">
                                                            <span className="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">•</span>
                                                            <span>{t(primary.superpowers[i])}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>

                                            <div className="flex flex-wrap sm:flex-nowrap gap-2 pt-2">
                                                {parsed.mode === 'quick' && (
                                                    <button
                                                        type="button"
                                                        aria-label={t('Take the longer 27 question quiz for a more accurate result')}
                                                        onClick={() => {
                                                            setQuizInitialMode('deep');
                                                            setShowQuizModal(true);
                                                        }}
                                                        className="flex-1 min-w-0 py-2.5 px-3 rounded-xl text-xs font-bold bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-none cursor-pointer transition-colors shadow-sm break-words"
                                                    >
                                                        {t('🧭 More accurate')}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    aria-label={t('Retake community working style quiz')}
                                                    onClick={() => {
                                                        setQuizInitialMode('quick');
                                                        setShowQuizModal(true);
                                                    }}
                                                    className={`min-w-0 py-2.5 px-3 rounded-xl text-xs font-bold border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-800 hover:bg-nature-100 dark:hover:bg-nature-700 text-nature-800 dark:text-nature-200 cursor-pointer transition-colors shadow-sm break-words ${
                                                        parsed.mode === 'quick' ? 'flex-1' : 'w-full'
                                                    }`}
                                                >
                                                    {t('🔄 Retake')}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                }

                                return (
                                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-5 shadow-sm border border-nature-200 dark:border-nature-800">
                                        <div className="flex items-start gap-3.5 mb-4">
                                            <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-2xl shrink-0">
                                                🌱
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[15px] font-bold text-nature-950 dark:text-white mb-1">
                                                    {t('How you like to work')}
                                                </div>
                                                <p className="text-xs text-nature-600 dark:text-nature-400 leading-normal m-0">
                                                    {t('Take the 60-second quiz on how you prefer to work, and get tips for working well with neighbours.')}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={t('Take 60-second community working style quiz')}
                                            onClick={() => {
                                                setQuizInitialMode('quick');
                                                setShowQuizModal(true);
                                            }}
                                            className="w-full py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-none cursor-pointer transition-colors shadow-sm"
                                        >
                                            {t('⚡ Take 60s Quiz')}
                                        </button>
                                    </div>
                                );
                            })()}
                        </div>

                        {/* ─── ACCOUNT & IDENTITY ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                                {t('ACCOUNT & IDENTITY')}
                            </div>
                            <div className="space-y-2.5">

                                {/* Sovereignty banner — shown until the member has viewed their 12 words, when this browser has them */}
                                {!seedViewed && hasWords && (
                                    <div role="alert" className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 space-y-2">
                                        <p className="text-sm font-bold text-amber-900 dark:text-amber-300">
                                            <span aria-hidden="true">⚠️</span> {t("You haven't saved your recovery phrase yet")}
                                        </p>
                                        <p className="text-xs text-amber-800 dark:text-amber-400 leading-relaxed">
                                            {signInRecoveryNames
                                                ? <>{t('Your 12 words bring your account back on any device, and so does signing in with {names}.', { names: signInRecoveryNames })}</>
                                                : <BoldWords text={t('Your 12 words are the **only** way to recover your account.')} />}
                                            {' '}<>{t('Browsers can clear site data without warning — Safari does it after 7 days of inactivity.')}</>
                                        </p>
                                        <button
                                            onClick={() => setMode('seed')}
                                            className="mt-1 min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-bold bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on border-none cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                                        >
                                            {t('View & Save Recovery Phrase')}
                                        </button>
                                    </div>
                                )}
                                {onReRunSetup && (
                                    <button
                                        onClick={onReRunSetup}
                                        className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                    >
                                        <span className="text-xl">✨</span>
                                        <div className="flex-1">
                                            <div className="text-[15px] font-bold">{t('Re-run Setup')}</div>
                                            <div className="text-xs font-normal text-nature-500 dark:text-nature-300">{t('Update your name & photo, and how BeanPool works')}</div>
                                        </div>
                                        <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                    </button>
                                )}



                                <button
                                    onClick={() => setMode('seed')}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">🔑</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">{t('View Recovery Phrase')}</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-300">
                                            {hasWords ? t('View your 12-word backup seed') : t('Not saved in this browser')}
                                        </div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                </button>
                                <SignInRecoveryLine enrolled={signInRecovery} hasWords={hasWords} phoneLater={phoneLater} keepsNoCopies={communityInfo?.recoveryCopies === 'none'} />
                                {/* Where a copy of this account is kept, as far as this browser can ask, and removing this
                                    server's (vault rethink VR1). After a removal the server's list is read again, so the
                                    line above says what it keeps now. */}
                                <WaysBackSection
                                    enrolled={signInRecovery}
                                    hasWords={hasWords}
                                    onShowWords={() => setMode('seed')}
                                    onChanged={() => { getSignInRecovery().then(setSignInRecovery); }}
                                />
                            </div>
                        </div>

                        {/* ─── APP SETTINGS ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                                {t('APP SETTINGS')}
                            </div>
                            <div className="space-y-2.5">
                                {/* Appearance: follow the device, or always light / dark */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">🌙</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">{t('Appearance')}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t('Light or dark, or the same as your device')}</div>
                                        </div>
                                    </div>
                                    <div role="radiogroup" aria-label={t('Appearance')} className="mt-3 flex gap-1 p-1 rounded-xl bg-nature-100 dark:bg-nature-800">
                                        {THEME_PREFERENCE_OPTIONS.map(({ value }, i) => {
                                            const selected = themePreference === value;
                                            return (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    onClick={() => onThemePreferenceChange(value)}
                                                    className={`flex-1 min-w-0 min-h-[48px] px-1.5 py-1.5 rounded-lg text-[13px] text-center leading-tight break-words cursor-pointer transition-colors ${selected
                                                        ? 'bg-white dark:bg-nature-950 border border-nature-500 font-bold text-nature-900 dark:text-white'
                                                        : 'border border-transparent font-medium text-nature-600 dark:text-nature-300'}`}
                                                >
                                                    {t(THEME_PREFERENCE_OPTIONS[i].label)}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Language: per device, like Appearance (lib/language.ts). Each language listed in itself. */}
                                <LanguageRow />

                                {/* Background pattern: the doodle wallpaper, or a plain colour. Per device. */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <span className="text-xl">🎨</span>
                                        <div className="flex-1">
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">{t('Background pattern')}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t('Doodles behind the app, or a plain background')}</div>
                                        </div>
                                        <input
                                            type="checkbox"
                                            className="w-12 h-7 cursor-pointer accent-nature-600"
                                            checked={patternEnabled}
                                            onChange={(e) => {
                                                setPatternEnabled(e.target.checked);
                                                setPatternPreference(e.target.checked);
                                            }}
                                        />
                                    </label>
                                </div>

                                {/* Notification Preferences */}
                                <button
                                    onClick={() => { setMode('notifications'); loadNotificationPreferences(); }}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">🔔</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">{t('Notification Preferences')}</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-300">{t('Phone app push notification settings')}</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                </button>

                                {/* Your area: a community that syncs listings by area */}
                                {areaLimits && (
                                    <button
                                        data-testid="settings-your-area"
                                        onClick={() => { setAreaError(null); setMode('area'); }}
                                        className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                    >
                                        <span className="text-xl">📍</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[15px] font-bold">{t(AREA_STEP_WORDS.settingsRow)}</div>
                                            <div className="text-xs font-normal text-nature-500 dark:text-nature-300 break-words">{areaLine}</div>
                                        </div>
                                        <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                    </button>
                                )}

                                {/* Modern Map Pins */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">🗺️</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">{t('Modern Map Pins')}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t('Toggle custom pin markers')}</div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={useModernMarkers}
                                        onChange={handleToggleModernMarkers}
                                        label={t('Modern Map Pins')}
                                        activeBgClass="bg-bp-commit-fill border-bp-commit-fill"
                                    />
                                </div>

                                {/* Holiday Mode */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">🌴</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">{t('Holiday Mode')}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">
                                                {holidayMode ? t('Away — offers hidden') : t('Hide offers & pause requests')}
                                            </div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={holidayMode}
                                        onChange={handleToggleHoliday}
                                        disabled={holidayLoading}
                                        label={t('Holiday Mode')}
                                        activeBgClass="bg-bp-gold-fill border-bp-gold-fill"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* ─── BEANPOOL: the members' guide, Suggest a change (only while FEEDBACK_LIVE; goes to beanpool.org,
                             not this community's node), the website. The same rows as the member app's Settings. ─── */}
                        <BeanPoolSettingsGroup onHelp={() => setMode('guide')} onSuggest={() => setMode('suggest')} globalCommunity={globalCommunity} phoneLater={phoneLater} />

                        {/* ─── LEGAL & PRIVACY ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                                {t('LEGAL & PRIVACY')}
                            </div>
                            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden divide-y divide-nature-100 dark:divide-nature-800">
                                <button
                                    type="button"
                                    onClick={() => setMode('blocked-users')}
                                    className="w-full p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors bg-transparent border-none cursor-pointer text-left"
                                >
                                    <span className="flex items-center gap-3">🚫 <>{t('Manage Blocked Members')}</></span>
                                    <span className="text-nature-400 dark:text-nature-300">›</span>
                                </button>
                                {showAsConnection !== null && (
                                    <div className="p-4 flex items-center justify-between gap-3" data-testid="show-as-connection">
                                        <span className="min-w-0">
                                            <span className="block text-text-primary font-bold text-[15px]">🤝 <>{t('Show me as a connection in common')}</></span>
                                            <span className="block text-text-muted text-[12px] mt-0.5">{t("When you and two people are friends both ways, each can see your name on the other's profile")}</span>
                                            {showAsConnectionError && <span role="alert" className="block text-text-primary text-[12px] mt-1 font-semibold">{showAsConnectionError}</span>}
                                        </span>
                                        <ToggleSwitch
                                            checked={showAsConnection}
                                            onChange={handleToggleShowAsConnection}
                                            label={t('Show me as a connection in common')}
                                            activeBgClass="bg-accent border-accent"
                                            inactiveBgClass="bg-bg-hover border-border-primary"
                                        />
                                    </div>
                                )}
                                <a href="https://beanpool.org/privacy.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">🛡️ <>{t('Privacy Policy')}</></span>
                                    <span className="text-nature-400 dark:text-nature-300">›</span>
                                </a>
                                <a href="https://beanpool.org/terms.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">⚖️ <>{t('Terms of Service & EULA')}</></span>
                                    <span className="text-nature-400 dark:text-nature-300">›</span>
                                </a>
                                <a href="https://beanpool.org/safety.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">🚸 <>{t('Child Safety Standards')}</></span>
                                    <span className="text-nature-400 dark:text-nature-300">›</span>
                                </a>
                            </div>
                        </div>

                        {/* ─── SYSTEM ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                                {t('SYSTEM')}
                            </div>
                            <div className="space-y-2.5">
                                <button
                                    onClick={() => { setMode('diagnostics'); loadDiagnostics(); }}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">📊</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">{t('Database Health & Stats')}</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-300">{t('Local storage metrics & integrity checks')}</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                </button>

                                <button
                                    onClick={() => setMode('advanced')}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">⚙️</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">{t('Advanced / Subsystem')}</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-300">{t('Node management & cache controls')}</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-300 group-hover:translate-x-1 transition-transform">→</span>
                                </button>
                            </div>
                        </div>

                        {/* ─── DANGER ZONE: GRANULAR ACCOUNT DELETION (#99) ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-red-500 dark:text-red-400 mb-2 px-1">
                                {t('DANGER ZONE')}
                            </div>

                            {deletionMode === 'none' && (
                                <button
                                    onClick={() => {
                                        setDeletionMode('options');
                                        setPurgeError(null);
                                        setPurgeCallsignInput('');
                                    }}
                                    className="w-full p-4 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 font-bold border border-red-200 dark:border-red-800 shadow-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-left flex items-center justify-between cursor-pointer"
                                >
                                    <span className="flex items-center gap-3">⚠️ <>{t('Account Deletion & Sign Out')}</></span>
                                    <span>→</span>
                                </button>
                            )}

                            {deletionMode === 'options' && (
                                <div className="bg-red-50/70 dark:bg-red-950/30 rounded-2xl p-5 border-2 border-red-200 dark:border-red-900 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h4 className="text-red-900 dark:text-red-300 font-bold text-sm m-0">
                                            {t('Choose an Action')}
                                        </h4>
                                        <button
                                            onClick={() => setDeletionMode('none')}
                                            className="text-xs text-nature-500 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer"
                                        >
                                            {t('✕ Cancel')}
                                        </button>
                                    </div>

                                    {/* Option 1: Device Wipe Only */}
                                    <div className="bg-white dark:bg-nature-900 p-4 rounded-xl border border-nature-200 dark:border-nature-800 space-y-2">
                                        <div className="font-bold text-sm text-nature-900 dark:text-white flex items-center gap-2">
                                            <span>🚪</span> {t('Remove from This Device Only')}
                                        </div>
                                        <p data-testid="sign-out-device-way-back" className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed m-0">
                                            {hasWords
                                                ? t('Signs out and clears local browser storage. Your account and listings remain safely stored on the community node and can be restored anytime with your 12-word recovery phrase.')
                                                : t('Signs out and clears local browser storage. Your account and listings remain safely stored on the community node. {noWords} {waysBack}', { noWords: noWordsHere(), waysBack: waysBackWithoutWords(signInRecovery) })}
                                        </p>
                                        <button
                                            onClick={() => setDeletionMode('confirm_local')}
                                            className="mt-2 w-full py-2.5 rounded-xl bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 font-bold text-xs border-none cursor-pointer hover:bg-nature-200 dark:hover:bg-nature-700 transition-colors"
                                        >
                                            {t('Sign Out (Device Only)')}
                                        </button>
                                    </div>

                                    {/* Option 2: Full Node Data Purge */}
                                    <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-xl border border-red-300 dark:border-red-800 space-y-2">
                                        <div className="font-bold text-sm text-red-900 dark:text-red-300 flex items-center gap-2">
                                            <span>🗑️</span> {t('Permanently Delete Account & Node Data')}
                                        </div>
                                        <p data-testid="delete-card-line" className="text-xs text-red-800 dark:text-red-400 leading-relaxed m-0">
                                            {keyLineWords(WEB_DELETE_CARD_LINE)} <strong>{t('Cannot be undone, even with your 12-word phrase.')}</strong>
                                        </p>
                                        <button
                                            onClick={openPurge}
                                            className="mt-2 w-full py-2.5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold text-xs border-none cursor-pointer transition-colors shadow-sm"
                                        >
                                            {t('Permanently Delete Account')}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {deletionMode === 'confirm_local' && (
                                <div className="bg-white dark:bg-nature-900 rounded-2xl p-5 border-2 border-nature-200 dark:border-nature-700 space-y-3">
                                    <h4 className="text-nature-900 dark:text-white font-bold text-sm m-0">
                                        {t('🚪 Confirm Device Sign Out')}
                                    </h4>
                                    <p data-testid="sign-out-device-confirm" className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed m-0">
                                        {hasWords
                                            ? t('Are you sure you want to remove your account from this device? Ensure you have written down your 12-word recovery phrase if you plan to sign in again later.')
                                            : t('Are you sure you want to remove your account from this device? {noWords} {waysBack}', { noWords: noWordsHere(), waysBack: waysBackWithoutWords(signInRecovery) })}
                                    </p>
                                    <div className="flex gap-3 pt-2">
                                        <button
                                            onClick={() => setDeletionMode('options')}
                                            disabled={isPurging}
                                            className="flex-1 py-2.5 rounded-xl bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 font-bold border-none cursor-pointer disabled:cursor-not-allowed text-xs"
                                        >
                                            {t('Cancel')}
                                        </button>
                                        <button
                                            onClick={async () => {
                                                setIsPurging(true);
                                                try {
                                                    await wipeIdentity();
                                                    await clearAccountStorage();
                                                    setDeletionMode('purged');
                                                    setTimeout(() => window.location.reload(), 1500);
                                                } finally {
                                                    setIsPurging(false);
                                                }
                                            }}
                                            disabled={isPurging}
                                            className="flex-1 py-2.5 rounded-xl bg-nature-900 dark:bg-white text-white dark:text-nature-900 font-bold border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                                        >
                                            {isPurging ? t('Signing Out...') : t('Confirm Sign Out')}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {deletionMode === 'confirm_purge' && (() => {
                                const isPurgeConfirmed =
                                    purgeCallsignInput.trim().toUpperCase() === 'DELETE' ||
                                    purgeCallsignInput.trim().toLowerCase() === (identity?.callsign || '').trim().toLowerCase();

                                return (
                                    <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-5 border-2 border-red-300 dark:border-red-700 space-y-3">
                                        <h4 className="text-red-900 dark:text-red-300 font-bold text-sm m-0">
                                            {t('⚠️ Irreversible Node Purge')}
                                        </h4>
                                        <p className="text-xs text-red-800 dark:text-red-400 leading-relaxed m-0">
                                            {/* DELETE is what the member types (the code compares it), so it is never translated. */}
                                            <Sentence
                                                text={t('Type your callsign {name} or {word} to confirm permanent deletion of your account from this community node:')}
                                                parts={{ name: <strong>{identity?.callsign || 'CALLSIGN'}</strong>, word: <strong>{PURGE_CONFIRM_WORD}</strong> }}
                                            />
                                        </p>
                                        <input
                                            id="purge-callsign-input"
                                            type="text"
                                            value={purgeCallsignInput}
                                            onChange={(e) => setPurgeCallsignInput(e.target.value)}
                                            placeholder={t('Type "{name}" or "{word}"', { name: identity?.callsign || '', word: 'DELETE' })}
                                            aria-label={t('Type callsign {name} or {word} to confirm permanent deletion', { name: identity?.callsign || '', word: 'DELETE' })}
                                            aria-invalid={Boolean(purgeError)}
                                            aria-describedby={purgeError ? 'purge-error-alert' : undefined}
                                            disabled={isPurging}
                                            className="w-full py-2.5 px-3 rounded-xl border border-red-300 dark:border-red-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white font-mono text-xs disabled:opacity-50"
                                            autoCapitalize="none"
                                        />
                                        {/* What stays in this browser: the key for the page's own community, or nothing. */}
                                        <p data-testid="delete-key-plan" aria-live="polite" className="text-xs text-nature-700 dark:text-nature-300 leading-relaxed m-0">
                                            {!deletePlan
                                                ? keyLineWords(WEB_DELETE_CHECKING_LINE)
                                                : deletePlan.kind === 'this-one'
                                                    ? `🔑 ${keyLineWords(webKeepsKeyLine(deletePlan, hasWords))}`
                                                    : keyLineWords(webLastCommunityLine(hasWords))}
                                        </p>
                                        {deletePlan?.kind === 'last' && (
                                            <p data-testid="delete-vault-copy" className="text-xs text-nature-700 dark:text-nature-300 leading-relaxed m-0">
                                                {keyLineWords(WEB_VAULT_COPY_LINE)}
                                            </p>
                                        )}
                                        {purgeError && (
                                            <div id="purge-error-alert" role="alert" className="p-3 rounded-xl bg-red-100 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-red-800 dark:text-red-300 text-xs font-semibold">
                                                {saidWords(purgeError)}
                                            </div>
                                        )}
                                        <div className="flex gap-3 pt-2">
                                            <button
                                                onClick={() => setDeletionMode('options')}
                                                disabled={isPurging}
                                                className="flex-1 py-2.5 rounded-xl bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 font-bold border border-nature-200 dark:border-nature-700 cursor-pointer disabled:cursor-not-allowed text-xs"
                                            >
                                                {t('Cancel')}
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    if (!isPurgeConfirmed) {
                                                        setPurgeError(() => () => t('Please type "{name}" or "{word}" exactly to confirm.', { name: identity?.callsign || '', word: 'DELETE' }));
                                                        return;
                                                    }
                                                    // The screen said what stays; exactly that happens.
                                                    const plan = deletePlan;
                                                    if (!plan) return;
                                                    setIsPurging(true);
                                                    setPurgeError(null);
                                                    try {
                                                        // Until the node the panel named answers { ok: true }, nothing in this browser changes:
                                                        // purgeHere sends nothing when the web app now talks to another node, and gives up
                                                        // after 20 seconds.
                                                        const purged = await purgeHere(plan);
                                                        if (!purged.ok) {
                                                            setPurgeError(webDeleteFailedLine(purged.reason));
                                                            return;
                                                        }
                                                        if (plan.kind === 'this-one') {
                                                            // The page's own community keeps the key: back to it, key and settings kept.
                                                            await leaveThisCommunity();
                                                            setPurgedNote(t('Account deleted at {here}. This browser keeps your key for {kept}. Reloading app...', { here: hostOf(plan.here), kept: hostOf(plan.keeps.url) }));
                                                        } else {
                                                            try {
                                                                await wipeIdentity();
                                                                await clearAccountStorage();
                                                            } catch (e) {
                                                                setPurgeError(webDeletedButLine(e instanceof Error ? e.message : String(e)));
                                                                return;
                                                            }
                                                            setPurgedNote(null);
                                                        }
                                                        setDeletionMode('purged');
                                                        setTimeout(() => window.location.reload(), 1500);
                                                    } finally {
                                                        setIsPurging(false);
                                                    }
                                                }}
                                                disabled={isPurging || !isPurgeConfirmed || !deletePlan}
                                                className="flex-1 py-2.5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold border-none transition-colors text-xs shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {isPurging ? t('Purging...') : t('🔥 Purge Account')}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}

                            {deletionMode === 'purged' && (
                                <div className="bg-red-100 dark:bg-red-900/30 rounded-2xl p-4 text-center border border-red-200 dark:border-red-800">
                                    <p className="text-red-800 dark:text-red-400 font-bold text-xs m-0">
                                        {purgedNote ?? t('Account data purged. Reloading app...')}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ─── MODE: VIEW RECOVERY PHRASE (SEED) ─── */}
                {mode === 'seed' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">{t('🔑 Recovery Phrase')}</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-3 leading-relaxed">
                            {t('Your 12-word recovery phrase allows you to restore your identity on any device. Anyone with these words can control your account. Keep them secret and offline.')}
                        </p>

                        {/* Browser eviction warning: to write down the words shown below, so only when there are some */}
                        {hasWords && <div className="bg-amber-50 dark:bg-amber-950/30 p-3 rounded-xl border border-amber-200 dark:border-amber-800 mb-5">
                            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">
                                {t('⚠️ Browser storage is not permanent')}
                            </p>
                            <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                                <BoldWords text={t("Safari clears site data after **7 days of inactivity**, and clearing browsing data wipes your local keys. Write these words on paper — it's the only offline backup that can't be wiped by your browser.")} />
                            </p>
                        </div>}

                        {hasWords ? (
                            <>
                                {/*
                                  The grid holds its height while the words load. They arrive a
                                  tick after this screen opens, and without the placeholder the
                                  panel drew as an empty box and then jumped as twelve cells
                                  appeared underneath the buttons. The words are English in every
                                  language, so the browser's page translation may not rewrite them
                                  (translate="no" + notranslate; #1947 confirmation N-B).
                                */}
                                <div data-testid="seed-words" translate="no" className="notranslate grid grid-cols-3 gap-2 mb-6 min-h-[7.5rem]">
                                    {seedWords ? seedWords.map((word, i) => (
                                        <div key={i} className="bg-oat-50 dark:bg-nature-950/60 border border-nature-200 dark:border-nature-800 rounded-xl p-2.5 text-center">
                                            <span className="text-[10px] text-nature-400 block font-mono mb-0.5">{i + 1}.</span>
                                            <span className="text-sm font-bold font-mono text-nature-900 dark:text-white">{word}</span>
                                        </div>
                                    )) : (
                                        <div className="col-span-3 flex items-center justify-center text-xs text-nature-400 animate-pulse">
                                            {t('Reading your recovery phrase…')}
                                        </div>
                                    )}
                                </div>

                                <RecoveryKitButton words={seedWords} />

                                <button
                                    onClick={handleCopySeed}
                                    className="w-full py-3 mb-2 rounded-xl font-bold bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on border-none cursor-pointer transition-colors text-sm shadow-sm"
                                >
                                    {seedCopied ? t('✅ Copied to Clipboard!') : t('📋 Copy All Words')}
                                </button>
                                <p data-testid="seed-copy-clears" className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed mb-4">
                                    {keyLineWords(WEB_COPY_CLEARS_LINE)}{' '}
                                    <span>{t("A keyboard's clipboard history or a clipboard shared with your other devices may keep a copy BeanPool can't clear.")}</span>
                                </p>
                            </>
                        ) : (
                            // Not "generated without seed phrase storage": most often it was brought back from a sign-in copy
                            // that did not carry them (web-restore.ts). What brings it back if this browser is cleared.
                            <div data-testid="seed-not-here" className="bg-amber-50 dark:bg-amber-950/30 p-4 rounded-xl text-xs leading-relaxed text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 mb-6 space-y-1.5">
                                <p className="font-bold m-0">{t("Your 12 words aren't saved in this browser, so they can't be shown here.")}</p>
                                <p className="m-0">{waysBackWithoutWords(signInRecovery)}</p>
                                <p className="m-0">{t('Browsers can clear saved data without warning: Safari does it after 7 days without a visit.')}</p>
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors text-sm"
                        >
                            {t('← Back to Settings')}
                        </button>
                    </div>
                )}



                {/* ─── MODE: DATABASE DIAGNOSTICS & HEALTH ─── */}
                {mode === 'diagnostics' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">{t('📊 Database Diagnostics & Health')}</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            {t('Transparency metrics for your local off-grid database cache. Structural check verifies zero data corruption.')}
                        </p>

                        {diagLoading ? (
                            <div className="py-10 text-center text-sm text-nature-500 dark:text-nature-400 animate-pulse">{t('Running Structural Integrity Check...')}</div>
                        ) : (
                            <>
                                {/* Status Banner */}
                                <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4 rounded-xl flex items-center justify-between mb-5">
                                    <span className="text-xs font-bold text-nature-700 dark:text-nature-300">{t('Database Status:')}</span>
                                    <span className="text-xs font-extrabold text-emerald-700 dark:text-emerald-300 px-3 py-1 bg-emerald-100 dark:bg-emerald-900/40 rounded-full border border-emerald-300 dark:border-emerald-700">
                                        {t('🟢 Healthy & Synced')}
                                    </span>
                                </div>

                                {/* Cache Metrics Grid */}
                                <div className="grid grid-cols-2 gap-3 mb-5">
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">👥</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.members ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 dark:text-nature-400 font-semibold">{t('Community Members')}</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">🛒</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.posts ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 dark:text-nature-400 font-semibold">{t('Active Posts')}</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">💸</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.transactions ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 dark:text-nature-400 font-semibold">{t('Ledger Deals')}</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">💬</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.messages ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 dark:text-nature-400 font-semibold">{t('Messages')}</div>
                                    </div>
                                </div>

                                {/* Storage info */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 mb-5 text-xs space-y-1.5">
                                    <div className="flex flex-wrap justify-between gap-x-2">
                                        <span className="text-nature-500 dark:text-nature-400">{t('Storage Usage:')}</span>
                                        <span className="font-bold text-nature-900 dark:text-white">{storageEstimate}</span>
                                    </div>
                                    <div className="flex flex-wrap justify-between gap-x-2">
                                        <span className="text-nature-500 dark:text-nature-400">{t('Active Node:')}</span>
                                        <span className="min-w-0 font-mono text-nature-900 dark:text-white break-all">{window.location.origin}</span>
                                    </div>
                                </div>

                                <button
                                    onClick={loadDiagnostics}
                                    className="w-full py-3 mb-3 rounded-xl font-bold bg-nature-900 text-white dark:bg-white dark:text-nature-900 border-none cursor-pointer text-xs"
                                >
                                    {t('🔄 Re-Run Structural Diagnostic Check')}
                                </button>

                                <button
                                    onClick={handleForceResync}
                                    className="w-full py-3 mb-6 rounded-xl font-bold bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 cursor-pointer text-xs"
                                >
                                    {t('⚡ Force Clear & Re-Sync Database')}
                                </button>
                            </>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors text-sm"
                        >
                            {t('← Back to Settings')}
                        </button>
                    </div>
                )}

                {/* ─── MODE: YOUR AREA ─── */}
                {mode === 'area' && (
                    areaLimits ? (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800" data-testid="settings-area">
                            <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-1">📍 <>{t(AREA_STEP_WORDS.settingsRow)}</></h3>
                            <p className="text-[15px] font-semibold text-nature-900 dark:text-white mb-3 break-words" data-testid="settings-area-current">{areaLine}</p>
                            {myArea && (
                                <button
                                    data-testid="settings-area-clear"
                                    onClick={clearMyArea}
                                    disabled={areaClearing}
                                    className="w-full min-h-[44px] mb-3 rounded-xl font-semibold border border-red-300 dark:border-red-800 text-red-600 dark:text-red-300 bg-transparent cursor-pointer text-sm disabled:opacity-50"
                                >
                                    {areaClearing ? t('Clearing…') : t('Clear')}
                                </button>
                            )}
                            {areaError && <p role="alert" className="text-sm text-red-600 dark:text-red-300 mb-3">{areaError}</p>}
                            <AreaStep
                                send={senderForMe}
                                limits={areaLimits}
                                hideTitle
                                skipLabel={t('← Back to Settings')}
                                onSkip={() => setMode('menu')}
                                onSaved={(a, placeName) => { rememberAreaPlace(placeName); setAreaRefusal(null); setMyArea(a); setAreaLoaded(true); setMode('menu'); }}
                            />
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800 text-center">
                            <p className="text-sm text-nature-600 dark:text-nature-400 mb-4">{t('Checking area settings…')}</p>
                            <button
                                type="button"
                                onClick={() => setMode('menu')}
                                className="px-4 py-2 bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 rounded-xl font-semibold text-sm cursor-pointer"
                            >
                                {t('← Back to Settings')}
                            </button>
                        </div>
                    )
                )}

                {/* ─── MODE: NOTIFICATION PREFERENCES ─── */}
                {mode === 'notifications' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">{t('🔔 Notification Preferences')}</h3>
                        <div className="p-3.5 mb-5 rounded-xl bg-amber-50/80 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
                            <div className="font-bold flex items-center gap-1.5 mb-1 text-amber-800 dark:text-amber-300">
                                <span>📱</span> {t('Phone App Only')}
                            </div>
                            <>{t('These preferences govern push notifications delivered to the mobile app for this account. Web browsers do not receive push notifications.')}</>
                        </div>

                        {notifLoading ? (
                            <div className="py-8 text-center text-sm text-nature-400 animate-pulse">{t('Loading preferences...')}</div>
                        ) : (
                            <div className="space-y-4 mb-6">
                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">{t('Chat Messages')}</div>
                                        <div className="text-xs text-nature-500 dark:text-nature-400">{t('Push alerts on your phone when someone messages you')}</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifChat}
                                        onChange={() => handleToggleNotif('chat')}
                                        label={t('Chat Messages Notifications')}
                                    />
                                </div>

                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">{t('Marketplace Activity')}</div>
                                        <div className="text-xs text-nature-500 dark:text-nature-400">{t('Push alerts on your phone for new offers & needs in your area')}</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifMarketplace}
                                        onChange={() => handleToggleNotif('marketplace')}
                                        label={t('Marketplace Activity Notifications')}
                                    />
                                </div>

                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">{t('Escrow & Deals')}</div>
                                        <div className="text-xs text-nature-500 dark:text-nature-400">{t('Push alerts on your phone for trade updates & credit transfers')}</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifEscrow}
                                        onChange={() => handleToggleNotif('escrow')}
                                        label={t('Escrow & Deals Notifications')}
                                    />
                                </div>

                                {/* Only where it changes something: owners and admins are always told, and a Known community never tells its members. */}
                                {knockSwitchShown(communityInfo?.features as { door?: unknown; knocks?: unknown } | undefined, nodeRole) && (
                                    <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                        <div>
                                            <div className="text-sm font-bold text-nature-900 dark:text-white">{t('Requests to join')}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t('Push alerts when someone asks to join your community')}</div>
                                        </div>
                                        <ToggleSwitch
                                            checked={notifKnocks}
                                            onChange={() => handleToggleNotif('knocks')}
                                            label={t('Requests to join notifications')}
                                        />
                                    </div>
                                )}

                                {/* Event reminders (decision 2). Ticks rather than switches: this is one
                                    setting with several answers, and "Off" is one of them, not a fourth
                                    category of alert. It travels on the Marketplace category, so it only
                                    reaches a phone with that switch on — which the line below says. */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1">
                                        <legend className="text-sm font-bold text-nature-900 dark:text-white p-0">{t('Event reminders')}</legend>
                                        <p className="m-0 mb-3 text-xs text-nature-500 dark:text-nature-400">
                                            {t('How long before an event you are going to, or interested in, starts. You can change it on any one event.')}
                                        </p>
                                        {REMINDER_OFFSETS.map(minutes => (
                                            <label key={minutes} className="flex items-center gap-2 min-h-[48px] text-sm font-semibold text-nature-800 dark:text-nature-200 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    className="w-5 h-5 accent-nature-700"
                                                    checked={eventReminders.includes(minutes)}
                                                    onChange={() => handleToggleReminder(minutes)}
                                                />
                                                {reminderBeforeWords(minutes)}
                                            </label>
                                        ))}
                                        <label className="flex items-center gap-2 min-h-[48px] text-sm font-semibold text-nature-800 dark:text-nature-200 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="w-5 h-5 accent-nature-700"
                                                checked={eventReminders.length === 0}
                                                onChange={() => { if (eventReminders.length > 0) handleRemindersOff(); }}
                                            />
                                            {t('Off', undefined, 'event reminders')}
                                        </label>
                                    </fieldset>
                                    <p className="m-0 mt-2 text-xs text-nature-500 dark:text-nature-400">
                                        {t('Reminders arrive with your Marketplace alerts, so they stop if you switch those off.')}
                                    </p>
                                </div>
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors text-sm"
                        >
                            {t('← Back to Settings')}
                        </button>
                    </div>
                )}

                {/* ─── MODE: SUGGEST A CHANGE TO BEANPOOL ─── */}
                {mode === 'suggest' && (
                    <SuggestChangeForm appVersion={__APP_VERSION__} onDone={() => setMode('menu')} />
                )}

                {/* ─── MODE: BLOCKED MEMBERS ─── */}
                {mode === 'blocked-users' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">{t('🚫 Blocked Members')}</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            {t('Members you have blocked cannot message you, and their posts and profiles are hidden from your feed. Your community keeps this list with your account, so it comes back when you sign in on any browser. Its operator can see it.')}
                        </p>

                        {blockedListError && (
                            <div role="alert" className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-xs leading-relaxed">
                                <p className="mb-2">{blockedListError}</p>
                                <button
                                    type="button"
                                    onClick={() => loadBlockedList()}
                                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-nature-900 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 font-bold cursor-pointer"
                                >
                                    {t('Try again')}
                                </button>
                            </div>
                        )}
                        {blockedActionError && (
                            <p role="alert" className="mb-4 text-xs font-semibold text-red-600 dark:text-red-300 leading-relaxed">{blockedActionError}</p>
                        )}
                        {blockedFullNote && (
                            <p role="status" className="mb-4 text-xs font-semibold text-nature-700 dark:text-nature-300 leading-relaxed">{blockedFullNote}</p>
                        )}

                        {loadingBlockedList ? (
                            <div className="py-8 text-center text-sm text-nature-400 animate-pulse">{t('Loading blocked members...')}</div>
                        ) : blockedUsersList.length === 0 && blockedListError ? null : blockedUsersList.length === 0 ? (
                            <div className="text-center py-10 text-nature-500 dark:text-nature-400">
                                <p className="text-3xl mb-2">🕊️</p>
                                <p className="text-sm font-semibold text-nature-800 dark:text-white">{t('No blocked members')}</p>
                                <p className="text-xs mt-1 text-nature-500 dark:text-nature-400">{t("You haven't blocked anyone yet.")}</p>
                            </div>
                        ) : (
                            <div className="space-y-4 mb-6">
                                <div className="divide-y divide-nature-100 dark:divide-nature-800 rounded-xl border border-nature-200 dark:border-nature-800 overflow-hidden">
                                    {blockedUsersList.map(item => (
                                        <div key={item.pubkey} className="p-3.5 hover:bg-oat-50/50 dark:hover:bg-nature-800/30 transition-colors">
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-sm font-bold text-nature-900 dark:text-white truncate">
                                                        {item.callsign}
                                                    </div>
                                                    <div className="text-[11px] text-nature-400 dark:text-nature-300 font-mono truncate">
                                                        {item.pubkey.slice(0, 16)}...{item.pubkey.slice(-8)}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => unblockFromList(item.pubkey)}
                                                    disabled={blockedBusy !== null}
                                                    className="bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-800 rounded-lg px-3 py-1.5 text-xs font-bold hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors cursor-pointer shrink-0 disabled:opacity-60 disabled:cursor-default"
                                                >
                                                    {blockedBusy === item.pubkey ? t('Unblocking…') : t('Unblock')}
                                                </button>
                                            </div>
                                            {blockedFriends.has(item.pubkey) ? (
                                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                                    <p className="text-xs text-nature-600 dark:text-nature-300 m-0">{t('Still your friend. They can notice a removal.')}</p>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeBlockedFriend(item.pubkey, item.callsign || item.pubkey.slice(0, 8))}
                                                        disabled={blockedBusy !== null}
                                                        className="bg-oat-100 dark:bg-nature-800 text-nature-800 dark:text-nature-100 border border-nature-300 dark:border-nature-600 rounded-lg px-3 py-1.5 text-xs font-bold hover:bg-oat-200 dark:hover:bg-nature-700 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                                                    >
                                                        {blockedBusy === `friend:${item.pubkey}` ? t('Removing…') : t('Also remove from friends')}
                                                    </button>
                                                </div>
                                            ) : removedFriends.has(item.pubkey) ? (
                                                <p className="mt-2 text-xs text-nature-600 dark:text-nature-300 m-0">{t('No longer your friend. Still blocked.')}</p>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>

                                <button
                                    type="button"
                                    onClick={unblockEveryone}
                                    disabled={blockedBusy !== null}
                                    className="w-full py-2.5 rounded-xl text-xs font-bold text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
                                >
                                    {blockedBusy === 'all' ? t('Unblocking…') : t('Unblock All')}
                                </button>
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors text-sm"
                        >
                            {t('← Back to Settings')}
                        </button>
                    </div>
                )}

                {/* ─── MODE: ADVANCED / SUBSYSTEM ─── */}
                {mode === 'advanced' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-3 m-0">{t('⚙️ Advanced Settings')}</h3>
                        <p className="text-nature-600 dark:text-nature-400 text-xs mb-5 leading-relaxed">
                            {t('Manage referral connections and client-side database/state cache sync.')}
                        </p>

                        {/* Node Connection: the editor in a development build; a stored address said, with Reset, in any build */}
                        {(showNodeUrlEditor || storedNodeUrl) && (
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            {showNodeUrlEditor ? (
                                <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">{t('🌐 Sovereign Node Connection')}</h4>
                            ) : (
                                <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">{t('Community address')}</h4>
                            )}
                            {storedNodeUrl && (
                                <div className="mb-3">
                                    <p className="text-xs text-nature-700 dark:text-nature-300 leading-relaxed mb-2 mt-0 break-words">
                                        {t('This browser is set to use the community at {address}.', { address: storedNodeUrl })}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={handleResetNodeUrl}
                                        className="w-full py-2.5 rounded-xl text-xs font-bold bg-oat-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 border-none cursor-pointer"
                                    >
                                        {t('Reset to this page’s community')}
                                    </button>
                                </div>
                            )}
                            {showNodeUrlEditor && (<>
                            <input
                                type="text"
                                value={customNodeUrl}
                                onChange={(e) => { setCustomNodeUrl(e.target.value); setNodeTestResult(null); }}
                                placeholder={t('Node API URL (e.g. https://mullum1.beanpool.org)')}
                                className="w-full py-2.5 px-4 mb-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white font-mono text-xs"
                                autoCapitalize="none"
                            />
                            {nodeTestResult && (
                                <div className={`p-3 rounded-xl mb-3 text-xs font-mono border ${nodeTestResult.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800' : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900'}`}>
                                    {nodeTestResult.ok ? t('✅ Connected to "{name}" ({ms}ms)', { name: nodeTestResult.callsign ?? '', ms: nodeTestResult.latencyMs ?? '' }) : `❌ ${nodeTestResult.error}`}
                                </div>
                            )}
                            <div className="flex gap-2">
                                <button
                                    onClick={handleTestNodeConnection}
                                    disabled={testingNode || !customNodeUrl.trim()}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-oat-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 border-none cursor-pointer"
                                >
                                    {testingNode ? t('Testing...') : t('🧪 Test')}
                                </button>
                                <button
                                    onClick={handleSaveNodeUrl}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-nature-900 dark:bg-white text-white dark:text-nature-900 border-none cursor-pointer"
                                >
                                    {t('💾 Save & Connect')}
                                </button>
                            </div>
                            </>)}
                        </div>
                        )}

                        {/* Private Key Reveal */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">{t('🔑 Raw Private Key')}</h4>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-nature-500 dark:text-nature-400">{t('View underlying Ed25519 secret seed')}</span>
                                <button
                                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                                    className="text-xs font-bold text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-1 rounded-lg border border-terra-200 cursor-pointer"
                                >
                                    {showPrivateKey ? t('Hide') : t('Reveal')}
                                </button>
                            </div>
                            {showPrivateKey && (
                                <div className="text-[11px] font-mono text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-3 rounded-xl border border-red-200 dark:border-red-800 break-all select-all">
                                    {identity.privateKey}
                                </div>
                            )}
                        </div>

                        {/* Redeem Invite */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">{t('🎟️ Redeem Invite Code')}</h4>
                            <input
                                type="text"
                                value={redeemInviteCode}
                                onChange={(e) => setRedeemInviteCode(e.target.value)}
                                placeholder={t('Enter Invite Code (e.g. BP-7K3X-9M2W)')}
                                className="w-full py-2.5 px-4 mb-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white font-mono text-xs"
                            />
                            <button
                                onClick={handleRedeemInvite}
                                disabled={redeemLoading || !redeemInviteCode.trim()}
                                className="w-full py-2.5 rounded-xl font-bold bg-nature-900 text-white dark:bg-white dark:text-nature-900 border-none cursor-pointer text-xs"
                            >
                                {redeemLoading ? t('Redeeming...') : t('Redeem Code')}
                            </button>
                        </div>

                        {error && <p className="text-red-500 dark:text-red-300 text-xs mb-3">{error}</p>}
                        {success && <p className="text-emerald-600 dark:text-emerald-400 text-xs mb-3">{success}</p>}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer text-sm"
                        >
                            {t('← Back to Settings')}
                        </button>
                    </div>
                )}

                {/* ─── MODE: PROFILE EDITOR ─── */}
                {mode === 'profile' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-soft border border-nature-200 dark:border-nature-800 overflow-hidden transition-colors">
                        <ProfilePage
                            identity={identity}
                            onBack={() => {
                                setMode('menu');
                                getMemberProfile(identity.publicKey).then(setProfile).catch(() => {});
                            }}
                            onIdentityUpdated={onIdentityUpdated}
                        />
                    </div>
                )}



                <ArchetypeQuizModal
                    visible={showQuizModal}
                    initialMode={quizInitialMode}
                    onClose={() => setShowQuizModal(false)}
                    onComplete={handleQuizComplete}
                />
            </div>
        </div>
    );
}

/**
 * Settings → BeanPool: Help & how it works, Suggest a change (hidden while FEEDBACK_LIVE is false), beanpool.org,
 * Use the phone app (both), Install on this computer (desktop only).
 * The rows come from beanPoolSettingsEntries in @beanpool/core, the same list the member app's Settings uses.
 */
export function BeanPoolSettingsGroup({ onHelp, onSuggest, feedbackLive = FEEDBACK_LIVE, globalCommunity = null, phoneLater = null }: {
    onHelp: () => void; onSuggest: () => void; feedbackLive?: boolean;
    /** The global community this node names (lib/global-entry.ts globalCommunityLink): a row of its own. Null: none. */
    globalCommunity?: { href: string; host: string } | null;
    /** How to restore on phone (lib/global-entry.ts phoneLaterLines) */
    phoneLater?: string[] | null;
}) {
    const isPhone = usePhoneBrowser();
    const installed = isInstalled();
    const deferredPrompt = useDeferredInstallPrompt();
    const [showPhoneApp, setShowPhoneApp] = useState(false);
    const [showInstallSteps, setShowInstallSteps] = useState(false);

    const handleDesktopInstall = async () => {
        if (deferredPrompt) {
            try {
                await deferredPrompt.prompt();
                await deferredPrompt.userChoice;
            } catch {
                // Dismissed or prompt error
            } finally {
                clearDeferredPrompt();
            }
        } else {
            setShowInstallSteps(prev => !prev);
        }
    };

    const rowClass = 'w-full min-h-[56px] p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center gap-3 hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors bg-transparent border-none cursor-pointer text-left no-underline';
    return (
        <div>
            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">
                {t('BEANPOOL')}
            </div>
            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden divide-y divide-nature-100 dark:divide-nature-800">
                {beanPoolSettingsEntries(feedbackLive).map(entry => {
                    if (entry === 'help') return (
                        <button key={entry} type="button" onClick={onHelp} className={rowClass} aria-label={t('BeanPool: help and how it works')}>
                            <span className="text-xl" aria-hidden="true">🫘</span>
                            <span className="flex-1 min-w-0">
                                <span className="block">{t('Help & how it works')}</span>
                                <span className="block text-xs font-normal text-nature-600 dark:text-nature-300">{t('How to use every part of the app, the rules, questions')}</span>
                            </span>
                            <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">›</span>
                        </button>
                    );
                    if (entry === 'suggest') return (
                        <button key={entry} type="button" onClick={onSuggest} className={rowClass}>
                            <span className="text-xl" aria-hidden="true">💬</span>
                            <span className="flex-1 min-w-0">
                                <span className="block">{t('Suggest a change')}</span>
                                <span className="block text-xs font-normal text-nature-600 dark:text-nature-300">{t('Ideas and problems go to the BeanPool project team')}</span>
                            </span>
                            <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">›</span>
                        </button>
                    );
                    return (
                        <a key={entry} href={BEANPOOL_WEBSITE_URL} target="_blank" rel="noopener noreferrer" className={rowClass} aria-label={t('beanpool.org, opens in a new tab')}>
                            <span className="text-xl" aria-hidden="true">🌐</span>
                            <span className="flex-1 min-w-0">
                                <span className="block">{BEANPOOL_DOMAIN}</span>
                                <span className="block text-xs font-normal text-nature-600 dark:text-nature-300">{t('The BeanPool project website')}</span>
                            </span>
                            <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">↗</span>
                        </a>
                    );
                })}
                {globalCommunity && (
                    <a href={globalCommunity.href} target="_blank" rel="noopener noreferrer" className={rowClass} data-testid="settings-global-community"
                        aria-label={t('Global community, {address}, opens in a new tab', { address: globalCommunity.host })}
                        aria-describedby="settings-global-community-about">
                        <span className="text-xl" aria-hidden="true">🌍</span>
                        <span className="flex-1 min-w-0">
                            <span className="block">{t('Global community')}</span>
                            <span className="block text-xs font-normal text-nature-600 dark:text-nature-300 break-words">{globalCommunity.host}</span>
                            {/* What it is, in members' words (DESIGN-global-mothership-fable.md §2.5, pick 1). */}
                            <span id="settings-global-community-about" className="block mt-0.5 text-xs font-normal text-nature-600 dark:text-nature-300">
                                {t('The global community is one community among many. Your own community runs on its own server and never needs it.')}
                            </span>
                        </span>
                        <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">↗</span>
                    </a>
                )}
                {/* Use the phone app (front doors S4): both phone and computer */}
                <div>
                    <button
                        type="button"
                        onClick={() => setShowPhoneApp(prev => !prev)}
                        className={rowClass}
                        data-testid="settings-use-phone-app"
                        aria-expanded={showPhoneApp}
                    >
                        <span className="text-xl" aria-hidden="true">📲</span>
                        <span className="flex-1 min-w-0">
                            <span className="block">{t('Use the phone app')}</span>
                            <span className="block text-xs font-normal text-nature-600 dark:text-nature-300">{t('Your account comes with you.')}</span>
                        </span>
                        <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">{showPhoneApp ? '▾' : '›'}</span>
                    </button>
                    {showPhoneApp && (
                        <div className="p-4 bg-nature-50 dark:bg-nature-950/50" data-testid="settings-use-phone-app-details">
                            <StoreBadges />
                            <ApkDownloadLink />
                            {phoneLater && phoneLater.length > 0 && (
                                <div className="mt-3 space-y-1 text-xs text-nature-600 dark:text-nature-300">
                                    {phoneLater.map((line, i) => (
                                        <p key={i} className="m-0 leading-relaxed">
                                            <BoldWords text={line} />
                                        </p>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {/* Install on this computer (front doors S4): desktop only */}
                {!isPhone && !installed && (
                    <div>
                        <button
                            type="button"
                            onClick={handleDesktopInstall}
                            className={rowClass}
                            data-testid="settings-install-computer"
                            aria-expanded={showInstallSteps}
                        >
                            <span className="text-xl" aria-hidden="true">💻</span>
                            <span className="flex-1 min-w-0">
                                <span className="block">{t('Install on this computer')}</span>
                            </span>
                            <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">
                                {deferredPrompt ? '↗' : (showInstallSteps ? '▾' : '›')}
                            </span>
                        </button>
                        {showInstallSteps && (
                            <div className="p-4 bg-nature-50 dark:bg-nature-950/50">
                                <DesktopInstallSteps />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
