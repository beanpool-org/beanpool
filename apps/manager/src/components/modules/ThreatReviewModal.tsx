import React, { useState, useMemo } from 'react';
import { getMemberDisplayName } from './MembersModule';
import type { NodeProfile } from '../../lib/profiles';
import { useTimeout } from '../../lib/use-timeout';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { reportSubject } from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import { FLAG_WORDS as W, flagAction, flagHeading, flagMembers, flagOffersFreeze } from '../../lib/flag-words';
import type { RolesViewer } from './NodeRolesPanel';

export interface ThreatItem {
    id?: string;
    type?: string;
    severity?: 'critical' | 'alert' | 'warning' | 'info' | string;
    description?: string;
    reason?: string;
    /** A health flag: the public keys the node names (shown as names). */
    members?: unknown;
    isReport?: boolean;
    targetPubkey?: string;
    /** A report on a post: the post, and its author as the node read it from the post (who a freeze acts on). */
    postId?: string | null;
    postAuthorPubkey?: string | null;
    /** A report on a Pulse item: about the item's owner, whatever post id it carries. */
    targetPulseItemId?: string;
    pulseItem?: unknown;
}

export interface MemberItem {
    publicKey?: string;
    pubkey?: string;
    displayName?: string;
    name?: string;
    handle?: string;
    [key: string]: unknown;
}

interface ThreatReviewModalProps {
    threat: ThreatItem;
    profiles?: NodeProfile[];
    members?: MemberItem[];
    frozenPubkeys?: string[] | Set<string>;
    onClose: () => void;
    onDismiss?: (threat: ThreatItem) => void;
    /** Tells the node a member report was reviewed. Awaited before the modal dismisses; a throw keeps it open. */
    onDismissReport?: (threat: ThreatItem) => Promise<unknown>;
    /**
     * Freezes the involved members. Awaited: a throw keeps the modal open with the error. Freezing
     * does not settle a member report, so after it the modal closes (onClose) rather than dismissing.
     */
    onFreezePubkeys?: (pubkeys: string[]) => void | Promise<unknown>;
    onInspectMember?: (member: MemberItem) => void;
    /**
     * Who is looking. A key session is told, per member, who the node won't let them freeze (never their own account, and
     * only an owner an owner: server state-engine creditFreezeRefusal), and Freeze sends only the others. Unknown (a test,
     * a caller that doesn't say): the node decides alone, as before.
     */
    viewer?: RolesViewer;
}

/** Why the viewer can't freeze this member, or null when they can (or the window doesn't know who is looking). */
function cantFreezeReason(viewer: RolesViewer | undefined, pubkey: string, member: MemberItem | undefined): 'self' | 'owner' | null {
    if (viewer?.kind !== 'key') return null;
    if (pubkey === viewer.memberPubkey) return 'self';
    const role = member?.nodeRole ?? member?.role;
    if (role === 'owner' && viewer.role !== 'owner') return 'owner';
    return null;
}

export function ThreatReviewModal({
    threat,
    profiles = [],
    members = [],
    frozenPubkeys,
    onClose,
    onDismiss,
    onDismissReport,
    onFreezePubkeys,
    onInspectMember,
    viewer
}: ThreatReviewModalProps) {
    const [actionState, setActionState] = useState<string | null>(null);
    const [dismissing, setDismissing] = useState(false);
    const [dismissError, setDismissError] = useState<string | null>(null);
    const [freezing, setFreezing] = useState(false);
    const [copiedLog, setCopiedLog] = useState(false);
    const copiedLogTimer = useTimeout();

    // ⚡ Bolt: Pre-compute Map for O(1) member lookups by exact key or prefix token
    const membersMap = useMemo(() => {
        const map = new Map<string, MemberItem>();
        for (const m of members) {
            const pk = m.publicKey || m.pubkey || '';
            if (pk) {
                map.set(pk, m);
                // Store prefix keys (e.g. wash1-17 from wash1-1784649...)
                const dashIdx = pk.indexOf('-');
                if (dashIdx !== -1) {
                    const secondDash = pk.indexOf('-', dashIdx + 1);
                    const prefix = pk.substring(0, secondDash !== -1 ? secondDash : pk.length);
                    if (prefix && !map.has(prefix)) map.set(prefix, m);
                }
            }
        }
        return map;
    }, [members]);

    const isReport = threat?.isReport || threat?.targetPubkey !== undefined;
    const severity = threat?.severity || (isReport ? 'warning' : 'critical');
    const title = isReport ? t(W.reportHeading) : flagHeading(threat);
    const description = threat?.description || threat?.reason || t(W.noDetail);
    // Freeze is a report's action, or a flag that shows real harm (wash trading, a sybil ring or funnel).
    const canFreeze = isReport || flagOffersFreeze(threat);

    // The members involved: a report's subject, else the flag's own list of members, else (a node that sent no list at all)
    // the keys read out of its description. Resolved to full keys from the roster; shown by name, never as a key.
    const extractPubkeys = (): string[] => {
        let rawKeys: string[] = [];
        if (isReport) {
            // The member the report is about: on a post, its author as the node read it from the post, never the key the
            // reporter wrote beside it (reportSubject). Nobody, when the node doesn't say who wrote the post.
            const subject = threat ? reportSubject(threat) : null;
            rawKeys = subject ? [subject] : [];
        } else {
            rawKeys = flagMembers(threat);
            // Only when the node sent no list at all. An empty list is the node saying "nobody" (watchdog_recovery and the
            // other flags that name no one): reading their description then finds the date in "(last: 2026-11-04T10:12:33Z)".
            if (rawKeys.length === 0 && !Array.isArray(threat?.members)) {
                const str = threat?.description || '';
                // Match terms like wash1-17, ring0-17, etc., or standard pubkey patterns
                const matches = str.match(/([a-zA-Z0-9_-]{4,}\-[0-9]+)|([a-fA-F0-9]{32,64})/g);
                rawKeys = matches ? Array.from(new Set(matches)) : [];
            }
        }

        // Map short/prefix tokens (e.g. ring0-17) to full pubkeys in members roster (e.g. ring0-1784649014864...)
        const resolved = rawKeys.map((key) => {
            const found = membersMap.get(key) || members.find((m: MemberItem) => {
                const pk = m.publicKey || m.pubkey || '';
                return pk === key || (pk && key && (pk.startsWith(key) || key.startsWith(pk)));
            });
            return found ? (found.publicKey || found.pubkey || key) : key;
        });
        return Array.from(new Set(resolved));
    };

    const involvedPubkeys = extractPubkeys();
    // Who Freeze acts on: the members named, less those the viewer may not freeze. Named members and none of them left:
    // no Freeze at all.
    const freezablePubkeys = involvedPubkeys.filter((pub) => !cantFreezeReason(viewer, pub, membersMap.get(pub)));
    const offerFreeze = canFreeze && !(involvedPubkeys.length > 0 && freezablePubkeys.length === 0);

    // Parse structured metrics from string if available
    const parseMetrics = () => {
        const desc = threat?.description || '';
        const metrics: { label: string; value: string; highlight?: boolean }[] = [];

        if (desc.includes('reciprocal flow ratio')) {
            const ratioMatch = desc.match(/reciprocal flow ratio ([\d\.]+)/);
            // The node writes the gross already in Beans, grouped (state-engine: formatHundredths(gross, 'en') Beans): "1,234.56".
            const grossMatch = desc.match(/gross: ([\d.,]+\d)/);
            if (ratioMatch) metrics.push({ label: 'Reciprocal Flow Ratio', value: ratioMatch[1], highlight: true });
            if (grossMatch) metrics.push({ label: 'Gross Volume', value: `${grossMatch[1]} Beans` });
            metrics.push({ label: 'Threshold Required', value: '≥ 0.15' });
        } else if (desc.includes('insular')) {
            const insularityMatch = desc.match(/([\d\.]+) insularity/);
            const newMemberMatch = desc.match(/([\d]+%) new members/);
            const countMatch = desc.match(/component of (\d+) members/);
            if (insularityMatch) metrics.push({ label: 'Cluster Insularity', value: insularityMatch[1], highlight: true });
            if (newMemberMatch) metrics.push({ label: 'New Accounts', value: newMemberMatch[1] });
            if (countMatch) metrics.push({ label: 'Ring Size', value: `${countMatch[1]} Nodes` });
        } else if (desc.includes('cohort')) {
            const cohortMatch = desc.match(/(\d+) cohort/);
            if (cohortMatch) metrics.push({ label: 'Affected Cohorts', value: cohortMatch[1], highlight: true });
            metrics.push({ label: 'Evaluation Window', value: '14 Days' });
            metrics.push({ label: 'Floor Depth', value: 'Anomaly' });
        }

        return metrics;
    };

    const parsedMetrics = parseMetrics();

    const handleAction = async (action: string) => {
        // Nothing freezes for a flag that does not show real harm.
        if (action === 'freeze' && !offerFreeze) return;
        // A report lives on the node: dismissing it only here would leave it pending for everyone else.
        if (action === 'dismiss' && isReport && threat?.id && onDismissReport) {
            setDismissing(true);
            setDismissError(null);
            try {
                await onDismissReport(threat);
            } catch (e: unknown) {
                setDismissError(e instanceof Error ? e.message : t(W.dismissFailed));
                return;
            } finally {
                setDismissing(false);
            }
        }
        if (action === 'freeze' && onFreezePubkeys) {
            setFreezing(true);
            setDismissError(null);
            try {
                await onFreezePubkeys(freezablePubkeys);
            } catch (e: unknown) {
                setDismissError(e instanceof Error ? e.message : t(W.freezeFailed));
                return;
            } finally {
                setFreezing(false);
            }
        }
        setActionState(action);
        setTimeout(() => {
            // A report stays open on the node after a freeze until an operator dismisses or actions it.
            if (action === 'freeze' && isReport) {
                onClose();
            } else if ((action === 'dismiss' || action === 'freeze') && onDismiss) {
                onDismiss(threat);
            }
        }, 1200);
    };

    const handleCopyEvidence = () => {
        const evidencePacket = JSON.stringify({
            timestamp: new Date().toISOString(),
            threat: threat,
            involvedEntities: involvedPubkeys,
            parsedMetrics: parsedMetrics,
            nodeEnvironment: 'Local Dev Node (Infringement Testbed)'
        }, null, 2);

        navigator.clipboard?.writeText(evidencePacket);
        setCopiedLog(true);
        copiedLogTimer.schedule(() => setCopiedLog(false), 2000);
    };

    const badgeClass = severity === 'critical' ? 'bg-bp-danger-fill text-bp-danger-on' : 'bg-bp-gold-fill text-bp-gold-on';
    const iconClass = severity === 'critical' ? 'bg-red-950 text-red-400 border-red-800/80' : 'bg-amber-950 text-amber-400 border-amber-800/80';

    return (
        <ModalBackdrop onClose={onClose} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="m-auto bg-nature-950 border border-red-900/80 rounded-3xl p-4 sm:p-6 max-w-xl w-full space-y-5 sm:space-y-6 shadow-2xl overflow-hidden relative">

                {/* Header: how serious, then what it is in words (the words get the card's whole width) */}
                <div className="border-b border-nature-800/80 pb-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-base font-bold border ${iconClass}`}>
                                {isReport ? '📢' : '🚨'}
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase font-mono tracking-wide ${badgeClass}`}>
                                {severity}
                            </span>
                        </div>
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="shrink-0 text-nature-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-nature-900 text-lg"
                        >
                            ✕
                        </button>
                    </div>
                    <h3 className="text-lg font-black text-white m-0 tracking-tight break-words">
                        {title}
                    </h3>
                </div>

                {/* What happened */}
                <div className="bg-nature-900/90 border border-nature-800 p-4 rounded-2xl space-y-2">
                    <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                        {isReport ? t(W.whatWasReported) : t(W.whatHappened)}
                    </span>
                    <p className="text-xs font-medium text-nature-100 m-0 leading-relaxed break-words">
                        {description}
                    </p>
                </div>

                {/* The numbers behind it, where the node's description carries them */}
                {parsedMetrics.length > 0 && (
                    <div className="space-y-2">
                        <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                            {t(W.theNumbers)}
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 text-xs">
                            {parsedMetrics.map((m, idx) => (
                                <div key={idx} className="bg-nature-900/60 border border-nature-800/80 p-3 rounded-xl flex sm:block items-baseline justify-between gap-2 min-w-0 sm:space-y-1">
                                    <span className="text-[10px] text-nature-400 block font-semibold">{m.label}</span>
                                    <span className={`font-mono font-bold text-sm ${m.highlight ? 'text-red-400' : 'text-white'}`}>
                                        {m.value}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Who: the members the node names, by name */}
                <div className="space-y-2">
                    <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                        {t(W.whoIsInvolved, { count: String(involvedPubkeys.length) })}
                    </span>
                    <div className="bg-nature-900/40 border border-nature-800/80 p-3 rounded-xl space-y-2 max-h-36 overflow-y-auto">
                        {involvedPubkeys.length > 0 ? (
                            involvedPubkeys.map((pub, idx) => {
                                const matchedMember = membersMap.get(pub) || { pubkey: pub, publicKey: pub };
                                const displayName = getMemberDisplayName(matchedMember, profiles);
                                const notYours = cantFreezeReason(viewer, pub, membersMap.get(pub));
                                const isItemFrozen = (frozenPubkeys instanceof Set ? frozenPubkeys.has(pub) : (frozenPubkeys || []).includes(pub)) || (actionState === 'freeze' && !notYours);

                                return (
                                    <div
                                        key={idx}
                                        onClick={() => onInspectMember?.(matchedMember)}
                                        className="flex items-center justify-between gap-2 bg-nature-950 hover:bg-nature-900/80 p-2 rounded-lg border border-nature-800 hover:border-terra-500/60 text-xs cursor-pointer transition-all group"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div className="w-6 h-6 shrink-0 rounded-full bg-nature-900 border border-nature-700 flex items-center justify-center text-[10px] text-nature-300 font-bold group-hover:scale-105 transition-transform">
                                                👤
                                            </div>
                                            <span className="font-bold text-white leading-tight break-words min-w-0 group-hover:text-bp-ink-terra transition-colors">
                                                {displayName}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {notYours && canFreeze && (
                                                <span className="text-[10px] text-nature-300 text-right">
                                                    {t(notYours === 'self' ? W.cantFreezeSelf : W.cantFreezeOwner)}
                                                </span>
                                            )}
                                            {isItemFrozen && (
                                                <span className="px-2 py-0.5 rounded font-mono text-[10px] border bg-bp-danger-fill text-bp-danger-on border-bp-danger-fill font-bold">
                                                    {t(W.frozenTag)}
                                                </span>
                                            )}
                                            <span className="text-[10px] text-nature-500 group-hover:text-white">🔍</span>
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-xs text-nature-400 italic">{isReport ? t(W.reportNamesNobody) : t(W.noMembersNamed)}</div>
                        )}
                    </div>
                </div>

                {/* The one sensible action, in words (a flag; a report is read and decided by the owner) */}
                {!isReport && (
                    <div className="space-y-2">
                        <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                            {t(W.whatToDo)}
                        </span>
                        <p className="text-xs text-nature-100 m-0 leading-relaxed break-words">{flagAction(threat)}</p>
                    </div>
                )}

                {/* Action Feedback State Banner */}
                {actionState && (
                    <div className="p-3 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center gap-2 animate-fade-in font-mono">
                        <span>✅</span>
                        <span>
                            {actionState === 'freeze' && t(W.feedbackFrozen)}
                            {actionState === 'dismiss' && t(W.feedbackDismissed)}
                        </span>
                    </div>
                )}

                {dismissError && (
                    <div role="alert" className="p-3 bg-red-950/80 border border-red-800 text-red-300 rounded-xl text-xs">
                        {dismissError}
                    </div>
                )}

                {/* Controls: Dismiss for everything; Freeze only where the flag shows real harm; the details to copy */}
                <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 border-t border-nature-800/80 pt-4 text-xs">
                    <button
                        onClick={handleCopyEvidence}
                        className="px-3 py-2 rounded-xl bg-nature-900 hover:bg-nature-800 text-nature-300 font-bold border border-nature-800 transition-all flex items-center gap-1.5 shrink-0"
                    >
                        <span>{copiedLog ? t(W.copied) : t(W.exportEvidence)}</span>
                    </button>

                    <div className="flex flex-wrap lg:flex-nowrap items-center gap-2 ml-auto">
                        <button
                            onClick={() => handleAction('dismiss')}
                            disabled={dismissing}
                            className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold border border-nature-700 transition-all disabled:opacity-50"
                        >
                            {dismissing ? t(W.dismissing) : t(W.dismiss)}
                        </button>
                        {offerFreeze && (
                            <button
                                onClick={() => handleAction('freeze')}
                                disabled={freezing || involvedPubkeys.length === 0}
                                className="px-4 py-2 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold transition-all border border-bp-danger-fill flex items-center gap-1 shadow-lg shadow-red-950/50 disabled:opacity-50"
                            >
                                <span>{freezing ? t(W.freezing) : t(W.freeze)}</span>
                            </button>
                        )}
                    </div>
                </div>

            </div>
        </ModalBackdrop>
    );
}
