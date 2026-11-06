/**
 * Settings → Appliance → "Addresses" (design scratch/fable-design/DESIGN-dns-robustness-fable.md §5.2).
 *
 * One screen for every address members and browsers reach this community at:
 *  - unified list with rows as §5.2: Address, Points at, Answers from outside, Apps today, Apps can sign, Next step;
 *  - "Check now": asks every address from outside, and says only what the rows show (a round still running, or the last
 *    round's results inside the server's 30-second gap, is never reported as a new check);
 *  - "Check from your phone": opens /check to verify outside reach on mobile data;
 *  - "Add an address": the three forms folded together (a free BeanPool name, this server's number, your own domain);
 *  - "Make main": heals / promotes an address, where the server can make it the community's address;
 *  - Recovery code reminder on the BeanPool name request: never a hard gate, protects against server loss.
 *
 * It replaces the top halves of the three panels below it, which stay for everything else an owner has: PublicAddressPanel
 * (the address service's record, tunnel controls and token, notices, spare names, the log), with OwnAddressCard (certificates)
 * inside it, and AppAddressesPanel (the warnings, and confirming an address behind its tick). A change on either side
 * re-reads the other (`changes`, onChanged).
 *
 * Central tokens only (bg-bp-*, text-bp-*, nature-*, oat-*, terra-*); accessible at 320 px with 130 % text.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ADDRESS_SCREEN_WORDS, addressReachSentence, type AddressReach } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import {
    buildAdminHeaders, checkAppAddresses, getAppAddresses, getTfaSessionToken, getTlsStatus,
    passwordField, removeAppAddress, resolveNodeApiUrl, setOwnAddress,
    type AppAddress, type AppAddressesReport,
} from '../../lib/node-client';
import { proofField, t, timeAgo, tn } from '../../lib/fresh-proof';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { useInPageConfirm } from '../common/InPageConfirm';
import { SectionErrorBoundary } from '../common/SectionErrorBoundary';
import { AppAddressesPanel, addressSourceText, standingText } from './AppAddressesPanel';
import type { RolesViewer } from './NodeRolesPanel';
import { domainOf } from './OwnAddressCard';
import { PublicAddressPanel, type PublicAddressStatus } from './PublicAddressPanel';

const W = ADDRESS_SCREEN_WORDS;

/** Remove and Release, on a row. */
const LETTING_GO_BUTTON = 'px-2.5 py-1.5 rounded-lg bg-nature-900 hover:bg-bp-danger-fill hover:text-bp-danger-on text-xs font-semibold text-bp-ink-danger border border-nature-800 disabled:opacity-50 min-h-[44px] inline-flex items-center gap-1';

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

/** How long ago, in the reader's words: "just now", "3 minutes ago". '' for no time. */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? timeAgo(now - ms) : '';
}

/** The newest time any row was asked: the rows' own, never this browser's clock. */
export function latestCheck(addresses: AppAddress[] | undefined): string | null {
    let newest: string | null = null;
    for (const a of addresses ?? []) {
        const at = a.reach?.checkedAt;
        if (at && Number.isFinite(Date.parse(at)) && (!newest || Date.parse(at) > Date.parse(newest))) newest = at;
    }
    return newest;
}

/** The state of the tunnel that serves `host`, or undefined when the node says of none: that row claims none. */
export function tunnelStateOf(host: string, st: PublicAddressStatus | null): string | undefined {
    if (!st?.tunnel) return undefined;
    const stored = st.hostname || (st.name ? `${st.name}.beanpool.org` : '');
    if (stored === host) return st.tunnel.state;
    return st.tunnel.others?.find((o) => o.host === host)?.state;
}

export function pointsAtText(address: string, reach?: AddressReach | null, tunnelState?: string): string {
    if (isBeanPoolName(address) && tunnelState) {
        if (tunnelState === 'connected') return t(W.pointsTunnelConnected);
        if (tunnelState === 'retrying') return t(W.pointsTunnelRetrying);
        if (tunnelState === 'starting') return t(W.pointsTunnelStarting);
        if (tunnelState === 'disconnected') return t(W.pointsTunnelDisconnected);
        return t(W.pointsTunnelOff);
    }
    if (isIpAddress(address)) return address;
    if (!reach) return t('not checked yet');
    // What DNS records were seen
    const a = reach.dns?.a ?? [];
    const aaaa = reach.dns?.aaaa ?? [];
    const cname = reach.dns?.cname ?? [];
    const records = [...a, ...aaaa];
    if (records.length > 0) return records.join(', ');
    if (cname.length > 0) return cname.join(', ');
    return t(W.pointsNoDns);
}

export function answersText(reach?: AddressReach | null): string {
    if (!reach) return t('not checked yet');
    if (reach.answers === 'own') {
        return t(W.answersAnswered, { time: formatRelativeTime(reach.checkedAt) || formatTime(reach.checkedAt) });
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
    return tn(today, W.appsCount.one, W.appsCount.other);
}

/**
 * The reach sentence. Beside a name's standing, which says what to do, it never adds "Nothing to do": a lost name with
 * members still on it is not a closed matter. The rule is core's (addressReachSentence), which an owner's assistant reads
 * too (apps/server agent/server-addresses.ts). A step this manager doesn't know reads as the node said it.
 */
export function reachSentence(reach: AddressReach, besideStanding: boolean): string {
    return addressReachSentence(reach.step, reach.minutes, besideStanding, { t, tn }) || reach.nextStep;
}

/**
 * Whether the server can make `host` the community's address (services/public-address-agent.ts asCommunityAddress): a name
 * always, as a claim; an own address never over a BeanPool name, and a number never over a domain. A press that can only be
 * refused is not offered.
 */
export function canBecomeMain(host: string, primary: string | null | undefined): boolean {
    if (isBeanPoolName(host) || !primary) return true;
    if (isBeanPoolName(primary)) return false;
    return !(isIpAddress(host) && !isIpAddress(primary));
}

/**
 * Whether a row offers Make main. A hard-coded address is set by hand and no claim of it is held (design §6), and a name the
 * project stopped is only refused, or, paused, stored and left dark. The record says so whatever the check found: `stopped`
 * covers a former name and a stale check, which the step doesn't; the step covers a server before the record's flag. A name
 * another key holds is refused too, once a code is spent, and Add an address still reaches it if that reading is out of date.
 * A pause that isn't the project's stays: there Make main is the heal. So does a released name: there it is the take-back.
 */
export function offersMakeMain(a: AppAddress, primary: string | null | undefined): boolean {
    return a.source !== 'env' && !a.hardCoded && !a.stopped && a.reach?.step !== 'stopped' && a.standing?.registrarSays !== 'other' && canBecomeMain(a.address, primary);
}

/** A name as typed or pasted (a whole host, capitals, spaces): the label the claim takes. */
export function cleanSubdomain(typed: string): string {
    return typed.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.beanpool\.org.*$/, '').replace(/[^a-z0-9-]+/g, '');
}

export interface AddressesPanelProps {
    activeNode: NodeProfile;
    onRefreshDiag?: () => void;
    viewer?: RolesViewer;
}

export function AddressesPanel({ activeNode, onRefreshDiag, viewer = { kind: 'password' } }: AddressesPanelProps) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const [report, setReport] = useState<AppAddressesReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' | 'warning' } | null>(null);
    const messageRef = useRef<HTMLDivElement>(null);
    // The action running, as `make-main:<address>`: every row's buttons wait, so a double tap can't send two.
    const [busy, setBusy] = useState<string | null>(null);
    // A claim is running: the log below streams it, as it does a restart or Take offline.
    const [claiming, setClaiming] = useState(false);
    // Each change made here: the panels below read again.
    const [changes, setChanges] = useState(0);

    // What PublicAddressPanel last read of the address service and the tunnel.
    const [addressStatus, setAddressStatus] = useState<PublicAddressStatus | null>(null);

    // "Add an address" section state
    const [showAddSection, setShowAddSection] = useState(false);
    const [addKind, setAddKind] = useState<'beanpool' | 'ip' | 'domain'>('beanpool');
    const [beanpoolSubdomain, setBeanpoolSubdomain] = useState('');
    const [communityName, setCommunityName] = useState('');
    const [contact, setContact] = useState('');
    const [ipInput, setIpInput] = useState('');
    const [domainInput, setDomainInput] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [submittingAdd, setSubmittingAdd] = useState(false);

    // Fresh proof
    const proof = useFreshProof();
    const [ask, confirmation] = useInPageConfirm();
    const cred = nodeCredential(activeNode);

    // Unique IDs for form labels
    const subdomainId = useId();
    const communityNameId = useId();
    const contactId = useId();
    const modeLabelId = useId();
    const ipInputId = useId();
    const domainInputId = useId();

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setReport(await getAppAddresses(activeNode.url, cred, getTfaSessionToken(activeNode.id)));
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : t('Failed to load addresses'));
        } finally {
            setLoading(false);
        }
    }, [activeNode.url, cred, activeNode.id]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // The form shows what this server holds for a claim, as the claim keeps it when the form says nothing.
    const readAddressStatus = useCallback((st: PublicAddressStatus) => {
        setAddressStatus(st);
        const held = st.communityName || st.community_name;
        if (held) setCommunityName((prev) => prev || String(held));
        if (st.contact) setContact((prev) => prev || String(st.contact));
    }, []);

    // A result lands at the top of the screen: on a phone the row pressed can be a long way below it.
    useEffect(() => {
        if (actionMessage) messageRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [actionMessage]);

    /** After a change here: this list, the panels below, and the page's header. */
    const afterChange = async () => {
        await loadData();
        setChanges((n) => n + 1);
        onRefreshDiag?.();
    };

    // Handle "Check now": says what came back, never more. The server answers `checking` for a round that hasn't finished,
    // and the last round's report, with no new round, within 30 seconds of one (services/address-check.ts).
    const handleCheckNow = async () => {
        const before = latestCheck(report?.addresses);
        setChecking(true);
        setActionMessage(null);
        try {
            const updated = await checkAppAddresses(activeNode.url, cred, getTfaSessionToken(activeNode.id));
            setReport(updated);
            const after = latestCheck(updated.addresses);
            if (updated.checking) {
                setActionMessage({ text: t(W.stillChecking), type: 'warning' });
            } else if (after && (!before || Date.parse(after) > Date.parse(before))) {
                setActionMessage({ text: t(W.checkedFromOutside), type: 'success' });
            } else if (after) {
                setActionMessage({ text: t(W.checkedAlready, { time: formatTime(after) }), type: 'warning' });
            } else {
                setActionMessage({ text: t(W.nothingChecked), type: 'warning' });
            }
        } catch (e: unknown) {
            setActionMessage({ text: e instanceof Error ? e.message : t('Check failed'), type: 'error' });
        } finally {
            setChecking(false);
        }
    };

    // Handle "Make main"
    const handleMakeMain = async (a: AppAddress, code?: string) => {
        setActionMessage(null);
        setBusy(`make-main:${a.address}`);
        try {
            let got: { communityAddress?: boolean } | undefined;
            if (isBeanPoolName(a.address)) {
                const name = extractSubdomain(a.address);
                setClaiming(true);
                // No contact or community name: the claim keeps what this server holds (routes/public-address.ts).
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/claim'), {
                    method: 'POST',
                    headers: buildAdminHeaders(cred, getTfaSessionToken(activeNode.id)),
                    body: JSON.stringify({
                        ...passwordField(cred),
                        name,
                        mode: 'tunnel',
                        ...proofField(code),
                    }),
                });
                if (await proof.check(res, (c) => handleMakeMain(a, c), code)) return;
                const body = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(body?.error || `HTTP ${res.status}`);
                }
                // Only a live answer moves the community, but the claim stores any answer it gets: the panel below moves to a
                // paused name (a heal refused, or a pause this row couldn't know of) while members stay where they are.
                if (body?.status !== 'live') {
                    proof.close();
                    const current = report?.primaryAddress;
                    const said = { address: a.address, status: String(body?.status ?? 'nothing') };
                    setActionMessage({
                        text: body?.status === 'pending' && body?.reason !== 'provisioning'
                            ? t('Requested {address}, awaiting approval by the BeanPool project.', { address: a.address })
                            : current ? t(W.notMainYetMembersAt, { ...said, current }) : t(W.notMainYet, said),
                        type: 'warning',
                    });
                    await afterChange();
                    return;
                }
            } else if (isIpAddress(a.address)) {
                got = await setOwnAddress(activeNode.url, { ip: a.address }, cred, getTfaSessionToken(activeNode.id), code);
            } else {
                got = await setOwnAddress(activeNode.url, { domain: a.address }, cred, getTfaSessionToken(activeNode.id), code);
            }
            proof.close();
            if (got && !got.communityAddress) {
                setActionMessage({ text: t('{address} added, but could not replace the active address.', { address: a.address }), type: 'warning' });
            } else {
                setActionMessage({ text: t('{address} is now the main address.', { address: a.address }), type: 'success' });
            }
            await afterChange();
        } catch (e: unknown) {
            if (proof.checkError(e, (c) => handleMakeMain(a, c), code)) return;
            setActionMessage({ text: e instanceof Error ? e.message : t('Could not make main'), type: 'error' });
        } finally {
            setClaiming(false);
            setBusy(null);
        }
    };

    /** What releasing a name means, in the words the spare-names list uses: it goes back to the pool. */
    const releaseQuestion = (a: AppAddress) => {
        const current = report?.primaryAddress;
        const works = a.reach?.answers === 'own' || a.today > 0 || a.busiestDay > 0;
        if (!works) {
            return {
                title: t('Release a name this community does not use'),
                body: current
                    ? t("Release {address}? Your community's address stays {current}. Another community can claim {address} once the address service's hold ends.", { address: a.address, current })
                    : t("Release {address}? Another community can claim {address} once the address service's hold ends.", { address: a.address }),
            };
        }
        return {
            title: t('Release an address that still works'),
            body: current
                ? t("Release {address}? Phones still using this address lose the community. Your community's address stays {current}. Another community can claim {address} once the address service's hold ends.", { address: a.address, current })
                : t("Release {address}? Phones still using this address lose the community. Another community can claim {address} once the address service's hold ends.", { address: a.address }),
        };
    };

    /**
     * What removing means. A BeanPool name stays this key's, as only Release gives one up: off the list, it reads as a former
     * name and stays accepted (registrar-names.ts). One this key doesn't hold simply goes, and its apps with it.
     */
    const removeQuestion = (a: AppAddress) => {
        const main = a.address === report?.primaryAddress;
        const title = t('Remove {address}?', { address: a.address });
        if (isBeanPoolName(a.address)) {
            return { title, body: main ? t(W.removeMainNameQuestion, { address: a.address }) : t(W.removeNameQuestion, { address: a.address }) };
        }
        return {
            title,
            body: main
                ? t("It is this community's address. Members' apps that use it are refused after this, and new members are sent to another of its addresses, if it has one.")
                : t("Members' apps that use it are refused after this."),
        };
    };

    // Handle "Remove" or "Release": whichever was pressed. A BeanPool name on the owner list offers both.
    const handleRemoveOrRelease = async (a: AppAddress, how: 'remove' | 'release', code?: string) => {
        setActionMessage(null);
        const release = how === 'release';
        if (code === undefined) {
            const question = release ? releaseQuestion(a) : removeQuestion(a);
            const yes = await ask({ ...question, confirmLabel: release ? t(W.release) : t(W.remove), cancelLabel: t('Keep it') });
            if (!yes) return;
        }
        setBusy(`${how}:${a.address}`);
        try {
            if (release) {
                const name = extractSubdomain(a.address);
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/release-name'), {
                    method: 'POST',
                    headers: buildAdminHeaders(cred, getTfaSessionToken(activeNode.id)),
                    body: JSON.stringify({
                        ...passwordField(cred),
                        name,
                        ...proofField(code),
                    }),
                });
                if (await proof.check(res, (c) => handleRemoveOrRelease(a, how, c), code)) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body?.error || `HTTP ${res.status}`);
                }
            } else {
                await removeAppAddress(activeNode.url, a.address, cred, getTfaSessionToken(activeNode.id), code);
            }
            proof.close();
            const done = release
                ? t("{address} released. This community's address is unchanged.", { address: a.address })
                : isBeanPoolName(a.address) ? t(W.removedName, { address: a.address }) : t('{address} removed.', { address: a.address });
            setActionMessage({ text: done, type: 'success' });
            await afterChange();
        } catch (e: unknown) {
            if (proof.checkError(e, (c) => handleRemoveOrRelease(a, how, c), code)) return;
            setActionMessage({ text: e instanceof Error ? e.message : t('Could not remove address'), type: 'error' });
        } finally {
            setBusy(null);
        }
    };

    /** A claim's answer, in the words the claim form always used. */
    const claimAnswered = (body: { status?: string; warning?: string }) => {
        if (body.status !== 'live') setActionMessage({ text: t('Claimed: awaiting registrar approval'), type: 'warning' });
        else if (body.warning) setActionMessage({ text: t('Address claimed! It can take a few minutes for the Cloudflare Tunnel to connect globally.'), type: 'warning' });
        else setActionMessage({ text: t('Address live and verified.'), type: 'success' });
    };

    /** An own address taken: what happens next, and whether it became the community's address. */
    const ownAnswered = async (got: { address: string; communityAddress: boolean }) => {
        const tls = await getTlsStatus(activeNode.url, cred, getTfaSessionToken(activeNode.id)).catch(() => null);
        const ca = tls?.ca ?? 'the CA';
        setActionMessage({
            type: 'success',
            text: got.communityAddress
                ? t("{address} is this community's address now, and the server is asking {ca} for its certificate. This takes a minute or two once the address leads to this server.", { address: got.address, ca })
                : t('{address} added, and the server is asking {ca} for its certificate. This takes a minute or two once the address leads to this server.', { address: got.address, ca }),
        });
    };

    // Handle adding an address (folded form submission)
    const handleAddSubmit = async (e?: React.FormEvent, code?: string) => {
        if (e) e.preventDefault();
        setFormError(null);
        setActionMessage(null);
        const name = cleanSubdomain(beanpoolSubdomain);
        if (addKind === 'beanpool' && !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(name)) {
            setFormError(t('Invalid name (3–32 chars: a–z, 0–9, hyphen, no leading/trailing hyphen)'));
            return;
        }
        setSubmittingAdd(true);
        try {
            if (addKind === 'beanpool') {
                setClaiming(true);
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/public-address/claim'), {
                    method: 'POST',
                    headers: buildAdminHeaders(cred, getTfaSessionToken(activeNode.id)),
                    body: JSON.stringify({
                        ...passwordField(cred),
                        name,
                        // Always a tunnel: a direct name needs this server's public IPv4 address, which Settings can't know
                        // (SEC-REG-01, verified 2026-10-16). Direct stays for operators who set PUBLIC_ADDRESS_MODE=direct
                        // and PUBLIC_ADDRESS_IP themselves.
                        mode: 'tunnel',
                        communityName: communityName.trim() || undefined,
                        // Blank, never left out: the claim keeps what it isn't sent, and a field the owner cleared means none.
                        contact: contact.trim(),
                        ...proofField(code),
                    }),
                });
                if (await proof.check(res, (c) => handleAddSubmit(undefined, c), code)) return;
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
                claimAnswered(body);
                setBeanpoolSubdomain('');
            } else if (addKind === 'ip') {
                const ip = ipInput.trim();
                await ownAnswered(await setOwnAddress(activeNode.url, { ip }, cred, getTfaSessionToken(activeNode.id), code));
                setIpInput('');
            } else {
                const domain = domainOf(domainInput);
                await ownAnswered(await setOwnAddress(activeNode.url, { domain }, cred, getTfaSessionToken(activeNode.id), code));
                setDomainInput('');
            }
            proof.close();
            setShowAddSection(false);
            await afterChange();
        } catch (err: unknown) {
            if (proof.checkError(err, (c) => handleAddSubmit(undefined, c), code)) return;
            setActionMessage({ text: err instanceof Error ? err.message : t('Failed to add address'), type: 'error' });
        } finally {
            setClaiming(false);
            setSubmittingAdd(false);
        }
    };

    // Sort addresses: main first, then active configured, then former and lost
    const primary = report?.primaryAddress;
    const lastCheckedAt = latestCheck(report?.addresses);
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
                                aria-expanded={showAddSection}
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
                        <span aria-hidden="true">🕒</span>
                        <span>{t(W.checkedAt, { time: formatTime(lastCheckedAt) })}</span>
                    </div>
                )}

                {actionMessage && (
                    <div
                        ref={messageRef}
                        role={actionMessage.type === 'error' ? 'alert' : 'status'}
                        aria-live={actionMessage.type === 'error' ? 'assertive' : 'polite'}
                        data-testid="addresses-action-message"
                        className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                            actionMessage.type === 'error'
                                ? 'bg-bp-chip-danger-tint border-nature-700 text-bp-chip-danger-ink'
                                : actionMessage.type === 'warning'
                                ? 'bg-bp-chip-warn-tint border-nature-700 text-bp-chip-warn-ink'
                                : 'bg-bp-chip-ok-tint border-nature-700 text-bp-chip-ok-ink'
                        }`}
                    >
                        <span className="min-w-0 [overflow-wrap:anywhere]">{actionMessage.text}</span>
                        <button
                            type="button"
                            onClick={() => setActionMessage(null)}
                            className="shrink-0 text-nature-400 hover:text-white font-bold min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                            aria-label={t('Dismiss message')}
                        >
                            <span aria-hidden="true">✕</span>
                        </button>
                    </div>
                )}

                {error && (
                    <div role="alert" className="p-3 rounded-xl border border-nature-700 bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-semibold flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
                        <button
                            type="button"
                            onClick={() => loadData()}
                            disabled={loading}
                            data-testid="addresses-retry"
                            className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-700 disabled:opacity-50 min-h-[44px]"
                        >
                            {t('Try again')}
                        </button>
                    </div>
                )}

                {/* Fresh Proof Dialog */}
                <FreshProofBox proof={proof} testId="address-proof" />
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
                            aria-label={t('Close Add an address')}
                            data-testid="add-address-close"
                            className="text-nature-400 hover:text-white text-xs min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg"
                        >
                            <span aria-hidden="true">✕</span>
                        </button>
                    </div>

                    {/* Three folded choices */}
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            aria-pressed={addKind === 'beanpool'}
                            onClick={() => { setAddKind('beanpool'); setFormError(null); }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[44px] ${
                                addKind === 'beanpool'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceBeanPool)}
                        </button>
                        <button
                            type="button"
                            aria-pressed={addKind === 'ip'}
                            onClick={() => { setAddKind('ip'); setFormError(null); }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[44px] ${
                                addKind === 'ip'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceNumber)}
                        </button>
                        <button
                            type="button"
                            aria-pressed={addKind === 'domain'}
                            onClick={() => { setAddKind('domain'); setFormError(null); }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all min-h-[44px] ${
                                addKind === 'domain'
                                    ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40'
                                    : 'bg-nature-900 text-nature-300 hover:text-white border border-nature-800'
                            }`}
                        >
                            {t(W.choiceDomain)}
                        </button>
                    </div>

                    {formError && (
                        <div role="alert" className="p-3 rounded-xl bg-bp-chip-danger-tint border border-nature-700 text-xs font-semibold text-bp-chip-danger-ink">
                            {formError}
                        </div>
                    )}

                    <form onSubmit={handleAddSubmit} className="space-y-4" data-testid="claim-form">
                        {addKind === 'beanpool' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={subdomainId} className="block text-xs font-bold text-nature-300 mb-1">
                                        {t('Subdomain Prefix')}
                                    </label>
                                    <div className="flex flex-wrap items-center gap-1 font-mono text-sm">
                                        <input
                                            id={subdomainId}
                                            type="text"
                                            value={beanpoolSubdomain}
                                            onChange={(e) => { setBeanpoolSubdomain(cleanSubdomain(e.target.value)); setFormError(null); }}
                                            placeholder={t('e.g. cairns')}
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px] flex-1 min-w-0"
                                        />
                                        <span className="text-nature-400 font-mono text-xs">.beanpool.org</span>
                                    </div>
                                    <div className="mt-1.5 p-2 rounded-lg bg-nature-900 border border-nature-800 text-[11px] font-mono text-bp-ink-success flex items-center gap-1 break-all">
                                        <span className="shrink-0">{t('URL:')}</span>
                                        <strong className="font-bold min-w-0">{`https://${cleanSubdomain(beanpoolSubdomain) || 'cairns'}.beanpool.org`}</strong>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label htmlFor={communityNameId} className="block text-xs font-bold text-nature-300 mb-1">
                                            {t('Community / Pool Name')}
                                        </label>
                                        <input
                                            id={communityNameId}
                                            type="text"
                                            value={communityName}
                                            onChange={(e) => setCommunityName(e.target.value)}
                                            placeholder={t('e.g. Cairns Community')}
                                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                                        />
                                        <span className="text-[10px] text-nature-400 block mt-1">
                                            {t('Displayed in public directory and browser title')}
                                        </span>
                                    </div>
                                    <div>
                                        <label htmlFor={contactId} className="block text-xs font-bold text-nature-300 mb-1">
                                            {t('Operator Contact (Email or Handle)')}
                                        </label>
                                        <input
                                            id={contactId}
                                            type="text"
                                            value={contact}
                                            onChange={(e) => setContact(e.target.value)}
                                            placeholder={t('e.g. name@yourdomain.org')}
                                            className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                                        />
                                        <span className="text-[10px] text-nature-400 block mt-1">
                                            {t("Optional. Only the BeanPool project sees it, to reach you about this name; it is never checked, and it is deleted when the name's hold ends.")}
                                        </span>
                                    </div>
                                </div>

                                <div>
                                    <span id={modeLabelId} className="block text-xs font-bold text-nature-300 mb-1">
                                        {t('Reachability Mode')}
                                    </span>
                                    <div aria-labelledby={modeLabelId} data-testid="pubaddr-mode" className="w-full bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white min-h-[44px] flex items-center">
                                        <span aria-hidden="true" className="mr-1">🛡️</span>
                                        <span>{t('Tunnel')}</span>
                                    </div>
                                    <div className="text-[10px] text-nature-400 mt-1 leading-normal">
                                        {t('The server dials out to Cloudflare itself. Works behind NAT/firewalls, dynamic IP friendly, DDoS shielded, no exposed origin IP.')}
                                    </div>
                                </div>

                                {/* Recovery Code Reminder (Item 3: Never a gate!) */}
                                <div
                                    data-testid="recovery-code-reminder"
                                    className="p-3 rounded-xl bg-nature-900 border border-nature-800 text-xs text-nature-300 flex items-start gap-2.5"
                                >
                                    <span className="text-base select-none" aria-hidden="true">🛡️</span>
                                    <div className="space-y-1">
                                        <p className="m-0 leading-relaxed font-medium">
                                            {t(W.recoveryReminder)}
                                        </p>
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {submittingAdd ? t('Registering with Registrar…') : t('Go public · Claim Web Address')}
                                </button>
                            </div>
                        )}

                        {addKind === 'ip' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={ipInputId} className="block text-xs font-bold text-nature-300 mb-1">
                                        {t("This server's public IP address")}
                                    </label>
                                    <input
                                        id={ipInputId}
                                        type="text"
                                        inputMode="decimal"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={ipInput}
                                        onChange={(e) => setIpInput(e.target.value)}
                                        placeholder={t('e.g. 203.0.113.5')}
                                        className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px] w-full max-w-md"
                                    />
                                    <p className="text-[11px] text-nature-400 mt-1 m-0">
                                        {t('The one your hosting company gave this server. Ports 80 and 443 must reach it.')}
                                    </p>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd || !ipInput.trim()}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {t('Use this IP address')}
                                </button>
                            </div>
                        )}

                        {addKind === 'domain' && (
                            <div className="space-y-3">
                                <div>
                                    <label htmlFor={domainInputId} className="block text-xs font-bold text-nature-300 mb-1">
                                        {t('Your own domain name')}
                                    </label>
                                    <input
                                        id={domainInputId}
                                        type="text"
                                        inputMode="url"
                                        autoCapitalize="none"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={domainInput}
                                        onChange={(e) => setDomainInput(e.target.value)}
                                        placeholder={t('e.g. beans.example.org')}
                                        className="bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px] w-full max-w-md"
                                    />
                                    <p className="text-[11px] text-nature-400 mt-1 m-0">
                                        {t("Point an A record for it at this server's public IP address first.")}
                                    </p>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submittingAdd || !domainOf(domainInput)}
                                    className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-semibold text-bp-cta-on disabled:opacity-50 min-h-[44px]"
                                >
                                    {t('Use this domain')}
                                </button>
                            </div>
                        )}
                    </form>
                </div>
            )}

            {/* The Unified Addresses List (§5.2) */}
            <div className="space-y-3" data-testid="addresses-list">
                <div className="flex flex-wrap items-center justify-between gap-1 text-xs font-semibold text-nature-400 uppercase tracking-wider px-1">
                    <span>{t('Configured Addresses')}</span>
                    {report && <span>{tn(sortedAddresses.length, '{n} address', '{n} addresses')}</span>}
                </div>

                {!report && loading && (
                    <div className="p-6 rounded-2xl bg-nature-950 border border-nature-800 text-center text-xs text-nature-400" data-testid="addresses-loading">
                        {t('Reading addresses…')}
                    </div>
                )}

                {report && sortedAddresses.length === 0 && !loading && (
                    <div className="p-6 rounded-2xl bg-nature-950 border border-nature-800 text-center text-xs text-nature-400">
                        {isOwner ? t('No addresses configured yet. Press "Add an address" above to set one up.') : t('No addresses configured yet.')}
                    </div>
                )}

                {sortedAddresses.map((a) => {
                    const isMain = a.address === primary || (!primary && a.source === 'public-address');
                    const isInactive = a.former || a.lost;
                    const kind = addressKind(a.address);
                    const points = pointsAtText(a.address, a.reach, tunnelStateOf(a.address, addressStatus));
                    const answers = answersText(a.reach);
                    const apps = appsTodayText(a.today);
                    const sign = signingText(a);
                    // Standing first, whenever there is one: what a check found never hides what the name's state means.
                    const standing = standingText(a);
                    const nextStep = a.reach ? reachSentence(a.reach, !!standing) : null;
                    // Remove takes an address off the owner's list, whatever the host: a rename puts the old name there, so it
                    // stops being advertised and stays this key's, and a name this key doesn't hold can come off at all.
                    const canRemove = isOwner && a.source === 'owner';
                    // Release gives a BeanPool name up: only where the community isn't living at it now, and where nothing says
                    // this key has let it go already or doesn't hold it, as the node would refuse that once a code is spent.
                    const canRelease = isOwner && isBeanPoolName(a.address) && !a.lost && !isMain && (a.former || a.source === 'owner') && !a.stopped && !a.standing?.registrarSays;
                    // A lost name now leads to another community, and a home-network one leads nowhere from a phone.
                    const canCheckFromPhone = !a.lost && a.reach?.step !== 'home-network';

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
                                        {a.former && !a.lost && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-nature-900 text-nature-400 border border-nature-800">
                                                {t(W.badgeFormer)}
                                            </span>
                                        )}
                                        {a.lost && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-bp-chip-danger-tint text-bp-chip-danger-ink border border-nature-800">
                                                {t(W.badgeLost)}
                                            </span>
                                        )}
                                    </div>

                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-nature-400">
                                        <span title={t('Apps that reached this community at this address today')}>
                                            📱 {apps}
                                        </span>
                                        <span title={t('Whether apps can sign for this address')}>
                                            ✍️ {sign}
                                        </span>
                                    </div>
                                </div>

                                {/* Where it comes from, and the busiest day, as the panel this list replaces said */}
                                <p className="m-0 text-xs text-nature-400 [overflow-wrap:anywhere]" data-testid="address-source">
                                    <span>{addressSourceText(a)}</span>
                                    <span aria-hidden="true"> · </span>
                                    <span>{t('most in one day this week: {n}', { n: a.busiestDay })}</span>
                                </p>

                                {/* Line 2: Points at + Answers from outside. Label above value on a narrow screen: a value's
                                    word can be wider than what a label beside it would leave. */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-1.5 min-w-0" data-testid="address-points-at">
                                        <span className="text-nature-400 sm:shrink-0">{t(W.colPointsAtLabel)}</span>
                                        <span className="font-mono text-nature-200 min-w-0 [overflow-wrap:anywhere]">{points}</span>
                                    </div>
                                    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-1.5 min-w-0" data-testid="address-answers">
                                        <span className="text-nature-400 sm:shrink-0">{t(W.colAnswersLabel)}</span>
                                        <span
                                            className={`font-medium min-w-0 [overflow-wrap:anywhere] ${
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
                                    <div className="text-xs text-nature-300 min-w-0 pr-2 space-y-1">
                                        {standing && (
                                            <p
                                                className={`m-0 leading-relaxed break-words [overflow-wrap:anywhere] ${standing.lost ? 'text-bp-ink-danger' : 'text-bp-ink-warning'}`}
                                                data-testid="app-address-standing"
                                                data-state={standing.lost ? 'lost' : a.standing?.state}
                                            >
                                                {standing.text}
                                            </p>
                                        )}
                                        {nextStep && (
                                            <p className="m-0 leading-relaxed font-normal" data-testid="next-step-text">
                                                <span aria-hidden="true">👉 </span>{nextStep}
                                            </p>
                                        )}
                                    </div>

                                    {/* Action buttons */}
                                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                                        {/* Check from your phone (§5.3: opens /check) */}
                                        {canCheckFromPhone && (
                                            <a
                                                href={`https://${a.address}/check`}
                                                target="_blank"
                                                rel="noreferrer"
                                                data-testid={`check-phone-link-${a.address}`}
                                                className="px-2.5 py-1.5 rounded-lg bg-nature-900 hover:bg-nature-800 text-xs font-semibold text-bp-ink-terra hover:text-white border border-nature-700 min-h-[48px] inline-flex items-center gap-1"
                                            >
                                                <span aria-hidden="true">📱</span>
                                                <span>{t(W.checkFromPhone)}</span>
                                            </a>
                                        )}

                                        {/* Make main (§5.2) */}
                                        {!isMain && !a.lost && isOwner && offersMakeMain(a, primary) && (
                                            <button
                                                type="button"
                                                disabled={busy !== null}
                                                aria-busy={busy === `make-main:${a.address}`}
                                                aria-label={t('Make main {address}', { address: a.address })}
                                                onClick={() => handleMakeMain(a)}
                                                data-testid={`make-main-btn-${a.address}`}
                                                className="px-2.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-semibold text-white border border-nature-600 disabled:opacity-50 min-h-[44px] inline-flex items-center gap-1"
                                            >
                                                <span aria-hidden="true">{busy === `make-main:${a.address}` ? '⏳' : '★'}</span>
                                                <span>{t(W.makeMain)}</span>
                                            </button>
                                        )}

                                        {/* Remove and Release (§5.2: as today): a BeanPool name on the owner list has both */}
                                        {canRemove && (
                                            <button
                                                type="button"
                                                disabled={busy !== null}
                                                aria-busy={busy === `remove:${a.address}`}
                                                onClick={() => handleRemoveOrRelease(a, 'remove')}
                                                data-testid={`remove-btn-${a.address}`}
                                                aria-label={t('Remove {address}', { address: a.address })}
                                                className={LETTING_GO_BUTTON}
                                            >
                                                <span aria-hidden="true">{busy === `remove:${a.address}` ? '⏳' : '🗑️'}</span>
                                                <span>{t(W.remove)}</span>
                                            </button>
                                        )}
                                        {canRelease && (
                                            <button
                                                type="button"
                                                disabled={busy !== null}
                                                aria-busy={busy === `release:${a.address}`}
                                                onClick={() => handleRemoveOrRelease(a, 'release')}
                                                data-testid={`release-btn-${a.address}`}
                                                aria-label={t('Release {address}', { address: a.address })}
                                                className={LETTING_GO_BUTTON}
                                            >
                                                <span aria-hidden="true">{busy === `release:${a.address}` ? '⏳' : '↩️'}</span>
                                                <span>{t(W.release)}</span>
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}

                {isOwner && sortedAddresses.length > 0 && sortedAddresses.every((a) => isBeanPoolName(a.address)) && (
                    <div
                        data-testid="second-way-nudge"
                        className="p-3 rounded-xl bg-nature-950/60 border border-nature-800 text-xs text-nature-300 flex items-start gap-2.5"
                    >
                        <span className="text-base select-none" aria-hidden="true">💡</span>
                        <p className="m-0 leading-relaxed font-medium">
                            {t(W.secondWayInNudge)}
                        </p>
                    </div>
                )}
            </div>

            {/* The lower halves of the panels this list replaces (design §5.2): nothing an owner has goes. */}
            <SectionErrorBoundary sectionName="Public Address" resetKey={activeNode.id}>
                <PublicAddressPanel
                    key={activeNode.id}
                    activeNode={activeNode}
                    onRefreshDiag={onRefreshDiag}
                    viewer={viewer}
                    onStatus={readAddressStatus}
                    onChanged={loadData}
                    refreshSignal={changes}
                    claiming={claiming}
                />
            </SectionErrorBoundary>
            <SectionErrorBoundary sectionName="App addresses" resetKey={activeNode.id}>
                <AppAddressesPanel key={activeNode.id} activeNode={activeNode} onChanged={loadData} refreshSignal={changes} />
            </SectionErrorBoundary>

            {confirmation}
        </div>
    );
}
