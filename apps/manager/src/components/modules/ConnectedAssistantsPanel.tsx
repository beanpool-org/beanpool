import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { nodeCredential } from '../../lib/profiles';
import { useInPageConfirm } from '../common/InPageConfirm';

/**
 * "Connected assistants" (admin MCP design §8, §10; slice S3; the server is apps/server agent/grants-route.ts). An owner
 * connects their OWN AI assistant (Claude, ChatGPT, Cursor) to this server's `/mcp`: it reads health, backups, totals,
 * reports and join requests, redacted by the server, and never messages, balances, keys, photos or logs. An owner sees
 * every connected assistant and can disconnect any; an admin sees and disconnects their own. "What it sees" runs the very
 * tools the assistant would, so the answer shown is the answer it gets. An owner can turn AI assistants off.
 *
 * Only an owner's KEY session connects one (an assistant acts for a member; the password is nobody's). Admins connect
 * theirs with the phone's approval once that lands (S2, OAuth); until then the card tells them so and offers no Connect
 * button, and "What would my assistant see?" still shows what theirs will read. The token is shown
 * ONCE: it lives in this component's state and nowhere else (never web storage, a log or the list), appears in the page
 * in one place only, and is dropped the moment Done is pressed or the card goes away. "Copy command" builds the
 * command line with it at the moment of copying; the line on screen shows a placeholder.
 */

interface AgentGrantRow {
    id: string;
    name: string;
    member: string | null;
    mine: boolean;
    role: 'owner' | 'admin' | null;
    /** token: an owner's token (S1); oauth: connected from the assistant and approved on a phone (S2). */
    via: 'token' | 'oauth';
    /** OAuth only: the host its answers go to. Its name is its own, so it is never shown without this. */
    sendsTo?: string;
    createdAt: number;
    expiresAt: number | null;
    expired: boolean;
    lastUsedAt: number | null;
    callsToday: number;
}

interface GrantsAnswer {
    allowed: boolean;
    mcpUrl: string;
    role: 'owner' | 'admin';
    canConnect: boolean;
    /** Anyone with a role connects from their assistant, approving on their phone (S2). */
    canConnectOAuth?: boolean;
    seesAll: boolean;
    defaultDays: number;
    maxDays: number;
    perMember: number;
    grants: AgentGrantRow[];
}

interface PreviewTool {
    name: string;
    title: string;
    description: string;
    write: boolean;
    memberText: boolean;
}

interface PreviewAnswer {
    ok: boolean;
    error?: string;
    result?: unknown;
}

export interface ConnectedAssistantsPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
}

const DAY_CHOICES = [7, 30, 90];
const GRANTS = '/api/local/admin/agent/grants';
const PREVIEW = '/api/local/admin/agent/preview';
const SWITCH = '/api/local/admin/agent/switch';
const TOKEN_PLACEHOLDER = 'bp_…your token…';

function formatDay(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The one line a desktop assistant (Claude Code) takes; other hosts take the same address and header. */
function commandLine(mcpUrl: string, token: string): string {
    return `claude mcp add --transport http beanpool ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

export function ConnectedAssistantsPanel({ activeNode, viewer = { kind: 'password' } }: ConnectedAssistantsPanelProps) {
    // Removing or replacing data, keys or roles is confirmed in the page, never with window.confirm() (owner-delete S4b).
    const [ask, confirmation] = useInPageConfirm();
    const drawn = viewer.kind === 'password' || viewer.role === 'owner' || viewer.role === 'admin';
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';

    const [data, setData] = useState<GrantsAnswer | null>(null);
    const [listMessage, setListMessage] = useState('');
    const [name, setName] = useState('');
    const [days, setDays] = useState(30);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    // The one-time token: component state only.
    const [shownToken, setShownToken] = useState<string | null>(null);
    const [copied, setCopied] = useState<'token' | 'command' | 'address' | null>(null);
    const tokenRef = useRef<HTMLParagraphElement | null>(null);
    // "What it sees": for one assistant (its id), or for the caller's own ('mine'), before connecting.
    const [previewFor, setPreviewFor] = useState<string | null>(null);
    const [tools, setTools] = useState<PreviewTool[] | null>(null);
    const [answers, setAnswers] = useState<Record<string, PreviewAnswer>>({});
    const [withText, setWithText] = useState<Record<string, boolean>>({});
    const [previewMessage, setPreviewMessage] = useState('');

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const post = useCallback(async (apiPath: string, body: unknown) => {
        const res = await fetch(resolveNodeApiUrl(activeNode.url, apiPath), {
            method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(body ?? {}),
        });
        const json = await res.json().catch(() => ({}));
        return { res, json: json as Record<string, any> };
    }, [activeNode.url, headers]);

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, GRANTS), { headers: headers(), credentials: 'same-origin' });
            const json = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(json.grants)) {
                setData(json as GrantsAnswer);
                setListMessage('');
            } else if (res.status === 404) {
                setListMessage("This server's BeanPool is older than AI assistants: update it to connect one.");
            } else {
                setListMessage(`The assistants could not be listed: ${json.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setListMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => {
        if (!drawn) return;
        void load();
    }, [drawn, load]);

    // A different node: nothing of the last one's token stays.
    useEffect(() => {
        setShownToken(null);
        setCopied(null);
        setMessage('');
        setPreviewFor(null);
    }, [activeNode.id]);

    if (!drawn) return null;

    const handleSwitch = async (allowed: boolean) => {
        setMessage('');
        setBusy(true);
        try {
            const { res, json } = await post(SWITCH, { allowed });
            if (!res.ok) setMessage(`Not changed: ${json.error || `HTTP ${res.status}`}`);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
        await load();
    };

    const handleMake = async () => {
        setMessage('');
        const trimmed = name.trim();
        if (!trimmed) {
            setMessage('Give it a name, so you know later which assistant it is (e.g. Claude on my laptop).');
            return;
        }
        setBusy(true);
        try {
            const { res, json } = await post(GRANTS, { name: trimmed, days });
            if (res.ok && typeof json.token === 'string') {
                setShownToken(json.token);
                setCopied(null);
                setName('');
                await load();
            } else {
                // The node's own words, including its "press Manage again" for a stale phone session.
                setMessage(`Not connected: ${json.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const copyText = async (text: string, what: 'token' | 'command' | 'address') => {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                setCopied(what);
                return;
            }
        } catch {
            // fall through
        }
        if (what === 'token' && tokenRef.current && typeof window !== 'undefined' && window.getSelection) {
            const range = document.createRange();
            range.selectNodeContents(tokenRef.current);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            setMessage('Your browser would not copy it. It is selected: copy it by hand.');
            return;
        }
        setMessage('Your browser would not copy it: copy it by hand.');
    };

    const handleDone = () => {
        setShownToken(null);
        setCopied(null);
        setMessage('');
    };

    const handleRevoke = async (g: AgentGrantRow) => {
        const whose = g.mine || !g.member ? '' : ` (${g.member}'s)`;
        if (!(await ask({ title: `Disconnect "${g.name}"${whose}?`, body: 'It stops at once: its next call is refused.', confirmLabel: 'Disconnect' }))) return;
        setMessage('');
        try {
            const { res, json } = await post(`${GRANTS}/${encodeURIComponent(g.id)}/revoke`, {});
            if (!res.ok) setMessage(`Not disconnected: ${json.error || `HTTP ${res.status}`}`);
            if (previewFor === g.id) setPreviewFor(null);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
        await load();
    };

    const openPreview = async (forId: string) => {
        if (previewFor === forId) {
            setPreviewFor(null);
            return;
        }
        setPreviewFor(forId);
        setTools(null);
        setAnswers({});
        setWithText({});
        setPreviewMessage('');
        try {
            const { res, json } = await post(PREVIEW, forId === 'mine' ? {} : { grant: forId });
            if (res.ok && Array.isArray(json.tools)) setTools(json.tools as PreviewTool[]);
            else setPreviewMessage(json.error || `HTTP ${res.status}`);
        } catch (e: unknown) {
            setPreviewMessage(e instanceof Error ? e.message : String(e));
        }
    };

    const runPreview = async (tool: PreviewTool) => {
        if (!previewFor) return;
        const args = tool.memberText && withText[tool.name] ? { include_text: true } : {};
        try {
            const { res, json } = await post(PREVIEW, { ...(previewFor === 'mine' ? {} : { grant: previewFor }), tool: tool.name, args });
            setAnswers((a) => ({ ...a, [tool.name]: res.ok ? (json as PreviewAnswer) : { ok: false, error: json.error || `HTTP ${res.status}` } }));
        } catch (e: unknown) {
            setAnswers((a) => ({ ...a, [tool.name]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
        }
    };

    const previewPanel = (
        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3 min-w-0" data-testid="agent-preview">
            <p className="text-xs text-nature-300 m-0 break-words">
                What the assistant gets from each tool, asked now: the server&rsquo;s own answer, as redacted for it. Member-written text comes
                fenced, marked as a stranger&rsquo;s words. Nothing here is counted against it or changes anything.
            </p>
            {previewMessage && <p className="text-[11px] text-amber-300 m-0 break-words" role="alert">{previewMessage}</p>}
            {tools === null && !previewMessage && <p className="text-[11px] text-nature-400 m-0">Loading its tools…</p>}
            {tools && (
                <ul className="list-none p-0 m-0 space-y-3">
                    {tools.map((t) => (
                        <li key={t.name} className="space-y-1.5 min-w-0" data-testid="agent-preview-tool">
                            <p className="text-xs font-bold text-white m-0 break-words">
                                {t.title} <span className="font-mono font-normal text-nature-400">{t.name}</span>
                            </p>
                            <p className="text-[11px] text-nature-400 m-0 break-words whitespace-pre-line">{t.description}</p>
                            {t.write ? (
                                <p className="text-[11px] text-nature-400 m-0 break-words">It changes something, so it is not tried here.</p>
                            ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => void runPreview(t)}
                                        className="min-h-[48px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                    >
                                        Show its answer
                                    </button>
                                    {t.memberText && (
                                        <label className="flex items-center gap-2 min-h-[48px] text-[11px] text-nature-300">
                                            <input
                                                type="checkbox"
                                                checked={!!withText[t.name]}
                                                onChange={(e) => setWithText((w) => ({ ...w, [t.name]: e.target.checked }))}
                                                className="w-5 h-5"
                                            />
                                            with member text
                                        </label>
                                    )}
                                </div>
                            )}
                            {answers[t.name] && (
                                answers[t.name].ok ? (
                                    <pre
                                        className="text-[11px] text-nature-200 bg-nature-950 border border-nature-800 rounded-xl p-3 m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all"
                                        data-testid="agent-preview-answer"
                                    >
                                        {JSON.stringify(answers[t.name].result, null, 2)}
                                    </pre>
                                ) : (
                                    <p className="text-[11px] text-amber-300 m-0 break-words" data-testid="agent-preview-answer">
                                        {data && !data.allowed
                                            ? 'Turned off: an assistant is told nothing while AI assistants are off, and there is nothing to show until an owner turns them on.'
                                            : `It would be told: ${answers[t.name].error}`}
                                    </p>
                                )
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );

    const mcpUrl = data?.mcpUrl ?? '';

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4 min-w-0" data-testid="connected-assistants-card">
            {confirmation}
            <div className="min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span>🧠</span>
                    <span className="min-w-0 break-words">Connected assistants</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5 break-words">
                    Your own AI assistant (Claude, ChatGPT, Cursor) can read this server&rsquo;s health, backups, totals, reports and join
                    requests{isOwner ? ', and take a backup' : ''}. It never sees messages, balances, keys, photos, addresses or logs, never
                    learns who reported, and changes no setting, role or member. Everything it reads goes to the company that runs it.
                </p>
            </div>

            {listMessage && <p className="text-[11px] text-amber-300 m-0 break-words" role="alert">{listMessage}</p>}
            {data === null && !listMessage && (
                <p className="text-[11px] text-nature-400 m-0 flex items-center gap-2" data-testid="connected-assistants-loading">
                    <span className="animate-spin text-xs">🔄</span>
                    <span>Loading assistants…</span>
                </p>
            )}

            {data && (
                <>
                    {data.allowed && data.canConnectOAuth && (
                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-2 min-w-0" data-testid="agent-connect-oauth">
                            <span className="text-xs font-semibold text-nature-300">Connect an AI assistant</span>
                            <ol className="text-[11px] text-nature-300 m-0 pl-5 space-y-1 break-words">
                                <li>
                                    Copy this address: <span className="font-mono text-white break-all">{data.mcpUrl}</span>{' '}
                                    <button
                                        type="button"
                                        onClick={() => void copyText(data.mcpUrl, 'address')}
                                        className="min-h-[48px] px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                    >
                                        {copied === 'address' ? 'Address copied' : 'Copy address'}
                                    </button>
                                </li>
                                <li>In Claude or ChatGPT: Settings → Connectors → Add custom connector → paste it.</li>
                                <li>Approve on your phone when it asks: check it names the assistant&rsquo;s address, then type the two digits.</li>
                                <li>Ask it: &ldquo;what needs me?&rdquo;</li>
                            </ol>
                            <p className="text-[11px] text-nature-400 m-0 break-words">
                                No key is shown. It acts as you, with your role: if you stop being an owner or admin, it stops too. If a page
                                asks you to approve an assistant you did not just add, close it.
                            </p>
                        </div>
                    )}
                    {/* The owner switch (design pick 5: on, inert until someone connects; an owner can turn it off). */}
                    <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-2 min-w-0" data-testid="agent-switch">
                        <p className="text-xs text-white m-0 break-words">
                            {data.allowed
                                ? 'AI assistants may connect to this server.'
                                : 'AI assistants are turned off on this server: none can connect, and connected ones are refused.'}
                        </p>
                        {isOwner ? (
                            <button
                                type="button"
                                role="switch"
                                aria-checked={data.allowed}
                                disabled={busy}
                                onClick={() => void handleSwitch(!data.allowed)}
                                className="min-h-[48px] w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 disabled:opacity-50"
                            >
                                {data.allowed ? 'Turn AI assistants off' : 'Allow AI assistants'}
                            </button>
                        ) : (
                            <p className="text-[11px] text-nature-400 m-0 break-words">Only an owner turns this on or off.</p>
                        )}
                    </div>

                    {shownToken ? (
                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3 min-w-0" data-testid="agent-token-shown">
                            <span className="text-xs font-semibold text-nature-300">Connect your assistant</span>
                            <ol className="text-xs text-nature-200 m-0 pl-5 space-y-2 break-words">
                                <li>
                                    The address:
                                    <span className="block font-mono text-[11px] text-white break-all mt-1" data-testid="agent-mcp-url">{mcpUrl}</span>
                                </li>
                                <li>
                                    Its token, sent as <span className="font-mono">Authorization: Bearer …</span>:
                                    <p
                                        ref={tokenRef}
                                        className="font-mono text-xs text-white break-all select-all m-0 mt-1 p-3 rounded-xl bg-nature-950 border border-nature-700"
                                        data-testid="agent-token-value"
                                    >
                                        {shownToken}
                                    </p>
                                </li>
                                <li>
                                    In Claude Code, one line does both:
                                    <span className="block font-mono text-[11px] text-nature-300 break-all mt-1" data-testid="agent-command">
                                        {commandLine(mcpUrl, TOKEN_PLACEHOLDER)}
                                    </span>
                                    Claude Desktop, Cursor and others: add a custom connector with the address, and the token as that header.
                                </li>
                                <li>Ask it: &ldquo;what needs me?&rdquo;</li>
                            </ol>
                            <p className="text-[11px] text-amber-300 m-0 break-words">
                                Copy the token now: it is not shown again. Keep it like a password: whoever holds it reads what your assistant reads.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <button
                                    type="button"
                                    onClick={() => void copyText(shownToken, 'token')}
                                    className="min-h-[48px] w-full sm:w-auto sm:flex-1 px-3 py-2.5 break-words rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on"
                                >
                                    {copied === 'token' ? 'Token copied' : 'Copy token'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void copyText(commandLine(mcpUrl, shownToken), 'command')}
                                    className="min-h-[48px] w-full sm:w-auto sm:flex-1 px-3 py-2.5 break-words rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                >
                                    {copied === 'command' ? 'Command copied' : 'Copy command'}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDone}
                                    className="min-h-[48px] w-full sm:w-auto sm:flex-1 px-3 py-2.5 break-words rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    ) : !data.canConnect ? (
                        data.role === 'owner' ? (
                            <p className="text-xs text-nature-400 m-0 break-words" data-testid="agent-needs-key">
                                An assistant acts for a member, so it is connected with your own key, never the password: use Manage in the app, or
                                sign in on a computer by scanning a code.
                            </p>
                        ) : (
                            <p className="text-xs text-nature-400 m-0 break-words" data-testid="agent-admin-oauth">
                                Admins connect from the assistant itself (above), approving on their phone. Only an owner makes a token for a
                                desktop agent.
                            </p>
                        )
                    ) : data.allowed ? (
                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3 min-w-0">
                            <span className="text-xs font-semibold text-nature-300">Advanced: make a token for a desktop agent</span>
                            <p className="text-[11px] text-nature-400 m-0 break-words">
                                You get an address and a token, shown once. Your assistant acts as you, with your role: if you stop being an
                                owner or admin, it stops too. At most {data.perMember} for each member.
                            </p>
                            <div className="space-y-1">
                                <label htmlFor="agent-name" className="block text-xs text-nature-400">Assistant&rsquo;s name</label>
                                <input
                                    id="agent-name"
                                    type="text"
                                    maxLength={60}
                                    placeholder="e.g. Claude on my laptop"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                                />
                            </div>
                            <div className="space-y-1">
                                <label htmlFor="agent-days" className="block text-xs text-nature-400">For how long</label>
                                <select
                                    id="agent-days"
                                    value={days}
                                    onChange={(e) => setDays(Number(e.target.value))}
                                    className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                                >
                                    {DAY_CHOICES.filter((d) => d <= data.maxDays).map((d) => (
                                        <option key={d} value={d}>{d} days</option>
                                    ))}
                                </select>
                            </div>
                            <button
                                type="button"
                                onClick={() => void handleMake()}
                                disabled={busy}
                                className="min-h-[48px] w-full py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50"
                            >
                                Connect
                            </button>
                        </div>
                    ) : null}

                    {message && <p className="text-[11px] text-amber-300 m-0 break-words" role="alert">{message}</p>}

                    <div className="space-y-2 min-w-0">
                        <button
                            type="button"
                            onClick={() => void openPreview('mine')}
                            aria-expanded={previewFor === 'mine'}
                            className="min-h-[48px] w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                        >
                            {previewFor === 'mine' ? 'Hide what it sees' : 'What would my assistant see?'}
                        </button>
                        {previewFor === 'mine' && previewPanel}
                    </div>

                    <div className="space-y-2 min-w-0">
                        <span className="text-xs font-semibold text-nature-300">{data.seesAll ? 'Assistants on this server' : 'Your assistants'}</span>
                        {data.grants.length === 0 && <p className="text-[11px] text-nature-400 m-0">None connected.</p>}
                        {data.grants.length > 0 && (
                            <ul className="list-none p-0 m-0 space-y-2" data-testid="agent-grant-list">
                                {data.grants.map((g) => (
                                    <li key={g.id} className="p-3 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-2 min-w-0" data-testid="agent-grant-row">
                                        <div className="min-w-0">
                                            <p className="text-xs font-bold text-white m-0 break-words">{g.name}</p>
                                            {g.via === 'oauth' && (
                                                <p className="text-[11px] text-nature-300 m-0 break-words" data-testid="agent-grant-sends-to">
                                                    Sends what it reads to {g.sendsTo ?? 'an unknown address'}
                                                </p>
                                            )}
                                            <p className="text-[11px] text-nature-400 m-0 break-words">
                                                {g.mine ? 'Yours' : g.member ?? 'A member'}
                                                {g.role ? ` · ${g.role}` : ''} · {g.via === 'oauth' ? 'approved on the phone' : 'by token'} · connected {formatDay(g.createdAt)}
                                            </p>
                                            <p className="text-[11px] text-nature-400 m-0 break-words">
                                                Last used: {g.lastUsedAt ? formatDay(g.lastUsedAt) : 'never'} · {g.callsToday} call{g.callsToday === 1 ? '' : 's'} today
                                            </p>
                                            <p className="text-[11px] text-nature-400 m-0 break-words">
                                                {g.expired ? 'Expired' : g.via === 'oauth' ? 'Until disconnected, or 30 days unused' : `Until ${g.expiresAt ? formatDay(g.expiresAt) : 'disconnected'}`}
                                            </p>
                                            {g.role === null && (
                                                <p className="text-[11px] text-amber-300 m-0 break-words">
                                                    Its member is no longer an owner or admin, so it reads nothing now.
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex flex-col sm:flex-row gap-2">
                                            {g.role !== null && !g.expired && (
                                                <button
                                                    type="button"
                                                    onClick={() => void openPreview(g.id)}
                                                    aria-expanded={previewFor === g.id}
                                                    aria-label={previewFor === g.id ? `Hide what it sees: ${g.name}` : `What it sees: ${g.name}`}
                                                    className="min-h-[48px] w-full sm:w-auto sm:flex-1 px-3 py-2.5 break-words rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                                >
                                                    {previewFor === g.id ? 'Hide' : 'What it sees'}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => void handleRevoke(g)}
                                                aria-label={`Disconnect ${g.name}`}
                                                className="min-h-[48px] w-full sm:w-auto sm:flex-1 px-3 py-2.5 break-words rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                            >
                                                Disconnect
                                            </button>
                                        </div>
                                        {previewFor === g.id && previewPanel}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
