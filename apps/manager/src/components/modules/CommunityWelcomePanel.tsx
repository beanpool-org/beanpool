/**
 * Settings → Node Identity → "Welcome for new members" (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.5,
 * slice S6; the server side is apps/server config/community-welcome.ts, routes/settings.ts). A few lines in the owners' own
 * words that members read on Home when they join: plain text, at most 280 characters and four lines (core's rule,
 * community-welcome.ts), shown as written and never translated. Empty by default.
 *
 * The read is GET and the change POST /api/local/admin/community-welcome; the change is an owner's, so anyone else reads it
 * with the box closed. The phone draws it on Home in a later slice (S7). Operators' Settings is English for launch
 * (lib/fresh-proof); the sentences go through t() so a catalog can come later.
 */
import React, { useEffect, useState } from 'react';
import { cleanCommunityWelcome, welcomeLineBreaks, COMMUNITY_WELCOME_MAX_CHARS, COMMUNITY_WELCOME_MAX_LINE_BREAKS } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { buildAdminHeaders, resolveNodeApiUrl } from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import type { RolesViewer } from './NodeRolesPanel';

const ROUTE = '/api/local/admin/community-welcome';
const MAX_LINES = COMMUNITY_WELCOME_MAX_LINE_BREAKS + 1;

/** A node's answer to the read and to the change: the welcome, or null for none. */
export function readWelcome(body: unknown): { ok: true; welcome: string | null } | { ok: false } {
    if (!body || typeof body !== 'object' || !('welcome' in body)) return { ok: false };
    const w = (body as { welcome: unknown }).welcome;
    return w === null || typeof w === 'string' ? { ok: true, welcome: w || null } : { ok: false };
}

type Message = { text: string; type: 'success' | 'error' };

export function CommunityWelcomePanel({ activeNode, viewer = { kind: 'token' } }: { activeNode: NodeProfile; viewer?: RolesViewer }) {
    const isOwner = viewer.kind === 'token' || viewer.role === 'owner';
    const [load, setLoad] = useState<'loading' | 'loaded' | 'failed'>('loading');
    const [saved, setSaved] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<Message | null>(null);

    useEffect(() => {
        let mounted = true;
        setLoad('loading');
        (async () => {
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, ROUTE), { headers: buildAdminHeaders(nodeCredential(activeNode)), cache: 'no-store' });
                const read = res.ok ? readWelcome(await res.json().catch(() => null)) : ({ ok: false } as const);
                if (!mounted) return;
                if (read.ok) { setSaved(read.welcome); setText(read.welcome ?? ''); setLoad('loaded'); } else setLoad('failed');
            } catch {
                if (mounted) setLoad('failed');
            }
        })();
        return () => { mounted = false; };
    }, [activeNode]);

    const check = cleanCommunityWelcome(text);
    const changed = check.ok && check.text !== (saved ?? '');
    const lines = text.trim() ? welcomeLineBreaks(text.trim()) + 1 : 0;

    const save = async () => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, ROUTE), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode)),
                body: JSON.stringify({ welcome: text }),
            });
            const data = await res.json().catch(() => ({}));
            const read = res.ok ? readWelcome(data) : ({ ok: false } as const);
            if (read.ok) {
                setSaved(read.welcome);
                setText(read.welcome ?? '');
                setMessage({ text: read.welcome ? t('Saved. Members see it on Home.') : t('Removed. Members see no welcome from you.'), type: 'success' });
            } else {
                setMessage({ text: typeof data?.error === 'string' && data.error ? data.error : t('The welcome was not saved. Try again in a minute.'), type: 'error' });
            }
        } catch {
            setMessage({ text: t('The welcome was not saved. Try again in a minute.'), type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div data-testid="community-welcome" className="max-w-2xl mt-6">
            <div className="pt-6 border-t border-nature-800/80 space-y-3">
                <div>
                    <label htmlFor="community-welcome-text" className="text-sm font-bold text-white m-0 block">{t('Welcome for new members')}</label>
                    <p className="text-xs text-nature-400 mt-0.5 m-0 leading-relaxed">
                        {t('Members read it on Home when they join. Plain text, shown as you write it. Only members see it.')}
                    </p>
                </div>

                {load === 'loading' && <p role="status" className="text-xs text-nature-400 m-0">{t('Reading the welcome from the node…')}</p>}
                {load === 'failed' && (
                    <p data-testid="community-welcome-failed" role="status" className="text-xs text-bp-ink-warning m-0 leading-normal">
                        {t("Couldn't read the welcome from the node. Reload to try again.")}
                    </p>
                )}

                {load === 'loaded' && (
                    <>
                        <textarea
                            id="community-welcome-text"
                            data-testid="community-welcome-text"
                            value={text}
                            maxLength={COMMUNITY_WELCOME_MAX_CHARS}
                            rows={4}
                            disabled={!isOwner || saving}
                            onChange={(e) => { setText(e.target.value); setMessage(null); }}
                            placeholder={t('e.g. Welcome! Market day is Saturday at the hall.')}
                            className="w-full bg-nature-950 border border-nature-700 text-white rounded-xl px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:border-terra-500 disabled:opacity-50"
                        />
                        <p data-testid="community-welcome-count" className={`text-[11px] m-0 leading-normal ${lines > MAX_LINES ? 'text-bp-ink-warning' : 'text-nature-400'}`}>
                            {t('{n} of {max} characters, {lines} of {maxLines} lines', { n: text.length, max: COMMUNITY_WELCOME_MAX_CHARS, lines, maxLines: MAX_LINES })}
                        </p>
                        {!isOwner && (
                            <p data-testid="community-welcome-owner-only" className="text-xs text-nature-400 m-0 leading-normal">
                                {t('Only an owner can change the welcome.')}
                            </p>
                        )}
                        {isOwner && (
                            <button
                                type="button"
                                data-testid="community-welcome-save"
                                onClick={save}
                                disabled={saving || !changed}
                                className="px-4 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50 min-h-[48px] lg:min-h-0"
                            >
                                {saving ? t('Saving…') : t('Save the welcome')}
                            </button>
                        )}
                        {message && (
                            <p data-testid="community-welcome-message" role="status" className={`text-xs m-0 break-words ${message.type === 'success' ? 'text-bp-ink-success' : 'text-bp-ink-danger'}`}>
                                {message.text}
                            </p>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
