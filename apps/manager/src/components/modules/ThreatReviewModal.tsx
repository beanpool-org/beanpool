import React, { useState } from 'react';
import { getMemberDisplayName } from './MembersModule';

interface ThreatReviewModalProps {
    threat: any;
    profiles?: any[];
    members?: any[];
    frozenPubkeys?: string[] | Set<string>;
    onClose: () => void;
    onDismiss?: (threat: any) => void;
    onFreezePubkeys?: (pubkeys: string[]) => void;
    onInspectMember?: (member: any) => void;
}

export function ThreatReviewModal({
    threat,
    profiles = [],
    members = [],
    frozenPubkeys,
    onClose,
    onDismiss,
    onFreezePubkeys,
    onInspectMember
}: ThreatReviewModalProps) {
    const [actionState, setActionState] = useState<string | null>(null);
    const [copiedLog, setCopiedLog] = useState(false);

    const isReport = threat?.isReport || threat?.targetPubkey !== undefined;
    const severity = threat?.severity || (isReport ? 'warning' : 'critical');
    const title = isReport ? 'USER REPORTED ABUSE' : (threat?.type || 'SECURITY ALERT');
    const description = threat?.description || threat?.reason || 'Potential policy violation or network infringement detected.';

    // Extract involved pubkeys from description or report target and resolve full pubkeys from roster
    const extractPubkeys = (): string[] => {
        let rawKeys: string[] = [];
        if (isReport && threat?.targetPubkey) {
            rawKeys = [threat.targetPubkey];
        } else {
            const str = threat?.description || '';
            // Match terms like wash1-17, ring0-17, etc., or standard pubkey patterns
            const matches = str.match(/([a-zA-Z0-9_-]{4,}\-[0-9]+)|([a-fA-F0-9]{32,64})/g);
            rawKeys = matches ? Array.from(new Set(matches)) : [];
        }

        // Map short/prefix tokens (e.g. ring0-17) to full pubkeys in members roster (e.g. ring0-1784649014864...)
        return rawKeys.map((key) => {
            const found = members.find((m: any) => {
                const pk = m.publicKey || m.pubkey || '';
                return pk === key || (pk && key && (pk.startsWith(key) || key.startsWith(pk)));
            });
            return found ? (found.publicKey || found.pubkey) : key;
        });
    };

    const involvedPubkeys = extractPubkeys();

    // Parse structured metrics from string if available
    const parseMetrics = () => {
        const desc = threat?.description || '';
        const metrics: { label: string; value: string; highlight?: boolean }[] = [];

        if (desc.includes('reciprocal flow ratio')) {
            const ratioMatch = desc.match(/reciprocal flow ratio ([\d\.]+)/);
            const grossMatch = desc.match(/gross: ([\d\.]+)/);
            if (ratioMatch) metrics.push({ label: 'Reciprocal Flow Ratio', value: ratioMatch[1], highlight: true });
            if (grossMatch) metrics.push({ label: 'Gross Volume', value: `${grossMatch[1]} BP` });
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

    const handleAction = (action: string) => {
        setActionState(action);
        if (action === 'freeze' && onFreezePubkeys) {
            onFreezePubkeys(involvedPubkeys);
        }
        setTimeout(() => {
            if ((action === 'dismiss' || action === 'freeze') && onDismiss) {
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
        setTimeout(() => setCopiedLog(false), 2000);
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="bg-nature-950 border border-red-900/80 rounded-3xl p-6 max-w-xl w-full space-y-6 shadow-2xl overflow-hidden relative">
                
                {/* Header Section */}
                <div className="flex items-start justify-between border-b border-nature-800/80 pb-4">
                    <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-xl font-bold border ${
                            severity === 'critical' ? 'bg-red-950 text-red-400 border-red-800/80' : 'bg-amber-950 text-amber-400 border-amber-800/80'
                        }`}>
                            {isReport ? '📢' : '🚨'}
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase font-mono tracking-wide ${
                                    severity === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-600 text-white'
                                }`}>
                                    {severity}
                                </span>
                                <span className="text-xs font-mono text-nature-400">Threat ID: #{Math.floor(1000 + Math.random() * 9000)}</span>
                            </div>
                            <h3 className="text-lg font-black text-white m-0 tracking-tight mt-0.5">
                                {title}
                            </h3>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-nature-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-nature-900 text-lg"
                    >
                        ✕
                    </button>
                </div>

                {/* Threat Description Banner */}
                <div className="bg-nature-900/90 border border-nature-800 p-4 rounded-2xl space-y-2">
                    <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                        Inspection Evidence Summary
                    </span>
                    <p className="text-xs font-medium text-nature-100 m-0 leading-relaxed">
                        {description}
                    </p>
                </div>

                {/* Parsed Telemetry Metrics */}
                {parsedMetrics.length > 0 && (
                    <div className="space-y-2">
                        <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                            Calculated Security Telemetry
                        </span>
                        <div className="grid grid-cols-3 gap-3 text-xs">
                            {parsedMetrics.map((m, idx) => (
                                <div key={idx} className="bg-nature-900/60 border border-nature-800/80 p-3 rounded-xl space-y-1">
                                    <span className="text-[10px] text-nature-400 block font-semibold">{m.label}</span>
                                    <span className={`font-mono font-bold text-sm ${m.highlight ? 'text-red-400' : 'text-white'}`}>
                                        {m.value}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Involved Member Entities */}
                <div className="space-y-2">
                    <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-nature-400 block">
                        Targeted Member Accounts ({involvedPubkeys.length || 1})
                    </span>
                    <div className="bg-nature-900/40 border border-nature-800/80 p-3 rounded-xl space-y-2 max-h-36 overflow-y-auto">
                        {involvedPubkeys.length > 0 ? (
                            involvedPubkeys.map((pub, idx) => {
                                const matchedMember = members.find((m: any) => {
                                    const pk = m.publicKey || m.pubkey || '';
                                    return pk === pub || (pk && pub && (pk.startsWith(pub) || pub.startsWith(pk)));
                                }) || { pubkey: pub, publicKey: pub };
                                const displayName = getMemberDisplayName(matchedMember, profiles);
                                const isItemFrozen = (frozenPubkeys instanceof Set ? frozenPubkeys.has(pub) : (frozenPubkeys || []).includes(pub)) || actionState === 'freeze';
                                
                                return (
                                    <div
                                        key={idx}
                                        onClick={() => onInspectMember?.(matchedMember)}
                                        className="flex items-center justify-between bg-nature-950 hover:bg-nature-900/80 p-2 rounded-lg border border-nature-800 hover:border-terra-500/60 text-xs cursor-pointer transition-all group"
                                    >
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-red-900/40 border border-red-700/60 flex items-center justify-center text-[10px] text-red-300 font-bold group-hover:scale-105 transition-transform">
                                                👤
                                            </div>
                                            <div>
                                                <span className="font-bold text-white block leading-tight group-hover:text-terra-400 transition-colors">
                                                    {displayName}
                                                </span>
                                                <span className="font-mono text-[10px] text-nature-400">{pub}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`px-2 py-0.5 rounded font-mono text-[10px] border ${
                                                isItemFrozen
                                                    ? 'bg-red-600 text-white border-red-500 font-bold'
                                                    : 'bg-red-950 text-red-400 border-red-900'
                                            }`}>
                                                {isItemFrozen ? '🛑 FROZEN' : 'FLAGGED'}
                                            </span>
                                            <span className="text-[10px] text-nature-500 group-hover:text-white">🔍</span>
                                        </div>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="text-xs text-nature-400 italic">No specific public keys isolated in report string.</div>
                        )}
                    </div>
                </div>

                {/* Action Feedback State Banner */}
                {actionState && (
                    <div className="p-3 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center gap-2 animate-fade-in font-mono">
                        <span>✅</span>
                        <span>
                            {actionState === 'quarantine' && 'Vouch quarantine directive dispatched for target nodes.'}
                            {actionState === 'freeze' && 'Member access rights frozen. Moderation event logged.'}
                            {actionState === 'dismiss' && 'Flag marked as resolved / false positive.'}
                        </span>
                    </div>
                )}

                {/* Remediation Action Controls */}
                <div className="flex items-center justify-between gap-3 border-t border-nature-800/80 pt-4 text-xs">
                    <button
                        onClick={handleCopyEvidence}
                        className="px-3 py-2 rounded-xl bg-nature-900 hover:bg-nature-800 text-nature-300 font-bold border border-nature-800 transition-all flex items-center gap-1.5 shrink-0"
                    >
                        <span>{copiedLog ? '📋 Copied!' : '📄 Export Evidence'}</span>
                    </button>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleAction('dismiss')}
                            className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold border border-nature-700 transition-all"
                        >
                            Dismiss Flag
                        </button>
                        <button
                            onClick={() => handleAction('freeze')}
                            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold transition-all border border-red-500 flex items-center gap-1 shadow-lg shadow-red-950/50"
                        >
                            <span>🛑 Freeze Accounts</span>
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
