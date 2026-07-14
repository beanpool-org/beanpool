/**
 * InvitePage — Generate invites + Community Tree + Health Dashboard
 *
 * Three sections:
 *  1. Invite code generation & management
 *  2. Interactive invite tree visualisation
 *  3. Community health metrics & flags
 */

import { useState, useEffect } from 'react';
import { generateInvite, getMyInvites, getInviteTree, type InviteCode } from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { QRCodeSVG } from 'qrcode.react';

const QRCodeSVGComponent = QRCodeSVG as any;

interface Props {
    identity: BeanPoolIdentity;
}

interface TreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    inviteCode: string;
    children: TreeNode[];
}

export function InvitePage({ identity }: Props) {
    const [invites, setInvites] = useState<InviteCode[]>([]);
    const [generating, setGenerating] = useState(false);
    const [newCode, setNewCode] = useState<string | null>(null);
    const [intendedFor, setIntendedFor] = useState('');
    const [copied, setCopied] = useState(false);
    const [showQR, setShowQR] = useState(false);

    // Tree
    const [tree, setTree] = useState<TreeNode[]>([]);
    const [activeSection, setActiveSection] = useState<'invites' | 'tree'>('invites');

    useEffect(() => {
        loadInvites();
        loadTree();
    }, []);

    async function loadInvites() {
        let serverInvites: InviteCode[] = [];
        try {
            const result = await getMyInvites(identity.publicKey);
            serverInvites = result.invites;
        } catch { /* offline */ }

        // Merge with local offline tickets that haven't been redeemed
        try {
            const storedOffline = localStorage.getItem(`bp_offline_invites_${identity.publicKey}`);
            if (storedOffline) {
                const localInvites: InviteCode[] = JSON.parse(storedOffline);
                
                // Only keep local offline invites that haven't miraculously appeared in the server sync
                // i.e., once a local invite's Hash matches a redeemed code in the DB (hard to sync perfectly offline though)
                // For simplicity, we just inject all offline tickets. When redeemed, they remain 'unused' to the inviter until they clear cache.
                const merged = [...localInvites, ...serverInvites];
                setInvites(merged);
                return;
            }
        } catch (e) {
            console.error("Failed to parse local offline tickets", e);
        }

        setInvites(serverInvites);
    }

    async function saveOfflineInviteLocally(invite: InviteCode) {
        try {
            const storedOffline = localStorage.getItem(`bp_offline_invites_${identity.publicKey}`);
            const localInvites: InviteCode[] = storedOffline ? JSON.parse(storedOffline) : [];
            localInvites.unshift(invite);
            localStorage.setItem(`bp_offline_invites_${identity.publicKey}`, JSON.stringify(localInvites));
        } catch (e) {
            console.error("Local storage error:", e);
        }
    }

    async function loadTree() {
        try {
            const result = await getInviteTree();
            setTree(result);
        } catch { /* offline */ }
    }


    async function handleGenerate() {
        setGenerating(true);
        setCopied(false);
        try {
            // Online first (parity with native): a server-minted INV- code is
            // short, single-use enforced centrally, and lands in the node's
            // invite tree. Only fall back to a self-signed offline ticket when
            // the node can't be reached.
            try {
                const res = await generateInvite(identity.publicKey, intendedFor.trim() || undefined);
                if (res?.invite?.code) {
                    setNewCode(res.invite.code);
                    setIntendedFor('');
                    setShowQR(true);
                    setInvites(prev => [res.invite, ...prev]);
                    return;
                }
            } catch { /* node unreachable — offline fallback below */ }

            const payloadObj = {
                i: identity.publicKey,
                t: Date.now(),
                f: intendedFor.trim() || undefined
            };
            const payloadStr = JSON.stringify(payloadObj);
            
            // Generate Ed25519 signature
            // Temporarily importing here to avoid root refactor until verified
            const { signWithPrivateKey } = await import('../lib/mnemonic');
            const signature = await signWithPrivateKey(identity.privateKey, payloadStr);
            
            // Encode safely for URL insertion
            const ticketObj = { p: payloadStr, s: signature };
            // UTF-8 safe base64 encoding
            const bytes = new TextEncoder().encode(JSON.stringify(ticketObj));
            let binary = '';
            for (const b of bytes) binary += String.fromCharCode(b);
            const ticketB64Standard = btoa(binary);
            const ticketB64UrlSafe = ticketB64Standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            
            // Prefix to easily identify offline tickets in UI vs old DB 6-char hashes
            const code = `BP-${ticketB64UrlSafe}`;
            
            setNewCode(code);
            setIntendedFor('');
            setShowQR(true);
            
            // Construct the struct for local presentation
            const inviteObj: InviteCode = {
                code,
                createdBy: identity.publicKey,
                createdAt: new Date().toISOString(),
                usedBy: null,
                usedAt: null,
                intendedFor: payloadObj.f
            };

            // Write to local IndexedDB/localStorage persist to survive reload
            await saveOfflineInviteLocally(inviteObj);

            // Optimistically stick it in the UI since the server doesn't know about it yet!
            setInvites(prev => [inviteObj, ...prev]);
            
        } catch (err: any) {
            alert(err.message || 'Failed to generate offline ticket');
        } finally {
            setGenerating(false);
        }
    }

    async function handleCopy(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            const el = document.createElement('textarea');
            el.value = code;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }

    async function handleCopyProxy(code: string) {
        // The /api/links/shorten proxy was never implemented server-side; the
        // full ?invite= URL is the real (and only) format links have ever used.
        await handleCopy(`${window.location.origin}/?invite=${code}`);
    }

    async function handleShare(code: string) {
        const invite = invites.find(i => i.code === code);
        const namePhrase = invite?.intendedFor ? `Hey ${invite.intendedFor}, ` : '';
        
        const inviteUrl = `${window.location.origin}/?invite=${code}`;
        const messageText = `Join my BeanPool community node: ${inviteUrl}`;
        
        const shareData = {
            title: 'Join BeanPool Node',
            text: messageText,
        };
        
        if (navigator.share) {
            try { await navigator.share(shareData); } catch { /* cancelled */ }
        } else {
            handleCopy(messageText);
        }
    }

    const unusedInvites = invites.filter(i => !i.usedBy);
    const usedInvites = invites.filter(i => i.usedBy);

    return (
        <div className="p-4 max-w-[500px] mx-auto min-h-full">
            {/* Section tabs */}
            <div className="flex gap-2 mb-6">
                <button 
                    onClick={() => setActiveSection('invites')} 
                    className={`flex-1 py-3 rounded-xl border-none text-[14px] font-bold cursor-pointer transition-all shadow-sm ${
                        activeSection === 'invites' 
                            ? 'bg-emerald-600 text-white shadow-md' 
                            : 'bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 hover:bg-oat-200 dark:hover:bg-nature-700'
                    }`}
                >
                    🎟️ Invites
                </button>
                <button 
                    onClick={() => setActiveSection('tree')} 
                    className={`flex-1 py-3 rounded-xl border-none text-[14px] font-bold cursor-pointer transition-all shadow-sm ${
                        activeSection === 'tree' 
                            ? 'bg-emerald-600 text-white shadow-md' 
                            : 'bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 hover:bg-oat-200 dark:hover:bg-nature-700'
                    }`}
                >
                    🌳 Tree
                </button>
            </div>

            {/* =================== INVITES SECTION =================== */}
            {activeSection === 'invites' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                        🎟️ Invite Someone
                    </h2>
                    <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-6 leading-relaxed">
                        Each invite code is single-use and valid for 7 days. Generate a new cryptographic voucher for each person you invite.
                    </p>

                    <input
                        type="text"
                        placeholder="Who is this invite for? (Optional)"
                        value={intendedFor}
                        onChange={e => setIntendedFor(e.target.value)}
                        className="w-full p-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-950 dark:text-white text-[15px] font-medium mb-4 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none shadow-sm transition-all"
                    />

                    <button
                        onClick={handleGenerate}
                        disabled={generating}
                        className={`w-full p-4 rounded-xl text-[15px] font-bold border-none cursor-pointer mb-6 transition-all shadow-md ${
                            generating 
                                ? 'bg-nature-400 text-white cursor-not-allowed' 
                                : 'bg-emerald-600 text-white hover:bg-emerald-700 hover:shadow-lg'
                        }`}
                    >
                        {generating ? 'Generating...' : '✨ Generate New Invite'}
                    </button>

                    {newCode && showQR && (
                        <div className="bg-oat-50 dark:bg-nature-950 border-2 border-emerald-500 rounded-2xl p-6 text-center mb-6 shadow-md transition-all">
                            <p className="text-nature-600 dark:text-nature-400 text-[14px] font-medium mb-3">Share this code with someone you trust</p>
                            <p className="font-mono text-xl font-bold text-nature-950 dark:text-white tracking-widest break-all mb-4" title={newCode}>
                                {newCode.length > 20 ? `${newCode.substring(0, 16)}...` : newCode.toUpperCase()}
                            </p>
                            <div className="bg-white rounded-xl p-4 inline-block mb-5 shadow-sm">
                                <QRCodeSVGComponent value={`${window.location.origin}/?invite=${newCode}`} size={200} />
                            </div>
                            <div className="flex gap-3 justify-center">
                                <button 
                                    onClick={() => handleCopyProxy(newCode)} 
                                    className={`py-3 px-6 rounded-xl border text-[14px] font-bold cursor-pointer transition-all ${
                                        copied 
                                            ? 'bg-emerald-100 border-emerald-500 text-emerald-700 dark:bg-emerald-900/50 dark:border-emerald-500 dark:text-emerald-400' 
                                            : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-900 dark:text-white hover:bg-nature-50 dark:hover:bg-nature-700'
                                    }`}
                                    aria-label="Copy invite link"
                                    title="Copy invite link"
                                >
                                    {copied ? '✓ Copied!' : '📋 Copy'}
                                </button>
                                <button 
                                    onClick={() => handleShare(newCode)} 
                                    className="py-3 px-6 rounded-xl border-none bg-emerald-600 text-white text-[14px] font-bold cursor-pointer hover:bg-emerald-700 shadow-sm transition-all"
                                    aria-label="Share invite link"
                                    title="Share invite link"
                                >
                                    📤 Share
                                </button>
                            </div>
                        </div>
                    )}

                    {unusedInvites.length > 0 && (
                        <div className="mb-6">
                            <h3 className="text-[13px] font-bold text-nature-500 dark:text-nature-400 mb-3 uppercase tracking-wider">⏳ Pending ({unusedInvites.length})</h3>
                            {unusedInvites.map(inv => (
                                <div key={inv.code} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 mb-3 shadow-sm transition-transform hover:-translate-y-0.5">
                                    <div className="flex justify-between items-center">
                                        <div className="flex flex-col gap-1">
                                            {inv.intendedFor && (
                                                <span className="text-[13px] font-bold text-nature-600 dark:text-nature-400">
                                                    For: {inv.intendedFor}
                                                </span>
                                            )}
                                            <span className="font-mono text-[14px] font-bold tracking-wider text-nature-950 dark:text-white break-all" title={inv.code}>
                                                {inv.code.length > 20 ? `${inv.code.substring(0, 16)}...` : inv.code.toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="flex gap-2">
                                            <button 
                                                onClick={() => handleCopyProxy(inv.code)} 
                                                className="p-2 rounded-lg bg-oat-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-400 hover:bg-oat-100 dark:hover:bg-nature-700 cursor-pointer transition-colors shadow-sm"
                                                aria-label="Copy invite link"
                                                title="Copy invite link"
                                            >
                                                📋
                                            </button>
                                            <button 
                                                onClick={() => handleShare(inv.code)} 
                                                className="p-2 rounded-lg bg-emerald-600 border-none text-white hover:bg-emerald-700 cursor-pointer shadow-sm transition-colors"
                                                aria-label="Share invite link"
                                                title="Share invite link"
                                            >
                                                📤
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-nature-400 dark:text-nature-500 text-[11px] font-semibold mt-2 uppercase tracking-wide">
                                        Created {new Date(inv.createdAt).toLocaleDateString()}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}

                    {usedInvites.length > 0 && (
                        <div>
                            <h3 className="text-[13px] font-bold text-nature-500 dark:text-nature-400 mb-3 uppercase tracking-wider mt-6">✅ Redeemed ({usedInvites.length})</h3>
                            {usedInvites.map(inv => (
                                <div key={inv.code} className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 mb-3 opacity-70">
                                    <div className="flex flex-col gap-1">
                                        {inv.intendedFor && (
                                            <span className="text-[13px] text-nature-500 dark:text-nature-400 font-medium">
                                                For: {inv.intendedFor}
                                            </span>
                                        )}
                                        <span className="font-mono text-[13px] text-nature-500 dark:text-nature-500 line-through break-all" title={inv.code}>
                                            {inv.code.length > 20 ? `${inv.code.substring(0, 16)}...` : inv.code.toUpperCase()}
                                        </span>
                                    </div>
                                    <p className="text-nature-400 dark:text-nature-600 text-[11px] font-semibold mt-2 uppercase tracking-wide">
                                        Used {inv.usedAt ? new Date(inv.usedAt).toLocaleDateString() : ''}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* =================== TREE SECTION =================== */}
            {activeSection === 'tree' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                        🌳 Community Tree
                    </h2>
                    <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-6 leading-relaxed">
                        Who invited whom. The tree shows how your community grows.
                    </p>

                    {tree.length === 0 ? (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-8 text-center text-nature-500 dark:text-nature-400 shadow-sm">
                            <p className="text-4xl mb-3">🌱</p>
                            <p className="font-medium">No members yet. Generate an invite to start growing!</p>
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 shadow-sm">
                            {tree.map(node => (
                                <TreeNodeView key={node.publicKey} node={node} depth={0} identity={identity} />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// =================== SUB-COMPONENTS ===================
function TreeNodeView({ node, depth, identity }: { node: TreeNode; depth: number; identity: BeanPoolIdentity }) {
    const [expanded, setExpanded] = useState(depth < 2);
    const isMe = node.publicKey === identity.publicKey;
    const hasChildren = node.children.length > 0;
    const joinDate = new Date(node.joinedAt).toLocaleDateString();

    return (
        <div className={`${depth > 0 ? 'ml-5' : 'ml-0'}`}>
            <div
                onClick={() => hasChildren && setExpanded(!expanded)}
                className={`flex items-center gap-3 py-2 px-1 rounded-lg transition-colors ${
                    hasChildren ? 'cursor-pointer hover:bg-oat-50 dark:hover:bg-nature-800/50' : 'cursor-default'
                } ${depth > 0 ? 'border-l-2 border-nature-200 dark:border-nature-700 pl-4' : ''}`}
            >
                {/* Expand/collapse */}
                <span className="text-[12px] text-nature-400 dark:text-nature-500 w-4 text-center">
                    {hasChildren ? (expanded ? '▼' : '▶') : '·'}
                </span>

                {/* Avatar dot */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 shadow-sm ${
                    isMe 
                        ? 'bg-emerald-600 text-white border-2 border-emerald-300 dark:border-emerald-800' 
                        : 'bg-oat-200 dark:bg-nature-800 text-nature-700 dark:text-nature-300'
                }`}>
                    {node.callsign.charAt(0).toUpperCase()}
                </div>

                {/* Name + info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`text-[14px] font-bold truncate ${
                            isMe ? 'text-emerald-600 dark:text-emerald-500' : 'text-nature-900 dark:text-white'
                        }`}>
                            {node.callsign}
                        </span>
                        {isMe && (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-50 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-md border border-emerald-100 dark:border-emerald-800">
                                you
                            </span>
                        )}
                    </div>
                    <span className="text-[11px] font-medium text-nature-500 dark:text-nature-400 block mt-0.5">
                        Joined {joinDate}
                        {hasChildren && ` · ${node.children.length} invite${node.children.length !== 1 ? 's' : ''}`}
                    </span>
                </div>
            </div>

            {/* Children */}
            {expanded && hasChildren && (
                <div className="mt-1">
                    {node.children.map(child => (
                        <TreeNodeView key={child.publicKey} node={child} depth={depth + 1} identity={identity} />
                    ))}
                </div>
            )}
        </div>
    );
}
