/**
 * Settings → Public Address → "Your own address" (HTTPS S4; design scratch/global-node/DESIGN-https-anywhere-fable.md §4):
 * this server's public IP address, or a domain the owner points at it, without a .beanpool.org name or a Cloudflare
 * account. Owner-only, as every address change is: drawn only when the node answers GET /api/local/admin/tls/status
 * (an admin's 403, or an older server without the route, draws nothing). A read that fails any other way (a 5xx, no
 * connection) keeps what was last read, with Refresh, and says it could not refresh; a first read that fails so draws the
 * heading, that and Refresh, and nothing else (#2148 review 4306127405).
 *
 *   - see: every address the server holds a certificate for, or asks one for, with the certificate's dates (valid until,
 *     renews about) or why the last try failed and when it is tried next, in the server's own words;
 *   - add: POST /public-address/own { ip } or { domain }. Moving the community's live own address to another of its kind
 *     asks an owner's fresh proof (the box opens in this card);
 *   - try again: the same address given again, which the server takes as the owner's retry past its back-off (as
 *     `beanpool claim --ip` run again). Offered only where the server says that is all it does (retryOnly): one kept beside
 *     the community's address that would take its place, given again, is not offered it (#2148 review 4306126212);
 *   - remove: app-addresses/remove, after an in-page question, with an owner's fresh proof each time: members' apps that
 *     use the address are refused after it.
 *
 * Words through t() (lib/fresh-proof); status colours from the central tokens (bp-*), as the rest of Settings.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import {
    getTfaSessionToken, getTlsStatus, removeAppAddress, setOwnAddress,
    type OwnAddressInput, type TlsIdentifierStatus, type TlsStatus,
} from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { useInPageConfirm } from '../common/InPageConfirm';

const DAY_MS = 24 * 60 * 60_000;

/** A moment as Settings shows one to the owner: day, month and time, in the browser's own zone. '' for none. */
export function formatMoment(iso: string | null | undefined): string {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms)
        ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
}

/** A domain as typed (`https://beans.example.org/`, with a path): its host, as /own takes it. */
export function domainOf(typed: string): string {
    return typed.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
}

/** Where an address comes from, in words, when it is not the community's address. */
function sourceText(id: TlsIdentifierStatus): string {
    switch (id.source) {
        case 'env': return t('Set on the server (BEANPOOL_ADDRESSES).');
        case 'fleet': return t("This server's name (CF_RECORD_NAME), certified through Cloudflare.");
        case 'owner': return t('Added in Settings or with beanpool claim. Members who use it keep working.');
        default: return t("One of this community's addresses.");
    }
}

type Message = { text: string; type: 'success' | 'error' | 'info' };

export function OwnAddressCard({ activeNode, enabled }: { activeNode: NodeProfile; enabled: boolean }) {
    const [status, setStatus] = useState<TlsStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [ip, setIp] = useState('');
    const [domain, setDomain] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState<Message | null>(null);
    /** Why the last read failed: shown beside `message`, so a change that went through keeps its own words. */
    const [loadError, setLoadError] = useState<string | null>(null);
    const proof = useFreshProof();
    const [ask, confirmation] = useInPageConfirm();
    const credential = nodeCredential(activeNode);

    const load = useCallback(async () => {
        if (!enabled) return;
        setLoading(true);
        try {
            // Null: the node offers no such answer (an admin's 403, an older server), so the card is not drawn.
            setStatus(await getTlsStatus(activeNode.url, credential, getTfaSessionToken(activeNode.id)));
            setLoadError(null);
        } catch (e) {
            // Anything else keeps what was last read, with Refresh, and says so.
            setLoadError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [enabled, activeNode.url, activeNode.id, credential]);

    // Another address or sign-in for this node: nothing read through the last one is kept.
    useEffect(() => { setStatus(null); setLoadError(null); void load(); }, [load]);

    const give = async (input: OwnAddressInput, again: boolean, code?: string) => {
        const address = 'ip' in input ? input.ip : input.domain;
        setBusy(address);
        setMessage(null);
        try {
            const got = await setOwnAddress(activeNode.url, input, credential, getTfaSessionToken(activeNode.id), code);
            proof.close();
            if (again) {
                setMessage({ type: 'info', text: t('{address} is being tried again now. Refresh in a minute to see how it went.', { address: got.address }) });
            } else {
                setMessage({
                    type: 'success',
                    text: got.communityAddress
                        ? t("{address} is this community's address now, and the server is asking {ca} for its certificate. This takes a minute or two once the address leads to this server.", { address: got.address, ca: status?.ca ?? 'the CA' })
                        : t('{address} added, and the server is asking {ca} for its certificate. This takes a minute or two once the address leads to this server.', { address: got.address, ca: status?.ca ?? 'the CA' }),
                });
                if ('ip' in input) setIp(''); else setDomain('');
            }
            await load();
        } catch (e) {
            if (proof.checkError(e, (c) => give(input, again, c), code)) return;
            setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(null);
        }
    };

    const remove = async (id: TlsIdentifierStatus, code?: string) => {
        const address = id.identifier;
        // Asked once; a retry with a code is the same removal, already answered.
        if (code === undefined) {
            const yes = await ask({
                title: t('Remove {address}?', { address }),
                body: id.communityAddress
                    ? t("It is this community's address. Members' apps that use it are refused after this, and new members are sent to another of its addresses, if it has one.")
                    : t("Members' apps that use it are refused after this."),
                confirmLabel: t('Remove'),
                cancelLabel: t('Keep it'),
            });
            if (!yes) return;
        }
        setBusy(address);
        setMessage(null);
        try {
            await removeAppAddress(activeNode.url, address, credential, getTfaSessionToken(activeNode.id), code);
            proof.close();
            setMessage({ type: 'success', text: t('{address} removed.', { address }) });
            await load();
        } catch (e) {
            if (proof.checkError(e, (c) => remove(id, c), code)) return;
            setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(null);
        }
    };

    // No answer at all yet, or the node's answer that it offers none (loadError null): nothing drawn.
    if (!enabled || (!status && !loadError)) return null;

    const button = 'min-h-[44px] px-4 py-2 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-50 max-w-full break-words';
    const field = 'w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]';
    const messageClass = message?.type === 'error' ? 'text-bp-ink-danger' : message?.type === 'success' ? 'text-bp-ink-success' : 'text-bp-ink-info';

    const heading = (ca: string) => (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-nature-800 pb-3">
            <div className="min-w-0 grow basis-[12rem] space-y-1">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2 break-words">
                    <span aria-hidden="true">🔒</span>
                    <span>{t('Your own address')}</span>
                </h3>
                <p className="text-sm text-nature-300 m-0 leading-relaxed break-words">
                    {t("This server's public IP address, or a domain name you point at it. The server gets a certificate for each by itself, from {ca}, with no Cloudflare account: ports 80 and 443 must be open to the internet.", { ca })}
                </p>
            </div>
            <button
                type="button"
                onClick={() => load()}
                disabled={loading}
                className={`${button} shrink-0 bg-nature-800 hover:bg-nature-700 border-nature-700 text-nature-200`}
            >
                {loading ? t('Refreshing…') : t('Refresh')}
            </button>
        </div>
    );
    const loadErrorBlock = loadError && (
        <div role="alert" className="space-y-1" data-testid="own-address-load-error">
            <p className="text-sm text-bp-ink-warning m-0 break-words">
                {status
                    ? t("Couldn't refresh this list, so it may be out of date. Press Refresh to try again.")
                    : t("Couldn't read this server's addresses and certificates. Press Refresh to try again.")}
            </p>
            <p className="text-xs text-nature-400 m-0 break-words [overflow-wrap:anywhere]">{loadError}</p>
        </div>
    );
    const cardClass = 'p-5 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4';

    // The first read failed (a 5xx, no connection): the heading, why, and Refresh, so the owner can try again here.
    if (!status) {
        return (
            <div className={cardClass} data-testid="own-address-card">
                {heading('the CA')}
                {loadErrorBlock}
            </div>
        );
    }

    const now = Date.now();
    const ca = status.ca;

    return (
        <div className={cardClass} data-testid="own-address-card">
            {heading(ca)}

            <p className="text-sm text-nature-300 m-0 leading-relaxed break-words" data-testid="own-address-nudge">
                {t('A name survives a change of server; a number does not. If this server or its IP address changes, every member who uses the number has to type the new one.')}
            </p>

            {status.testCa && (
                <p role="alert" className="text-sm text-bp-ink-warning m-0 leading-relaxed break-words" data-testid="own-address-test-ca">
                    {t("This server asks {ca}'s test service (ACME_DIRECTORY_URL): phones and browsers do not trust the certificates it gives.", { ca })}
                </p>
            )}
            {!status.orders && (
                <p className="text-sm text-bp-ink-warning m-0 leading-relaxed break-words" data-testid="own-address-standby">
                    {t('This is a standby: it asks for no certificates. Set the address on the main server; a standby gets its own after it takes over.')}
                </p>
            )}

            {status.identifiers.length === 0 ? (
                <p className="text-sm text-nature-400 m-0 break-words" data-testid="own-address-none">
                    {t("This server has no address of its own yet. Give its public IP address below, or your own domain name.")}
                </p>
            ) : (
                <ul className="m-0 p-0 list-none space-y-3">
                    {status.identifiers.map((id) => {
                        const cert = id.certificate;
                        const expiresMs = cert ? Date.parse(cert.expiresAt) : NaN;
                        const expiringSoon = Number.isFinite(expiresMs) && expiresMs - now < DAY_MS;
                        const canChange = id.ownerAdded && id.challenge === 'http-01' && status.orders;
                        const offerRetry = canChange && id.retryOnly === true && (!cert || !!id.lastError) && !id.identifier.startsWith('[');
                        return (
                            <li
                                key={id.identifier}
                                className="p-3 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5 min-w-0"
                                data-testid="own-address"
                                data-address={id.identifier}
                            >
                                <div className="flex flex-wrap items-center gap-2 min-w-0">
                                    <strong className="text-white font-mono text-sm break-all">{id.identifier}</strong>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-nature-800 text-nature-200">
                                        {id.kind === 'ip' ? t('IP address') : t('domain name')}
                                    </span>
                                </div>
                                <p className="text-sm text-nature-300 m-0 break-words">
                                    {id.communityAddress ? t("This community's address: new members are sent here.") : sourceText(id)}
                                </p>
                                {cert ? (
                                    <p
                                        className={`text-sm m-0 break-words ${expiringSoon ? 'text-bp-ink-warning' : 'text-bp-ink-success'}`}
                                        data-testid="own-address-certificate"
                                    >
                                        {id.nextRenewalAt
                                            ? t('Certificate valid until {until}. Renews about {renews}.', { until: formatMoment(cert.expiresAt), renews: formatMoment(id.nextRenewalAt) })
                                            : t('Certificate valid until {until}. Renewing it within the hour.', { until: formatMoment(cert.expiresAt) })}
                                    </p>
                                ) : !id.lastError ? (
                                    <p className="text-sm text-nature-300 m-0 break-words" data-testid="own-address-certificate">
                                        {t('No certificate yet: the server asks for one within the hour, or at once when the address is given.')}
                                    </p>
                                ) : null}
                                {id.lastError && (
                                    <div className="space-y-1" data-testid="own-address-error">
                                        <p className="text-sm text-bp-ink-danger m-0 break-words [overflow-wrap:anywhere]">
                                            {id.lastAttemptAt
                                                ? t('Last try {when}: {why}', { when: formatMoment(id.lastAttemptAt), why: id.lastError })
                                                : t('Last try: {why}', { why: id.lastError })}
                                        </p>
                                        <p className="text-xs text-nature-400 m-0 break-words">
                                            {id.nextRenewalAt ? t('Next try {when}.', { when: formatMoment(id.nextRenewalAt) }) : t('Next try within the hour.')}
                                        </p>
                                    </div>
                                )}
                                {canChange && (
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {offerRetry && (
                                            <button
                                                type="button"
                                                disabled={busy !== null}
                                                onClick={() => give(id.kind === 'ip' ? { ip: id.identifier } : { domain: id.identifier }, true)}
                                                className={`${button} bg-nature-800 hover:bg-nature-700 border-nature-700 text-nature-200`}
                                            >
                                                {busy === id.identifier ? t('Trying…') : t('Try again now')}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            disabled={busy !== null}
                                            onClick={() => remove(id)}
                                            aria-label={t('Remove {address}', { address: id.identifier })}
                                            className={`${button} bg-bp-chip-danger-tint hover:opacity-90 border-bp-chip-danger-ink text-bp-chip-danger-ink`}
                                        >
                                            {t('Remove')}
                                        </button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            <FreshProofBox proof={proof} testId="own-address-proof" />
            {message && (
                <p role="status" className={`text-sm m-0 break-words [overflow-wrap:anywhere] ${messageClass}`} data-testid="own-address-message">
                    {message.text}
                </p>
            )}
            {loadErrorBlock}

            {status.orders && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-nature-800">
                    <form
                        className="space-y-2 min-w-0"
                        onSubmit={(e) => { e.preventDefault(); if (ip.trim()) void give({ ip: ip.trim() }, false); }}
                    >
                        <label htmlFor="own-ip-input" className="block text-xs font-bold text-nature-300 uppercase tracking-wider">
                            {t("This server's public IP address")}
                        </label>
                        <input
                            id="own-ip-input"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            spellCheck={false}
                            value={ip}
                            onChange={(e) => setIp(e.target.value)}
                            placeholder={t('e.g. 203.0.113.5')}
                            className={field}
                        />
                        <p className="text-xs text-nature-400 m-0 break-words">
                            {t('The one your hosting company gave this server. Ports 80 and 443 must reach it.')}
                        </p>
                        <button
                            type="submit"
                            disabled={busy !== null || !ip.trim()}
                            className={`${button} w-full sm:w-auto bg-bp-cta-fill hover:bg-bp-cta-hover border-bp-cta-fill text-bp-cta-on`}
                        >
                            {t('Use this IP address')}
                        </button>
                    </form>
                    <form
                        className="space-y-2 min-w-0"
                        onSubmit={(e) => { e.preventDefault(); const d = domainOf(domain); if (d) void give({ domain: d }, false); }}
                    >
                        <label htmlFor="own-domain-input" className="block text-xs font-bold text-nature-300 uppercase tracking-wider">
                            {t('Your own domain name')}
                        </label>
                        <input
                            id="own-domain-input"
                            type="text"
                            inputMode="url"
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            value={domain}
                            onChange={(e) => setDomain(e.target.value)}
                            placeholder={t('e.g. beans.example.org')}
                            className={field}
                        />
                        <p className="text-xs text-nature-400 m-0 break-words">
                            {t("Point an A record for it at this server's public IP address first.")}
                        </p>
                        <button
                            type="submit"
                            disabled={busy !== null || !domainOf(domain)}
                            className={`${button} w-full sm:w-auto bg-bp-cta-fill hover:bg-bp-cta-hover border-bp-cta-fill text-bp-cta-on`}
                        >
                            {t('Use this domain')}
                        </button>
                    </form>
                </div>
            )}
            {confirmation}
        </div>
    );
}
