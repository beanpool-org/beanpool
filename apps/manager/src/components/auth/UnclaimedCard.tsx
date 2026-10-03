import React from 'react';
import { generateOfflineQrUrl } from '../../lib/qr';
import { buildClaimQr, CLAIM_COMMAND } from '../../lib/node-claim';

interface UnclaimedCardProps {
    codeId: string | null;
}

/**
 * What the sign-in page shows while the node has no owner (sign-in step 8, stage B4): run `beanpool claim` on the
 * server, then claim from the phone. The QR names this page's origin and the code's public id; the code itself is
 * read on the server, never here, because this page is public.
 */
export function UnclaimedCard({ codeId }: UnclaimedCardProps) {
    // The page's own origin, as PhoneSignIn's QR: it is the address the installer just reached this node at.
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const qr = generateOfflineQrUrl(buildClaimQr(origin, codeId));

    return (
        <section aria-labelledby="claim-card-title" className="space-y-4" data-testid="claim-card">
            <h3 id="claim-card-title" className="text-base font-bold text-white m-0">This community has no owner yet.</h3>
            <div>
                <p className="text-sm text-nature-300 m-0 leading-relaxed">On the server, run:</p>
                {/* Wraps at its spaces on a narrow screen rather than running out of the card. */}
                <code
                    className="block mt-1.5 px-3 py-2.5 rounded-xl bg-nature-950 border border-nature-700/80 text-nature-100 font-mono text-xs leading-relaxed whitespace-normal break-words select-all"
                    data-testid="claim-command"
                >
                    {CLAIM_COMMAND}
                </code>
            </div>
            <p className="text-sm text-nature-300 m-0 leading-relaxed">
                Then on your phone, open <strong className="text-nature-100">BeanPool → Claim a community</strong>, or scan this.
            </p>
            {qr && (
                <div className="flex justify-center">
                    {/* White quiet zone, and never wider than the card: a 320px screen still scans. */}
                    <img
                        src={qr}
                        alt="QR code to claim this community with the BeanPool app"
                        className="w-full max-w-[240px] aspect-square rounded-xl bg-white p-2"
                        data-testid="claim-qr"
                    />
                </div>
            )}
            <p className="text-xs text-nature-400 m-0 text-center leading-relaxed">
                {/* The address the QR names, in full: a long one wraps rather than being cut. */}
                This server: <span className="text-nature-200 font-mono break-all" data-testid="claim-origin">{origin}</span>
            </p>
        </section>
    );
}
