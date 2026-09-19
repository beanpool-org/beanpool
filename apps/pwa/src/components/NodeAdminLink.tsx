/**
 * Settings → "🛡️ Manage <community>" in the web app: shown ONLY when the node says the signed-in member is an
 * owner or admin (GET /api/node-admin/me, signed with the member key — nothing cached, nothing editable).
 *
 * A plain link to the node's /settings. No session carries over: the web app's member identity is a key in
 * this browser, and /settings accepts only its own admin session (the node password, plus the node's 2FA if
 * on) or the app's one-time key link. The web app deliberately does NOT mint that key link itself — the phone
 * gates it behind its own unlock, and a browser has no equivalent, so doing it here would turn anyone with
 * this browser profile into an admin. Instead /settings offers "Sign in with your phone": a QR the BeanPool app
 * scans and approves after the phone's unlock (apps/server/src/settings-signin-pairing.ts). The row says so.
 *
 * `#from=pwa` (a fragment, so no server sees it) tells Settings to offer "← Back to BeanPool" to this web app.
 */
import { useEffect, useState } from 'react';
import { request, getNodeApiUrl } from '../lib/api';

type Role = 'owner' | 'admin';

export function NodeAdminLink() {
    const [role, setRole] = useState<Role | null>(null);
    const [communityName, setCommunityName] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        request<{ role?: unknown; communityName?: unknown }>('GET', '/api/node-admin/me')
            .then(body => {
                if (cancelled) return;
                setRole(body.role === 'owner' || body.role === 'admin' ? body.role : null);
                setCommunityName(typeof body.communityName === 'string' && body.communityName.trim() ? body.communityName.trim() : null);
            })
            .catch(() => { if (!cancelled) setRole(null); });
        return () => { cancelled = true; };
    }, []);

    if (!role) return null;
    const name = communityName || 'this community';

    return (
        <div>
            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                COMMUNITY ADMIN
            </div>
            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden">
                <a
                    href={`${getNodeApiUrl()}/settings#from=pwa`}
                    className="min-h-[48px] p-4 text-nature-900 dark:text-white flex items-center justify-between gap-3 hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline"
                >
                    <span className="flex items-start gap-3 min-w-0">
                        <span aria-hidden="true">🛡️</span>
                        <span className="min-w-0">
                            <span className="block font-bold text-[15px] break-words">Manage {name}</span>
                            <span className="block text-xs text-nature-500 dark:text-nature-400 mt-0.5 leading-relaxed">
                                {role === 'owner' ? "You're an owner." : "You're an admin."} Open Settings on this computer, then
                                scan its code with the BeanPool app (Settings → Sign in on a computer). Or use the admin password.
                            </span>
                        </span>
                    </span>
                    <span className="text-nature-400" aria-hidden="true">›</span>
                </a>
            </div>
        </div>
    );
}
