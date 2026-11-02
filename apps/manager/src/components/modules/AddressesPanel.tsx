/**
 * Settings → Appliance → "Addresses" (design scratch/fable-design/DESIGN-dns-robustness-fable.md §5.2).
 *
 * One screen for every address members and browsers reach this community at:
 *  - unified list with rows as §5.2: Address, Points at, Answers from outside, Apps today, Apps can sign, Next step;
 *  - "Check now": asks every address from outside and updates checked times;
 *  - "Check from your phone": opens /check to verify outside reach on mobile data;
 *  - "Add an address": folds in the three choices (a free BeanPool name, this server's number, your own domain);
 *  - "Make main": heals / promotes any held address to the community's primary address;
 *  - Recovery code reminder on the BeanPool name request: never a hard gate, protects against server loss.
 *
 * Central tokens only (bg-bp-*, text-bp-*, nature-*, oat-*, terra-*); accessible at 320 px with 130 % text.
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import {
    ADDRESS_CHECK_WORDS, ADDRESS_SCREEN_WORDS, addressNextStep,
    type AddressAnswer, type AddressReach, type AddressStep,
} from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import {
    checkAppAddresses, confirmAppAddress, getAppAddresses, getTfaSessionToken,
    removeAppAddress, resolveNodeApiUrl, setOwnAddress,
    type AddressSighting, type AppAddress, type AppAddressesReport, type HeldBackAddress,
} from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { standingText } from './AppAddressesPanel';
import { describeTunnel } from './PublicAddressPanel';

const W = ADDRESS_SCREEN_WORDS;

export function isBeanPoolName(host: string): boolean {
    return host === 'beanpool.org' || host.endsWith('.beanpool.org');
}

export function isIpAddress(host: string): boolean {
    return /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
}

export function addressKind(host: string): string {
    if (isBeanPoolName(host)) return t(W.kindBeanPool);
    if (isIpAddress(host)) return t(W.kindNumber);
    return t(W.kindDomain);
}

export function extractSubdomain(host: string): string {
    return host.replace(/\.beanpool\.org$/i, '').trim();
}

/** Format a time for display: e.g. "16:02" */
export function formatTime(iso: string | null | undefined): string {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Relative time in minutes or hours for answersFromOutside */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return '';
    const diffMin = Math.round((now - ms) / 60_000);
    if (diffMin <= 1) return t('just now');
    if (diffMin < 60) return `${diffMin} min ago`;
    const hours = Math.round(diffMin / 60);
    return `${hours}h ago`;
}

export function pointsAtText(address: string, reach?: AddressReach | null, tunnelState?: string): string {
    if (isBeanPoolName(address)) {
        const state = tunnelState || 'connected';
        if (state === 'connected') return t(W.pointsTunnelConnected);
        if (state === 'retrying') return t(W.pointsTunnelRetrying);
        if (state === 'starting') return t(W.pointsTunnelStarting);
        if (state === 'disconnected') return t(W.pointsTunnelDisconnected);
        return t(W.pointsTunnelOff);
    }
    if (isIpAddress(address)) return address;
    // Own domain: what DNS records were seen
    const a = reach?.dns?.a ?? [];
    const cname = reach?.dns?.cname ?? [];
    if (a.length > 0) return a.join(', ');
    if (cname.length > 0) return cname.join(', ');
    return t(W.pointsNoDns);
}

export function answersText(reach?: AddressReach | null): string {
    if (!reach) return t('not checked yet');
    if (reach.answers === 'own') {
        const time = formatRelativeTime(reach.checkedAt);
        return t(W.answersAnswered).replace('{time}', time || formatTime(reach.checkedAt));
    }
    if (reach.dns?.outcome === 'no-such-name') return t(W.answersNotFound);
    if (reach.answers === 'other') return t(W.answersAnother);
    if (reach.answers === 'tls') return t(W.answersTls);
    if (reach.answers === 'other-origin') return t(W.answersOther);
    if (reach.answers === 'silence') return t(W.answersSilence);
    if (reach.answers === null) return t(W.answersHome);
    return t('unknown');
}

export function signingText(a: AppAddress): string {
    if (a.lost) return t(W.signLost);
    if (a.former) return t(W.signNotAdvertised);
    return t(W.signYes);
}

export function appsTodayText(today: number): string {
    return today === 1 ? '1 app today' : `${today} apps today`;
}

export interface AddressesPanelProps {
    activeNode: NodeProfile;
    onRefreshDiag?: () => void;
    viewer?: { kind?: string; memberPubkey?: string; role?: string };
}

export function AddressesPanel({ activeNode, onRefreshDiag, viewer = { role: 'owner' } }: AddressesPanelProps) {
    const isOwner = viewer.role === 'owner' || viewer.kind === 'password';
    const [report, setReport] = useState<AppAddressesReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [checking, setChecking] = useState(false);
    const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' | 'warning' } | null>(null);

    // Tunnel info from public-address/status
    const [tunnelStatus, setTunnelStatus] = useState<string>('connected');
    const [tunnelDetail, setTunnelDetail] = useState<string | null>(null);

    // "Add an address" section state
    const [showAddSection, setShowAddSection] = useState(false);
    const [addKind, setAddKind] = useState<'beanpool' | 'ip' | 'domain'>('beanpool');
    const [beanpoolSubdomain, setBeanpoolSubdomain] = useState('');
    const [communityName, setCommunityName] = useState('');
    const [contact, setContact] = useState('');
    const [ipInput, setIpInput] = useState('');
    const [domainInput, setDomainInput] = useState('');
    const [submittingAdd, setSubmittingAdd] = useState(false);

    // Fresh proof
    const proof = useFreshProof();
    const cred = nodeCredential(activeNode);

    // Unique IDs for form labels
    const subdomainId = useId();
    const communityNameId = useId();
    const contactId = useId();
    const ipInputId = useId();
    const domainInputId = useId();

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await getAppAddresses(activeNode.url, cred, getTfaSessionToken(activeNode.id));
            setReport(data);

            // Also check latest check time from addresses
            const checkTimes = data.addresses
                .map((a) => a.reach?.checkedAt)
                .filter((t): t is string => !!t)
                .sort();
            if (checkTimes.length > 0) {
                setLastCheckedAt(checkTimes[checkTimes.length - 1]);
            }

            // Fetch tunnel state if available
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/status'), {
                    headers: { Authorization: `Bearer ${cred || ''}` },
                });
                if (res.ok) {
                    const st = await res.json().catch(() => ({}));
                    if (st?.tunnel?.state) setTunnelStatus(st.tunnel.state);
                    if (st?.tunnel) setTunnelDetail(describeTunnel(st.tunnel));
                }
            } catch {
                // Ignore auxiliary tunnel status read failure
            }
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Failed to load addresses');
        } finally {
            setLoading(false);
        }
    }, [activeNode.url, cred, activeNode.id]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Handle "Check now"
    const handleCheckNow = async () => {
        setChecking(true);
        setActionMessage(null);
        try {
            const updated = await checkAppAddresses(activeNode.url, cred, getTfaSessionToken(activeNode.id));
            setReport(updated);
            setLastCheckedAt(new Date().toISOString());
            setActionMessage({ text: t('Addresses checked from outside.'), type: 'success' });
        } catch (e: unknown) {
            setActionMessage({ text: e instanceof Error ? e.message : 'Check failed', type: 'error' });
        } finally {
            setChecking(false);
        }
    };

    // Handle "Make main"
    const handleMakeMain = async (a: AppAddress, code?: string) => {
        setActionMessage(null);
        try {
            if (isBeanPoolName(a.address)) {
                const name = extractSubdomain(a.address);
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/claim');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${cred || ''}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ name, mode: 'tunnel', code }),
                });
                if (await proof.check(res, (c) => handleMakeMain(a, c), code)) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body?.error || `HTTP ${res.status}`);
                }
            } else if (isIpAddress(a.address)) {
                await setOwnAddress(activeNode.url, { ip: a.address }, cred, getTfaSessionToken(activeNode.id), code);
            } else {
                await setOwnAddress(activeNode.url, { domain: a.address }, cred, getTfaSessionToken(activeNode.id), code);
            }
            setActionMessage({ text: `${a.address} is now the main address.`, type: 'success' });
            await loadData();
            onRefreshDiag?.();
        } catch (e: unknown) {
            setActionMessage({ text: e instanceof Error ? e.message : 'Could not make main', type: 'error' });
        }
    };

    // Handle "Remove" or "Release"
    const handleRemoveOrRelease = async (a: AppAddress, code?: string) => {
        setActionMessage(null);
        try {
            if (isBeanPoolName(a.address)) {
                const name = extractSubdomain(a.address);
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/release-name');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${cred || ''}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ name, code }),
                });
                if (await proof.check(res, (c) => handleRemoveOrRelease(a, c), code)) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body?.error || `HTTP ${res.status}`);
                }
            } else {
                await removeAppAddress(activeNode.url, a.address, cred, getTfaSessionToken(activeNode.id), code);
            }
            setActionMessage({ text: `${a.address} removed.`, type: 'success' });
            await loadData();
            onRefreshDiag?.();
        } catch (e: unknown) {
            setActionMessage({ text: e instanceof Error ? e.message : 'Could not remove address', type: 'error' });
        }
    };

    // Handle adding an address (folded form submission)
    const handleAddSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmittingAdd(true);
        setActionMessage(null);
        try {
            if (addKind === 'beanpool') {
                const name = beanpoolSubdomain.trim().toLowerCase();
                if (!name) throw new Error('Please enter a name');
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/claim');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${cred || ''}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        name,
                        mode: 'tunnel',
                        communityName: communityName.trim() || undefined,
                        contact: contact.trim() || undefined,
                    }),
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
                setActionMessage({ text: `Requested ${name}.beanpool.org`, type: 'success' });
                setBeanpoolSubdomain('');
            } else if (addKind === 'ip') {
                const ip = ipInput.trim();
                if (!ip) throw new Error('Please enter an IP address');
                await setOwnAddress(activeNode.url, { ip }, cred, getTfaSessionToken(activeNode.id));
                setActionMessage({ text: `Set IP address ${ip}`, type: 'success' });
                setIpInput('');
            } else {
                const dom = domainInput.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
                if (!dom) throw new Error('Please enter a domain');
                await setOwnAddress(activeNode.url, { domain: dom }, cred, getTfaSessionToken(activeNode.id));
                setActionMessage({ text: `Added domain ${dom}`, type: 'success' });
                setDomainInput('');
            }
            setShowAddSection(false);
            await loadData();
            onRefreshDiag?.();
        } catch (err: unknown) {
            setActionMessage({ text: err instanceof Error ? err.message : 'Failed to add address', type: 'error' });
        } finally {
            setSubmittingAdd(false);
        }
    };

    // Sort addresses: main first, then active configured, then former and lost
    const primary = report?.primaryAddress;
    const sortedAddresses: AppAddress[] = (report?.addresses ? [...report.addresses] : []).sort((x, y) => {
        const xIsMain = x.address === primary || (!primary && x.source === 'public-address');
        const yIsMain = y.address === primary || (!primary && y.source === 'public-address');
        if (xIsMain && !yIsMain) return -1;
        if (!xIsMain && yIsMain) return 1;
        const xInactive = x.former || x.lost;
        const yInactive = y.former || y.lost;
        if (!xInactive && yInactive) return -1;
        if (xInactive && !yInactive) return 1;
        return x.address.localeCompare(y.address);
    });

    return (
        <div className="space-y-6 max-w-5xl font-sans" data-testid="addresses-panel">
            {/* Header & Screen Actions */}
            <div className="p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-nature-800 pb-4">
                    <div>
                        <h2 className="text-lg font-bold text-white m-0 flex items-center gap-2">
                            <span>🌐</span>
                            <span>{t(W.screenTitle)}</span>
                        </h2>
                        <p className="text-xs text-nature-400 m-0 mt-1 max-w-2xl">
                            {t(W.screenIntro)}
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={handleCheckNow}
                            disabled={checking || loading}
                            data-testid="addresses-check-now-btn"
                            className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-700 disabled:opacity-50 min-h-[44px] flex items-center gap-1.5"
                        >
                            <span>{checking ? '⏳' : '🔄'}</span>
                            <span>{checking ? t(W.checking) : t(W.checkNow)}</span>
                        </button>

                        {isOwner && (
                            <button
                                type="button"
                                onClick={() => setShowAddSection(!showAddSection)}
                                data-testid="addresses-add-address-btn"
                                className="px-3.5 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on min-h-[44px] flex items-center gap-1.5 shadow-sm"
                            >
                                <span>➕</span>
                                <span>{t(W.addAddress)}</span>
                            </button>
                        )}
                    </div>
                </div>

                {lastCheckedAt && (
                    <div className="text-[11px] text-nature-400 flex items-center gap-2" data-testid="addresses-last-checked">
                        <span>🕒</span>
                        <span>{t(W.checkedAt).replace('{time}', formatTime(lastCheckedAt))}</span>
                        {tunnelDetail && <span className="text-nature-500">· Tunnel: {tunnelDetail}</span>}
                    </div>
                )}

                {actionMessage && (
                    <div
                        role="status"
                        aria-live="polite"
                        className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                            actionMessage.type === 'error'
                                ? 'bg-bp-chip-danger-tint border-nature-700 text-bp-chip-danger-ink'
                                : actionMessage.type === 'warning'
                                ? 'bg-bp-chip-warn-tint border-nature-700 text-bp-chip-warn-ink'
                                : 'bg-bp-chip-ok-tint border-nature-700 text-bp-chip-ok-ink'
                        }`}
                    >
                        <span>{actionMessage.text}</span>
                        <button
                            type="button"
                            onClick={() => setActionMessage(null)}
                            className="text-nature-400 hover:text-white font-bold px-1"
                            aria-label="Dismiss message"
                        >
                            ✕
                        </button>
                    </div>
                )}

                {error && (
                    <div role="alert" className="p-3 rounded-xl border border-nature-700 bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-semibold">
                        {error}
                    </div>
                )}
            </div>

            {/* Folded Add Address Section */}
            {showAddSection && isOwner && (
                <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 shadow-lg space-y-4" data-testid="add-address-section">
                    <div className="flex items-center justify-between border-b border-nature-800 pb-2">
                        <h3 className="text-sm font-bold text-white m-0">
                            {t(W.addAddress)}
                        </h3>
                        <button
                            type="button"
                            onClick={() => setShowAddSection(false)}
                            className="text-nature-400 hover:text-white text-xs px-2 py-1"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Three folded choices */}
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => setAddKind('beanpool')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[40px] ${
                                addKind === 'beanpool'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceBeanPool)}
                        </button>
                        <button
                            type="button"
                            onClick={() => setAddKind('ip')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[40px] ${
                                addKind === 'ip'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceNumber)}
                        </button>
                        <button
                            type="button"
                            onClick={() => setAddKind('domain')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[40px] ${
                                addKind === 'domain'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceDomain)}
                        </button>
                    </div>

                    <form onSubmit={handleAddSubmit} className="space-y-4">
                        {addKind === 'beanpool' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={subdomainId} className="block text-xs font-bold text-nature-300 mb-1">
                                        Subdomain Prefix
                                    </label>
                                    <div className="flex items-center gap-1 font-mono text-sm">
                                        <input
                                            id={subdomainId}
                                            type="text"
                                            value={beanpoolSubdomain}
                                            onChange={(e) => setBeanpoolSubdomain(e.target.value)}
                                            placeholder="my-community"
                                            className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px] flex-1"
                                        />
                                        <span className="text-nature-400 font-mono text-xs">.beanpool.org</span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label htmlFor={communityNameId} className="block text-xs font-bold text-nature-300 mb-1">
                                            Community Name (Optional)
                                        </label>
                                        <input
                                            id={communityNameId}
                                            type="text"
                                            value={communityName}
                                            onChange={(e) => setCommunityName(e.target.value)}
                                            placeholder="Riverbend Exchange"
                                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor={contactId} className="block text-xs font-bold text-nature-300 mb-1">
                                            Contact Email or Phone (Optional)
                                        </label>
                                        <input
                                            id={contactId}
                                            type="text"
                                            value={contact}
                                            onChange={(e) => setContact(e.target.value)}
                                            placeholder="owner@example.org"
                                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                                        />
                                    </div>
                                </div>

                                {/* Recovery Code Reminder (Item 3: Never a gate!) */}
                                <div
                                    data-testid="recovery-code-reminder"
                                    className="p-3 rounded-xl bg-nature-900 border border-nature-800 text-xs text-nature-300 flex items-start gap-2.5"
                                >
                                    <span className="text-base select-none">🛡️</span>
                                    <div className="space-y-1">
                                        <p className="m-0 leading-relaxed font-medium">
                                            {t(W.recoveryReminder)}
                                        </p>
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd || !beanpoolSubdomain.trim()}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {submittingAdd ? 'Claiming…' : 'Claim BeanPool Name'}
                                </button>
                            </div>
                        )}

                        {addKind === 'ip' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={ipInputId} className="block text-xs font-bold text-nature-300 mb-1">
                                        Public IPv4 Address
                                    </label>
                                    <input
                                        id={ipInputId}
                                        type="text"
                                        value={ipInput}
                                        onChange={(e) => setIpInput(e.target.value)}
                                        placeholder="203.0.113.5"
                                        className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px] w-full max-w-md"
                                    />
                                    <p className="text-[11px] text-nature-400 mt-1 m-0">
                                        For a server with open ports 80 and 443. The server gets its own certificate automatically.
                                    </p>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd || !ipInput.trim()}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {submittingAdd ? 'Saving…' : 'Set Server IP'}
                                </button>
                            </div>
                        )}

                        {addKind === 'domain' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={domainInputId} className="block text-xs font-bold text-nature-300 mb-1">
                                        Domain Name
                                    </label>
                                    <input
                                        id={domainInputId}
                                        type="text"
                                        value={domainInput}
                                        onChange={(e) => setDomainInput(e.target.value)}
                                        placeholder="community.example.org"
                                        className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px] w-full max-w-md"
                                    />
                                    <p className="text-[11px] text-nature-400 mt-1 m-0">
                                        Point an A or CNAME record to this server first. The server will request a TLS certificate automatically.
                                    </p>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd || !domainInput.trim()}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {submittingAdd ? 'Saving…' : 'Set Domain'}
                                </button>
                            </div>
                        )}
                    </form>
                </div>
            )}

            {/* The Unified Addresses List (§5.2) */}
            <div className="space-y-3" data-testid="addresses-list">
                <div className="flex items-center justify-between text-xs font-semibold text-nature-400 uppercase tracking-wider px-1">
                    <span>Configured Addresses</span>
                    <span>{sortedAddresses.length} {sortedAddresses.length === 1 ? 'address' : 'addresses'}</span>
                </div>

                {sortedAddresses.length === 0 && !loading && (
                    <div className="p-6 rounded-2xl bg-nature-950 border border-nature-800 text-center text-xs text-nature-400">
                        No addresses configured yet. Press &quot;Add an address&quot; above to set one up.
                    </div>
                )}

                {sortedAddresses.map((a) => {
                    const isMain = a.address === primary || (!primary && a.source === 'public-address');
                    const isInactive = a.former || a.lost;
                    const kind = addressKind(a.address);
                    const points = pointsAtText(a.address, a.reach, tunnelStatus);
                    const answers = answersText(a.reach);
                    const apps = appsTodayText(a.today);
                    const sign = signingText(a);
                    const nextStep = a.reach?.nextStep
                        ? addressNextStep(a.reach.step, a.reach.minutes, { t, tn: (n, one, other) => (n === 1 ? one.replace('{n}', '1') : other.replace('{n}', String(n))) })
                        : a.standing
                        ? standingText(a)?.text ?? null
                        : null;

                    return (
                        <div
                            key={a.address}
                            data-testid={`address-row-${a.address}`}
                            className={`p-4 rounded-2xl border transition-all ${
                                isInactive
                                    ? 'bg-nature-950/40 border-nature-900 text-nature-500'
                                    : isMain
                                    ? 'bg-nature-950 border-nature-700 shadow-md ring-1 ring-terra-500/20'
                                    : 'bg-nature-950/80 border-nature-800 hover:border-nature-700'
                            }`}
                        >
                            {/* Responsive 3-line / Grid Layout (stacks cleanly at 320 px / 130% text) */}
                            <div className="flex flex-col gap-2.5">
                                {/* Line 1: Address, Kind, Main Badge, Apps count, Signing */}
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-nature-900 pb-2">
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                                        <span className="font-mono font-bold text-sm text-white break-all select-all">
                                            {a.address}
                                        </span>
                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-nature-900 text-nature-300 border border-nature-800">
                                            {kind}
                                        </span>
                                        {isMain && (
                                            <span
                                                data-testid="main-badge"
                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40"
                                            >
                                                <span>★</span>
                                                <span>{t(W.mainBadge)}</span>
                                            </span>
                                        )}
                                        {a.former && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-nature-900 text-nature-400 border border-nature-800">
                                                Former
                                            </span>
                                        )}
                                        {a.lost && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-bp-chip-danger-tint text-bp-chip-danger-ink border border-nature-800">
                                                Lost
                                            </span>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-3 text-xs text-nature-400">
                                        <span title="Apps that reached this community at this address today">
                                            📱 {apps}
                                        </span>
                                        <span title="Whether apps can sign for this address">
                                            ✍️ {sign}
                                        </span>
                                    </div>
                                </div>

                                {/* Line 2: Points at + Answers from outside */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                    <div className="flex items-baseline gap-1.5 min-w-0">
                                        <span className="text-nature-400 shrink-0">{t(W.colPointsAtLabel)}</span>
                                        <span className="font-mono text-nature-200 break-words">{points}</span>
                                    </div>
                                    <div className="flex items-baseline gap-1.5 min-w-0">
                                        <span className="text-nature-400 shrink-0">{t(W.colAnswersLabel)}</span>
                                        <span
                                            className={`font-medium break-words ${
                                                a.reach?.answers === 'own'
                                                    ? 'text-bp-ink-success'
                                                    : a.reach?.answers === 'tls' || a.reach?.answers === 'other'
                                                    ? 'text-bp-ink-danger'
                                                    : 'text-bp-ink-warning'
                                            }`}
                                        >
                                            {answers}
                                        </span>
                                    </div>
                                </div>

                                {/* Line 3: Next step + Actions */}
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                                    <div className="text-xs text-nature-300 min-w-0 pr-2">
                                        {nextStep && (
                                            <p className="m-0 leading-relaxed font-normal" data-testid="next-step-text">
                                                👉 {nextStep}
                                            </p>
                                        )}
                                    </div>

                                    {/* Action buttons */}
                                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                                        {/* Check from your phone (§5.3: opens /check) */}
                                        <a
                                            href={`https://${a.address}/check`}
                                            target="_blank"
                                            rel="noreferrer"
                                            role="button"
                                            data-testid={`check-phone-link-${a.address}`}
                                            className="px-2.5 py-1.5 rounded-lg bg-nature-900 hover:bg-nature-800 text-xs font-semibold text-bp-ink-terra hover:text-white border border-nature-700 min-h-[48px] inline-flex items-center gap-1"
                                        >
                                            <span>📱</span>
                                            <span>{t(W.checkFromPhone)}</span>
                                        </a>

                                        {/* Make main (§5.2) */}
                                        {!isMain && !a.lost && isOwner && (
                                            <button
                                                type="button"
                                                onClick={() => handleMakeMain(a)}
                                                data-testid={`make-main-btn-${a.address}`}
                                                className="px-2.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-600 min-h-[40px] inline-flex items-center gap-1"
                                            >
                                                <span>★</span>
                                                <span>{t(W.makeMain)}</span>
                                            </button>
                                        )}

                                        {/* Remove / Release */}
                                        {isOwner && (a.former || a.source === 'owner' || a.lost) && (
                                            <button
                                                type="button"
                                                onClick={() => handleRemoveOrRelease(a)}
                                                data-testid={`remove-release-btn-${a.address}`}
                                                className="px-2.5 py-1.5 rounded-lg bg-nature-900 hover:bg-bp-danger-fill hover:text-bp-danger-on text-xs font-semibold text-bp-ink-danger border border-nature-800 min-h-[40px] inline-flex items-center gap-1"
                                            >
                                                <span>🗑️</span>
                                                <span>{isBeanPoolName(a.address) ? 'Release' : 'Remove'}</span>
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Unconfirmed address offers (from AppAddressesPanel) */}
            {report?.unconfirmed && report.unconfirmed.length > 0 && isOwner && (
                <div className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-3" data-testid="unconfirmed-offers">
                    <div className="text-xs font-bold text-bp-ink-warning uppercase tracking-wider flex items-center gap-1.5">
                        <span>⚠️</span>
                        <span>Confirm address from members&apos; apps</span>
                    </div>
                    {report.unconfirmed.map((u: AddressSighting) => (
                        <div key={u.address} className="flex flex-wrap items-center justify-between gap-3 text-xs text-nature-300">
                            <div>
                                <span className="font-mono text-white font-bold">{u.address}</span>
                                <span className="text-nature-400 ml-2">({u.busiestDay} apps reached this week)</span>
                            </div>
                            <button
                                type="button"
                                onClick={async () => {
                                    try {
                                        await confirmAppAddress(activeNode.url, u.address, cred, getTfaSessionToken(activeNode.id));
                                        setActionMessage({ text: `Confirmed ${u.address}`, type: 'success' });
                                        await loadData();
                                    } catch (err: unknown) {
                                        setActionMessage({ text: err instanceof Error ? err.message : 'Confirmation failed', type: 'error' });
                                    }
                                }}
                                className="px-3 py-1.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on"
                            >
                                Confirm
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Fresh Proof Dialog */}
            <FreshProofBox proof={proof} />
        </div>
    );
}
