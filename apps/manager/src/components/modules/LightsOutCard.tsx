import React, { useCallback, useEffect, useState } from 'react';
import { word } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { proofField, t } from '../../lib/fresh-proof';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * Lights-out: the owner's switch for the hall, in Settings (server routes/lights-out.ts; design
 * scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §4.1, §4.2, §3.5, §3.6). When the internet and the phone network
 * are down, members' phones reach this laptop by its number on the hall Wi-Fi. Turning it on asks an owner's fresh proof:
 * Manage on the phone within 90 seconds, or the admin password with a current authenticator code. An admin sees the switch
 * as it stands and is told only an owner can change it. The words name the day and the time, never "stale".
 */

export interface LightsOutState {
    on: boolean;
    since: string | null;
    address: string | null;
    recordAsOf: string | null;
    home: string | null;
    epoch: number;
    hallWrites: boolean;
    standDown: { offered: true; steps: string[] } | null;
    standby: boolean;
}

export const LIGHTS_OUT_WORDS = {
    title: word('Lights-out: the hall laptop'),
    what: word('When the internet and the phone network are down, members join the hall Wi-Fi and reach this laptop by its number.'),
    readable: word('On the hall Wi-Fi, what members post and their balances can be read by others on the Wi-Fi. Messages stay private.'),
    on: word('Lights-out is on.'),
    off: word('Lights-out is off.'),
    since: word('On since {when}.'),
    recordAsOf: word('The record is as of {when}. Trades made since then on the old server are not here.'),
    addressLabel: word("This laptop's address on the hall Wi-Fi"),
    addressHint: word('Like http://192.168.8.1:8080. It goes on the poster.'),
    turnOn: word('Turn lights-out on'),
    turnOff: word('Turn lights-out off'),
    working: word('Working…'),
    poster: word('Show the poster'),
    ownerOnly: word('Only an owner can turn lights-out on or off.'),
    standby: word('This server is a standby. Take over as the main server first, then turn lights-out on.'),
    standDownTitle: word('Stand down: go back to being the standby'),
    noLaptopWord: word("No phone and no password? On the laptop's own shell: docker compose exec beanpool-node beanpool lights-out on"),
};

export interface LightsOutCardProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
}

function when(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : iso;
}

export function LightsOutCard({ activeNode, viewer = { kind: 'password' } }: LightsOutCardProps) {
    const W = LIGHTS_OUT_WORDS;
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const [state, setState] = useState<LightsOutState | null>(null);
    const [address, setAddress] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const proof = useFreshProof();

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/lights-out'), { headers: headers() });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.lightsOut) {
                setState(data.lightsOut as LightsOutState);
                if (data.lightsOut.address) setAddress(data.lightsOut.address);
                setMessage('');
            } else if (res.status !== 404) {
                setMessage(data.error || `HTTP ${res.status}`);
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => { void load(); }, [load]);

    // A node without lights-out (404) shows nothing.
    if (!state) return message ? <p className="text-xs text-amber-300 m-0" role="alert" data-testid="lights-out-error">{message}</p> : null;

    const flip = async (on: boolean, code?: string) => {
        setBusy(true);
        setMessage('');
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/lights-out'), {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ on, ...(on && address.trim() ? { address: address.trim() } : {}), ...proofField(code) }),
            });
            if (await proof.check(res, (c) => flip(on, c), code)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.lightsOut) setState(data.lightsOut as LightsOutState);
            else setMessage(data.error || `HTTP ${res.status}`);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4 min-w-0" data-testid="lights-out-card">
            <div className="border-b border-nature-800 pb-3 min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span aria-hidden="true">🕯️</span>
                    <span>{t(W.title)}</span>
                </h3>
            </div>
            <p className="text-xs text-nature-300 m-0 leading-relaxed">{t(W.what)}</p>
            <p className="text-sm font-bold m-0 text-white" data-testid="lights-out-state">
                {state.on ? t(W.on) : t(W.off)}
                {state.on && state.since ? <span className="font-normal text-nature-300"> {t(W.since, { when: when(state.since) })}</span> : null}
            </p>
            {state.recordAsOf && (
                <p className="text-xs m-0 p-3 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink" data-testid="lights-out-record">
                    {t(W.recordAsOf, { when: when(state.recordAsOf) })}
                </p>
            )}
            {state.standby ? (
                <p className="text-xs text-amber-300 m-0">{t(W.standby)}</p>
            ) : !isOwner ? (
                <p className="text-xs text-nature-400 m-0">{t(W.ownerOnly)}</p>
            ) : (
                <div className="space-y-3">
                    {!state.on && (
                        <>
                            <label htmlFor="lights-out-address" className="block text-xs text-nature-400">{t(W.addressLabel)}</label>
                            <input
                                id="lights-out-address"
                                type="text"
                                inputMode="url"
                                autoCapitalize="none"
                                autoComplete="off"
                                spellCheck={false}
                                value={address}
                                onChange={(e) => setAddress(e.target.value)}
                                placeholder="http://192.168.8.1:8080"
                                className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono"
                            />
                            <p className="text-xs text-nature-500 m-0">{t(W.addressHint)}</p>
                        </>
                    )}
                    <button
                        type="button"
                        onClick={() => flip(!state.on)}
                        disabled={busy}
                        data-testid="lights-out-switch"
                        className="min-h-[48px] w-full py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-sm font-bold text-bp-cta-on disabled:opacity-50"
                    >
                        {busy ? t(W.working) : state.on ? t(W.turnOff) : t(W.turnOn)}
                    </button>
                    {state.on && (
                        <a href="/hall" target="_blank" rel="noopener" className="block text-center text-sm underline text-nature-200 min-h-[48px] leading-[48px]">{t(W.poster)}</a>
                    )}
                </div>
            )}
            {state.standDown && (
                <div className="space-y-2 p-3 rounded-xl border border-nature-700" data-testid="lights-out-stand-down">
                    <p className="text-sm font-bold text-white m-0">{t(W.standDownTitle)}</p>
                    <ol className="text-xs text-nature-300 m-0 ps-5 space-y-1 list-decimal">
                        {state.standDown.steps.map((s) => <li key={s}>{s}</li>)}
                    </ol>
                </div>
            )}
            <p className="text-xs text-nature-500 m-0">{t(W.readable)}</p>
            <p className="text-xs text-nature-500 m-0 font-mono break-words">{t(W.noLaptopWord)}</p>
            <FreshProofBox proof={proof} testId="lights-out-proof" />
            {message && <p className="text-xs text-amber-300 m-0" role="alert">{message}</p>}
        </div>
    );
}
