/**
 * RecoveryAlertBanner — someone is getting back into this account.
 *
 * Two sources, each read in the background so nothing waits for them: a slow or unreachable one shows nothing.
 *
 * - **BeanPool's key vault** (`/v1/copies/status`, utils/vault.ts), in a build that has one: a sign-in restore of this
 *   account, waiting (D2: every sign-in restore waits a day). Read when the banner first shows, when the app comes back
 *   to the front, and after a Stop or "Yes, it's me" that didn't go through: never on a timer, and never for a member
 *   the phone knows has no copy at the vault (`vaultCopyKnowledge` 'none'; PR #1336 review finding 1). The vault is off the
 *   everyday path (Marty, 2026-09-28). Two answers, each confirmed first:
 *     - **Stop**: it is never released. Whoever started it gets nothing, and has to use the 12 words.
 *     - **Yes, it's me**: it goes through now, to the phone or computer that asked. Behind the phone's lock, since it
 *       hands the account to another device.
 * - **The member's community** (`/api/recovery/collect/mine`): a restore at a community that keeps a sign-in copy
 *   (every copy, in a build without a vault; old ones until the date they are removed, in a build with one, key vault
 *   design §5.1). Watched every ~30 s while the app is in front, as before the vault. The community sends how many
 *   sessions are live and the newest few, never all of them: strangers can open any number. Stop It Now stops every
 *   one in a single request (stopEveryRecoverySession), and says "all cancelled" only when the community says none is
 *   left (PR #1456 deciding review).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, AppState, type AppStateStatus } from 'react-native';
import { palette } from '../constants/colors';
import { signedRequest } from '../utils/db';
import { withJitter } from '../utils/jitter';
import { useIdentity } from '../app/IdentityContext';
import { authenticateUser } from '../utils/LocalAuth';
import { SSO_PROVIDER_NAMES } from '../utils/sso-providers';
import {
    approvedHolds, approveVaultHold, forgetEndedApprovals, hasVault, holdAnswerIsFinal, holdEndsText, stopVaultHold, vaultCopyKnowledge,
    vaultStatus,
    type VaultHold,
} from '../utils/vault';

export const RECOVERY_ALERT_COPY = {
    /** The title over a final answer to a Stop or "Yes, it's me" (utils/vault.ts `holdAnswerIsFinal`). */
    finalTitle: (e: unknown) => {
        const code = (e as { code?: string } | null)?.code;
        return code === 'collected' ? 'Already gone through' : code === 'stopped' ? 'Already stopped' : 'No longer waiting';
    },
    /** After Stop It Now, in the community's own count of what is still live (stopEveryRecoverySession). */
    stoppedTitle: (left: number) => (left === 0 ? '✅ Recovery Stopped' : 'Not all stopped'),
    stoppedBody: (left: number) => (left === 0
        ? 'All active recovery sessions have been cancelled.'
        : `${left} recovery session${left === 1 ? ' is' : 's are'} still active. Tap Stop It Now again.`),
    approvedTitle: 'Let through',
    approvedBody: (name: string) => `You let the restore with ${name} through. Your other phone or computer gets your account `
        + 'the next time it checks.',
} as const;

interface RecoverySession {
    collectionId: string;
    requester: string;
    /** Wire field name from POST /api/recovery/collect/mine. There is no `createdAt`. */
    startedAt: string;
}

/** Sends one signed request to the member's community and returns its answer; throws when it refuses. */
type CommunityRequest = (path: string, body: Record<string, unknown>) => Promise<any>;

/**
 * Stop every live recovery against this account, and say how many are still live afterwards, by the community's count.
 *
 * One request: the community stops them all (`/collect/cancel` with no session named), however many strangers
 * opened, and answers with `live`. A community from before that refuses a Stop that names no session: then one per
 * listed session, as before (such a community lists every one, and holds at most ten), and what is left is the number
 * that failed.
 */
export async function stopEveryRecoverySession(listed: { collectionId: string }[], request: CommunityRequest): Promise<number> {
    try {
        const res = await request('/api/recovery/collect/cancel', {});
        if (typeof res?.live === 'number') return res.live;
    } catch {
        // An older community ('Which session?'), or no answer: one by one below.
    }
    let failed = 0;
    for (const session of listed) {
        try {
            await request('/api/recovery/collect/cancel', { collectionId: session.collectionId });
        } catch (e) {
            failed++;
            console.warn(`[RecoveryAlert] Failed to cancel session ${session.collectionId}:`, (e as Error).message);
        }
    }
    return failed;
}

export interface RecoveryAlertBannerProps {
    onStopSuccess?: () => void;
}

export function RecoveryAlertBanner({ onStopSuccess }: RecoveryAlertBannerProps = {}): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [sessions, setSessions] = useState<RecoverySession[]>([]);
    /** How many are live, by the community's count: more than `sessions`, which holds the newest few. */
    const [liveCount, setLiveCount] = useState(0);
    const [holds, setHolds] = useState<VaultHold[]>([]);
    /** Holds this phone let through ("Yes, it's me"): shown as let through until the other device collects, no buttons. */
    const [approved, setApproved] = useState<string[]>([]);
    const [stopping, setStopping] = useState(false);
    /** The hold an answer is on its way for, so its buttons can't be tapped twice. */
    const [busyHold, setBusyHold] = useState<string | null>(null);

    const fetchSessions = useCallback(async () => {
        try {
            const res = await signedRequest('/api/recovery/collect/mine', {});
            if (res?.collections && Array.isArray(res.collections)) {
                // The route returns ONLY open collections — openCollectionsFor filters at
                // query time — and sends no `status` field at all. Filtering on
                // `c.status === 'open'` therefore matched nothing and this banner never
                // rendered, on any node, ever. Take the rows as given.
                const active: RecoverySession[] = res.collections.map((c: any) => ({
                    collectionId: c.collectionId,
                    requester: c.requester || '',
                    startedAt: c.startedAt,
                }));
                setSessions(active);
                // A community from before the count lists every one.
                setLiveCount(typeof res.count === 'number' ? res.count : active.length);
            }
        } catch (e) {
            // Swallow — this is a best-effort check. If the endpoint doesn't exist
            // (older node), we just don't show the banner.
            console.warn('[RecoveryAlert] Failed to check active sessions:', (e as Error).message);
        }
    }, []);

    const fetchHolds = useCallback(async () => {
        // Only a build with a vault, and never for an account the phone knows has no copy there.
        if (!identity || !hasVault() || (await vaultCopyKnowledge(identity.publicKey)) === 'none') return;
        try {
            const listed = (await vaultStatus(identity)).holds;
            await forgetEndedApprovals(identity.publicKey, listed);
            setApproved(await approvedHolds(identity.publicKey));
            setHolds(listed);
        } catch (e) {
            // Best effort, like the community's: a paused or unreachable vault shows nothing, and is asked again.
            console.log('[RecoveryAlert] The key vault could not say:', (e as Error).message);
        }
    }, [identity]);

    // The vault: once now, and once each time the app comes back to the front. No interval.
    useEffect(() => {
        void fetchHolds();
        const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
            if (next === 'active') void fetchHolds();
        });
        return () => sub.remove();
    }, [fetchHolds]);

    // The community: watched while the app is in front, as before the vault.
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!interval) {
                void fetchSessions();
                interval = setInterval(() => { void fetchSessions(); }, withJitter(30_000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleAppStateChange = (nextState: AppStateStatus) => {
            if (nextState === 'active') {
                startPolling();
            } else {
                stopPolling();
            }
        };

        if (AppState.currentState === 'active') {
            startPolling();
        }

        const sub = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            stopPolling();
            sub.remove();
        };
    }, [fetchSessions]);

    const handleStopIt = useCallback(async () => {
        Alert.alert(
            '🛑 Stop Recovery Attempt',
            'This will cancel all active recovery sessions, preventing any further fragment releases.\n\n'
            + 'Do this only if you did NOT start this recovery.',
            [
                { text: 'Keep Watching', style: 'cancel' },
                {
                    text: 'Stop It Now',
                    style: 'destructive',
                    onPress: async () => {
                        setStopping(true);
                        try {
                            const left = await stopEveryRecoverySession(sessions, signedRequest);
                            if (left === 0) {
                                // Stopped sessions hand nothing more over. If onStopSuccess is provided, notify
                                // parent view to refresh protection state.
                                setSessions([]);
                                setLiveCount(0);
                                onStopSuccess?.();
                            } else {
                                // Not "all cancelled" when some are not: read again, so the banner shows what is live.
                                void fetchSessions();
                            }
                            Alert.alert(RECOVERY_ALERT_COPY.stoppedTitle(left), RECOVERY_ALERT_COPY.stoppedBody(left));
                        } catch (e) {
                            Alert.alert('Error', 'Failed to stop recovery. Please try again.');
                        } finally {
                            setStopping(false);
                        }
                    },
                },
            ],
        );
    }, [sessions, fetchSessions, onStopSuccess]);

    const handleStopHold = useCallback((hold: VaultHold) => {
        if (!identity) return;
        const name = SSO_PROVIDER_NAMES[hold.provider];
        Alert.alert(
            'Stop it?',
            `The restore with ${name} won't go through, and whoever started it gets nothing. If it was you after all, use your 12 words on that phone.`,
            [
                { text: 'Keep waiting', style: 'cancel' },
                {
                    text: 'Stop it',
                    style: 'destructive',
                    onPress: async () => {
                        setBusyHold(hold.holdId);
                        try {
                            await stopVaultHold(identity, hold.holdId);
                            setHolds(h => h.filter(x => x.holdId !== hold.holdId));
                            onStopSuccess?.();
                            Alert.alert('Stopped', `The restore with ${name} won't go through. To be safe, check that your ${name} account's password is one only you know.`);
                        } catch (e) {
                            // Too late (collected), already stopped, or gone: a final answer, never "try again".
                            if (holdAnswerIsFinal(e)) Alert.alert(RECOVERY_ALERT_COPY.finalTitle(e), (e as Error).message);
                            else Alert.alert('Not stopped', `${(e as Error).message} Try again.`);
                            void fetchHolds();
                        } finally {
                            setBusyHold(null);
                        }
                    },
                },
            ],
        );
    }, [identity, fetchHolds, onStopSuccess]);

    const handleApproveHold = useCallback((hold: VaultHold) => {
        if (!identity) return;
        const name = SSO_PROVIDER_NAMES[hold.provider];
        Alert.alert(
            'Was it you?',
            `Only if you started getting back into BeanPool with ${name} on another phone or computer yourself. Your account goes there now.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: "Yes, it's me",
                    onPress: async () => {
                        // It hands the account to another device: the phone's lock first, as linking a sign-in asks.
                        if (!(await authenticateUser("Confirm it's you to let your account through to your other device."))) return;
                        setBusyHold(hold.holdId);
                        try {
                            await approveVaultHold(identity, hold.holdId);
                            setApproved(a => [...a, hold.holdId]);
                            Alert.alert('Let through', 'Your other phone or computer gets your account the next time it checks, in about a minute.');
                        } catch (e) {
                            if (holdAnswerIsFinal(e)) Alert.alert(RECOVERY_ALERT_COPY.finalTitle(e), (e as Error).message);
                            else Alert.alert('Not let through', `${(e as Error).message} Try again.`);
                            void fetchHolds();
                        } finally {
                            setBusyHold(null);
                        }
                    },
                },
            ],
        );
    }, [identity, fetchHolds]);

    if (sessions.length === 0 && holds.length === 0) return null;

    return (
        <View>
            {holds.map((hold) => {
                const name = SSO_PROVIDER_NAMES[hold.provider];
                const busy = busyHold === hold.holdId;
                if (approved.includes(hold.holdId)) {
                    // Let through from here: nothing left to answer, so no Stop and no "Yes, it's me" again.
                    return (
                        <View key={hold.holdId} style={styles.approved} accessibilityLiveRegion="polite">
                            <Text style={styles.approvedTitle} accessibilityRole="header">{RECOVERY_ALERT_COPY.approvedTitle}</Text>
                            <Text style={styles.approvedBody}>{RECOVERY_ALERT_COPY.approvedBody(name)}</Text>
                        </View>
                    );
                }
                return (
                    <View key={hold.holdId} style={styles.container} accessibilityLiveRegion="assertive">
                        <View style={styles.header}>
                            <Text style={styles.icon} importantForAccessibility="no" accessibilityElementsHidden={true}>🚨</Text>
                            <Text style={styles.title} accessibilityRole="header">Someone is getting back into your account</Text>
                        </View>
                        <Text style={styles.body}>
                            Someone used {name} to get back into your BeanPool account on another device. It goes through {holdEndsText(hold.releaseAt)} unless you stop it.
                        </Text>
                        <Text style={styles.detail}>
                            Started {new Date(hold.openedAt).toLocaleString()}
                        </Text>
                        <TouchableOpacity
                            style={styles.stopButton}
                            onPress={() => handleStopHold(hold)}
                            disabled={busy}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            // The visible text, so a speech-control user saying "tap Stop" hits it (WCAG 2.5.3).
                            accessibilityLabel={busy ? 'Working' : 'Stop'}
                            accessibilityHint={`Stops the restore with ${name}`}
                            accessibilityState={{ disabled: busy, busy }}
                        >
                            {busy ? <ActivityIndicator size="small" color={palette.white} /> : <Text style={styles.stopButtonText}>🛑 Stop</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.itsMeButton}
                            onPress={() => handleApproveHold(hold)}
                            disabled={busy}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel="Yes, it's me"
                            accessibilityHint="Lets your account through to your other device now"
                            accessibilityState={{ disabled: busy }}
                        >
                            <Text style={styles.itsMeButtonText}>Yes, it's me</Text>
                        </TouchableOpacity>
                    </View>
                );
            })}

            {sessions.length > 0 && (
                <View style={styles.container} accessibilityLiveRegion="assertive">
                    <View style={styles.header}>
                        <Text style={styles.icon} importantForAccessibility="no" accessibilityElementsHidden={true}>🚨</Text>
                        <Text style={styles.title} accessibilityRole="header">Someone is recovering your account</Text>
                    </View>
                    <Text style={styles.body}>
                        A device is trying to restore access to your account.
                        If this is not you, stop it immediately.
                    </Text>
                    <Text style={styles.detail}>
                        {liveCount} active session{liveCount > 1 ? 's' : ''}
                        {sessions[0].startedAt ? ` • Started ${new Date(sessions[0].startedAt).toLocaleString()}` : ''}
                    </Text>
                    <TouchableOpacity
                        style={styles.stopButton}
                        onPress={handleStopIt}
                        disabled={stopping}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        // Must be the VISIBLE text: this is the emergency control, and a speech-
                        // control user saying "tap Stop It Now" has to hit it (WCAG 2.5.3).
                        accessibilityLabel={stopping ? 'Stopping recovery' : 'Stop It Now'}
                        accessibilityHint="Cancels active recovery sessions"
                        accessibilityState={{ disabled: stopping, busy: stopping }}
                    >
                        {stopping ? (
                            <ActivityIndicator size="small" color={palette.white} />
                        ) : (
                            <Text style={styles.stopButtonText}>🛑 Stop It Now</Text>
                        )}
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    approved: {
        backgroundColor: palette.white,
        borderWidth: 1,
        borderColor: palette.red300,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
    },
    approvedTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: palette.red800,
        marginBottom: 6,
    },
    approvedBody: {
        fontSize: 13,
        color: palette.red700,
        lineHeight: 19,
    },
    container: {
        backgroundColor: palette.red50,
        borderWidth: 1,
        borderColor: palette.red300,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
    },
    icon: {
        fontSize: 20,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
        color: palette.red800,
        flex: 1,
    },
    body: {
        fontSize: 13,
        color: palette.red700,
        lineHeight: 19,
        marginBottom: 6,
    },
    detail: {
        fontSize: 11,
        color: palette.red500,
        marginBottom: 12,
    },
    stopButton: {
        backgroundColor: palette.red600,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 20,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    stopButtonText: {
        color: palette.white,
        fontSize: 15,
        fontWeight: '700',
    },
    itsMeButton: {
        marginTop: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: palette.red300,
        paddingVertical: 12,
        paddingHorizontal: 20,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    itsMeButtonText: {
        color: palette.red800,
        fontSize: 15,
        fontWeight: '600',
    },
});
