import React from 'react';
import { HelpLink } from '../manual/Manual';
import { resolveNodeApiUrl } from '../../lib/node-client';
import { type KeySession } from '../../lib/key-session';
import { PhoneSignIn } from './PhoneSignIn';
import { UnclaimedCard } from './UnclaimedCard';
import { useClaimState } from './useClaimState';
import { CLAIM_PATH, STANDBY_RECOVER_COMMAND } from '../../lib/node-claim';
import { t } from '../../lib/fresh-proof';

interface AdminLoginCardProps {
    nodeUrl: string;
    /** Offers "Sign in with your phone" (a QR for the BeanPool app) when given. Single-node /settings only. */
    onKeySession?: (session: KeySession, csrfToken: string) => void;
}

/**
 * The sign-in for the node's own Settings. A node has no admin password: an owner, admin or moderator signs in with the
 * BeanPool app on their phone (PhoneSignIn), and a node with no owner yet shows the claim card (UnclaimedCard) instead.
 */
export function AdminLoginCard({ nodeUrl, onKeySession }: AdminLoginCardProps) {
    // Asked before sign-in; the phone sign-in shows meanwhile and whenever the answer is not "unclaimed" (useClaimState).
    const claim = useClaimState(resolveNodeApiUrl(nodeUrl, CLAIM_PATH));
    // A standby with no owner of its own (the claim check answers standby: true): nobody signs in here until an owner of the
    // community makes themselves one on its shell, so the card says how, above the usual sign-in.
    const standby = claim.kind === 'claimed' && claim.standby === true;

    return (
        <div className="min-h-screen bg-nature-950 flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md bg-nature-900/90 border border-nature-800 rounded-3xl p-5 sm:p-8 shadow-2xl backdrop-blur-xl animate-fade-in">
                <div className="flex items-center gap-3 mb-6 border-b border-nature-800/80 pb-5">
                    <div className="w-12 h-12 shrink-0 rounded-2xl bg-bp-chip-need-tint border border-terra-500/30 flex items-center justify-center text-2xl text-bp-chip-need-ink font-bold">
                        ⚙️
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-xl font-black text-white m-0 tracking-tight">Node Settings</h2>
                        <p className="text-xs text-nature-400 m-0 mt-0.5 font-medium">
                            Operator administration &amp; community governance
                        </p>
                    </div>
                    <HelpLink screen="login" />
                </div>

                {standby && (
                    <div data-testid="standby-signin-note" className="mb-4 p-3 rounded-xl border border-amber-800 bg-bp-chip-warn-tint text-bp-chip-warn-ink text-xs leading-relaxed">
                        <p className="m-0 mb-2">{t("This server is a standby copy of its community. It has no owner of its own: its owners are the main server's, and a take-over brings them.")}</p>
                        <p className="m-0 mb-2">{t('To sign in here, an owner of the community makes themselves an owner of this standby too, on its shell, and then signs in with their phone:')}</p>
                        <code className="block font-mono break-all">{STANDBY_RECOVER_COMMAND}</code>
                    </div>
                )}

                {claim.kind === 'unclaimed' ? (
                    <UnclaimedCard codeId={claim.codeId} primaryAddress={claim.primaryAddress} address={claim.address} addresses={claim.addresses} />
                ) : (
                    <div data-testid="phone-signin">
                        {onKeySession
                            ? <PhoneSignIn onSignedIn={onKeySession} />
                            : <p className="text-xs text-amber-300 m-0">Open this server&apos;s own /settings page to sign in with your phone, or use an automation token.</p>}
                    </div>
                )}
            </div>
        </div>
    );
}
