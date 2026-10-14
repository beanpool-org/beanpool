import React, { useEffect, useState } from 'react';
import { OWNER_PHONE_EVENT, OWNER_PHONE_MESSAGE } from '../../lib/token-guard';
import { normalizeNodeUrl } from '../../lib/node-client';

/**
 * Shown when a profile's automation token met an owner-only route (lib/token-guard.ts): the words, and the way to the
 * phone sign-in. That sign-in (a QR the BeanPool app scans) lives on the node's own Settings page, so this opens it there.
 */
export function OwnerPhoneBanner({ nodeUrl }: { nodeUrl: string | undefined }) {
    const [shown, setShown] = useState(false);

    useEffect(() => {
        const onNeeded = () => setShown(true);
        window.addEventListener(OWNER_PHONE_EVENT, onNeeded);
        return () => window.removeEventListener(OWNER_PHONE_EVENT, onNeeded);
    }, []);

    // A different node is a different question.
    useEffect(() => { setShown(false); }, [nodeUrl]);

    if (!shown) return null;
    return (
        <div role="alert" data-owner-phone-banner className="bg-terra-600 text-white text-sm px-4 py-3 flex flex-wrap items-center gap-3">
            <p className="m-0 flex-1 min-w-0 break-words">{OWNER_PHONE_MESSAGE}</p>
            {nodeUrl && (
                <a
                    href={`${normalizeNodeUrl(nodeUrl)}/settings/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[44px] inline-flex items-center px-3 rounded-xl bg-white text-terra-600 font-bold"
                >
                    Sign in with your phone
                </a>
            )}
            <button
                type="button"
                onClick={() => setShown(false)}
                className="min-h-[44px] px-3 rounded-xl font-medium hover:bg-terra-500"
            >
                Dismiss
            </button>
        </div>
    );
}
