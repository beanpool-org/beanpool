/**
 * PeoplePage — Friends, Community, Invites, Guardians
 *
 * Multi-view People tab with search, avatars, and relative dates.
 */

import { useState, useEffect, useMemo } from 'react';
import {
    getFriends, addFriendApi, removeFriendApi, setGuardianApi,
    getMembers,
    type FriendEntry, type Member,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { InvitePage } from './InvitePage';

interface Props {
    identity: BeanPoolIdentity;
    initialView?: SubView;
    onNavigate?: (tab: string, conversationId?: string) => void;
    onOpenProfile?: (pubkey: string) => void;
}

type SubView = 'friends' | 'community' | 'invites' | 'guardians';

/** Convert a date to a relative "Xd ago" / "Xw ago" string */
function relativeDate(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 5) return `${diffWeeks}w ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y ago`;
}

/** Avatar circle with image or initials fallback */
function Avatar({ callsign, avatarUrl, isGuardian, size = 40 }: { callsign: string; avatarUrl?: string | null; isGuardian?: boolean; size?: number }) {
    const initial = callsign.charAt(0).toUpperCase();
    const sizeStyle = { width: size, height: size, minWidth: size };

    const resolved = resolveAvatarUrl(avatarUrl);

    if (resolved) {
        return (
            <img 
                src={resolved} 
                alt={callsign}
                className="rounded-full object-cover border border-nature-200 dark:border-nature-700"
                style={sizeStyle}
            />
        );
    }

    return (
        <div 
            className={`rounded-full flex items-center justify-center font-bold text-lg border ${
                isGuardian 
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-500 border-amber-200 dark:border-amber-800'
                    : 'bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 border-nature-200 dark:border-nature-700'
            }`}
            style={sizeStyle}
        >
            {initial}
        </div>
    );
}

export function PeoplePage({ identity, initialView = 'friends', onNavigate, onOpenProfile }: Props) {
    const [view, setView] = useState<SubView>(initialView);
    const [friends, setFriends] = useState<FriendEntry[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => { loadFriends(); }, []);
    useEffect(() => { if (view === 'community') loadMembers(); }, [view]);
    useEffect(() => { if (initialView) setView(initialView); }, [initialView]);

    async function loadFriends() {
        try {
            const data = await getFriends(identity.publicKey);
            setFriends(data);
        } catch { /* offline */ }
    }

    async function loadMembers() {
        setLoading(true);
        try {
            const data = await getMembers();
            setMembers(data);
        } catch { /* offline */ }
        setLoading(false);
    }

    async function handleAddFriend(pubkey: string) {
        try {
            await addFriendApi(identity.publicKey, pubkey);
            await loadFriends();
        } catch { /* error */ }
    }

    async function handleRemoveFriend(pubkey: string) {
        try {
            await removeFriendApi(identity.publicKey, pubkey);
            setFriends(f => f.filter(fr => fr.publicKey !== pubkey));
        } catch { /* error */ }
    }

    async function handleToggleGuardian(pubkey: string, isGuardian: boolean) {
        try {
            await setGuardianApi(identity.publicKey, pubkey, isGuardian);
            setFriends(f => f.map(fr =>
                fr.publicKey === pubkey ? { ...fr, isGuardian } : fr
            ));
        } catch { /* error */ }
    }

    async function handleMessage(friendPubkey: string) {
        if (onNavigate) {
            // Navigate to messages tab and open conversation with this friend
            onNavigate('messages', friendPubkey);
        }
    }

    const friendPubkeys = new Set(friends.map(f => f.publicKey));
    const guardians = friends.filter(f => f.isGuardian);

    // Build avatar lookup from members for friends view
    const memberAvatarMap = useMemo(() => {
        const map: Record<string, string | null> = {};
        for (const m of members) {
            if (m.avatarUrl) map[m.publicKey] = m.avatarUrl;
        }
        return map;
    }, [members]);

    // Filtered community members
    const filteredMembers = useMemo(() => {
        const base = members.filter(m => m.publicKey !== identity.publicKey);
        if (!searchQuery.trim()) return base;
        const q = searchQuery.trim().toLowerCase();
        return base.filter(m => m.callsign.toLowerCase().includes(q));
    }, [members, searchQuery, identity.publicKey]);

    return (
        <div className="p-4 max-w-[480px] mx-auto">
            {/* Sub-nav pills */}
            <div className="flex gap-1 mb-5 bg-oat-100 dark:bg-nature-900 rounded-xl p-1 shadow-inner border border-nature-200 dark:border-nature-800">
                {(['friends', 'community', 'invites', 'guardians'] as SubView[]).map(v => (
                    <button
                        key={v}
                        onClick={() => setView(v)}
                        className={`flex-1 py-2 px-1 border-none rounded-lg text-xs font-bold cursor-pointer transition-all ${
                            view === v 
                                ? 'bg-white dark:bg-nature-800 text-rainbow shadow-sm border border-nature-200/50 dark:border-nature-700/50 scale-95 drop-shadow-sm' 
                                : 'bg-transparent text-nature-500 dark:text-nature-400 hover:text-nature-700 dark:hover:text-oat-50 hover:bg-oat-200 dark:hover:bg-nature-800'
                        }`}
                    >
                        {v === 'friends' && '👫 Friends'}
                        {v === 'community' && '🏘️ Community'}
                        {v === 'invites' && '🎟️ Invites'}
                        {v === 'guardians' && '🛡️ Guardians'}
                    </button>
                ))}
            </div>

            {/* ===== FRIENDS ===== */}
            {view === 'friends' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {friends.length === 0 ? (
                        <div className="text-center p-10 text-nature-500 dark:text-nature-400 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm mt-4">
                            <p className="text-4xl mb-3">👫</p>
                            <p className="text-[15px] font-semibold text-nature-800 dark:text-white">No friends yet</p>
                            <p className="text-xs mt-2 text-nature-500 dark:text-nature-400 leading-relaxed">
                                Go to <strong className="text-nature-700 dark:text-oat-50">Community</strong> to browse members and add friends.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                            {friends.map(f => (
                                <div key={f.publicKey} className="p-3 px-4 flex items-center justify-between transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30">
                                    <div className="flex items-center gap-3">
                                        <button 
                                            className="bg-transparent border-none p-0 cursor-pointer text-left hover:opacity-80 transition-opacity" 
                                            onClick={() => onOpenProfile && onOpenProfile(f.publicKey)}
                                        >
                                            <Avatar 
                                                callsign={f.callsign} 
                                                avatarUrl={memberAvatarMap[f.publicKey]} 
                                                isGuardian={f.isGuardian} 
                                                size={36}
                                            />
                                        </button>
                                        <div>
                                            <button 
                                                className="font-bold text-[14px] text-nature-900 dark:text-white flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer hover:underline text-left"
                                                onClick={() => onOpenProfile && onOpenProfile(f.publicKey)}
                                            >
                                                {f.callsign}
                                                {f.isGuardian && <span className="text-[10px] text-amber-500 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/40 border border-amber-100 dark:border-amber-800 px-1.5 py-0.5 rounded-md no-underline">Guardian</span>}
                                            </button>
                                            <div className="text-[11px] text-nature-400 dark:text-nature-500 font-medium mt-0.5">
                                                Added {relativeDate(f.addedAt)}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {onNavigate && (
                                            <button
                                                onClick={() => handleMessage(f.publicKey)}
                                                className="bg-emerald-600 border-none text-white rounded-lg px-2.5 py-1 text-xs font-bold cursor-pointer hover:bg-emerald-700 shadow-sm transition-all"
                                                title="Message"
                                            >
                                                💬
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleRemoveFriend(f.publicKey)}
                                            className="bg-transparent border-none text-red-500 text-xs font-semibold cursor-pointer px-2.5 py-1 rounded-lg hover:bg-red-50 transition-colors"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ===== COMMUNITY ===== */}
            {view === 'community' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <p className="text-[13px] font-medium text-nature-500 dark:text-nature-400 mb-4 bg-oat-50 dark:bg-nature-900 p-3 rounded-xl border border-nature-200 dark:border-nature-800 shadow-sm">
                        All members on this node. Tap <strong className="text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-900/40 px-1.5 py-0.5 rounded shadow-sm border border-emerald-100 dark:border-emerald-800">+ Add</strong> to add someone as a friend.
                    </p>

                    {/* Search */}
                    <div className="mb-4">
                        <input
                            type="text"
                            placeholder="🔍 Search members..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="w-full p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-[14px] font-medium focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none shadow-sm transition-all placeholder:text-nature-400"
                        />
                        {searchQuery && (
                            <div className="text-xs text-nature-400 mt-1.5 font-medium">
                                {filteredMembers.length} member{filteredMembers.length !== 1 ? 's' : ''} found
                            </div>
                        )}
                    </div>

                    {loading ? (
                        <p className="text-center text-nature-500 p-8 font-medium animate-pulse">Loading community...</p>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                            {filteredMembers.map(m => (
                                    <div key={m.publicKey} className="p-3 px-4 flex items-center justify-between transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30">
                                        <div className="flex items-center gap-3">
                                            <button 
                                                className="bg-transparent border-none p-0 cursor-pointer text-left hover:opacity-80 transition-opacity"
                                                onClick={() => onOpenProfile && onOpenProfile(m.publicKey)}
                                            >
                                                <Avatar callsign={m.callsign} avatarUrl={m.avatarUrl} size={36} />
                                            </button>
                                            <div>
                                                <button 
                                                    className="font-bold text-[14px] text-nature-900 dark:text-white flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer hover:underline text-left"
                                                    onClick={() => onOpenProfile && onOpenProfile(m.publicKey)}
                                                >
                                                    {m.callsign}
                                                </button>
                                                <div className="text-[11px] text-nature-400 dark:text-nature-500 font-medium mt-0.5">
                                                    Joined {relativeDate(m.joinedAt)}
                                                </div>
                                            </div>
                                        </div>
                                        {friendPubkeys.has(m.publicKey) ? (
                                            <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/40 px-2.5 py-1 rounded-lg border border-emerald-100 dark:border-emerald-800 shadow-sm">
                                                ✓ Friend
                                            </span>
                                        ) : (
                                            <button
                                                onClick={() => handleAddFriend(m.publicKey)}
                                                className="bg-emerald-600 border-none text-white rounded-lg px-3.5 py-1.5 text-xs font-bold cursor-pointer hover:bg-emerald-700 shadow-sm transition-all hover:shadow-md"
                                            >
                                                + Add
                                            </button>
                                        )}
                                    </div>
                                ))}
                        </div>
                    )}
                </div>
            )}

            {/* ===== INVITES ===== */}
            {view === 'invites' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 bg-white dark:bg-nature-900 rounded-2xl shadow-soft border border-nature-200 dark:border-nature-800 overflow-hidden">
                    <InvitePage identity={identity} />
                </div>
            )}

            {/* ===== GUARDIANS ===== */}
            {view === 'guardians' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <p className="text-[13px] text-nature-600 dark:text-nature-300 mb-5 leading-relaxed bg-emerald-50/50 dark:bg-emerald-900/20 p-4 rounded-xl border border-emerald-100 dark:border-emerald-800 shadow-sm">
                        Choose up to <strong className="text-nature-900 dark:text-white">5 trusted friends</strong> as recovery guardians. 
                        If you ever lose your device, any 3 of them can help you get your identity back.
                    </p>

                    {friends.length === 0 ? (
                        <div className="text-center p-10 text-nature-500 bg-white rounded-2xl border border-nature-200 shadow-sm mt-4">
                            <p className="text-4xl mb-3">🛡️</p>
                            <p className="text-[14px] font-semibold text-nature-800 leading-relaxed max-w-[250px] mx-auto">
                                Add some friends first, then come back here to choose your guardians.
                            </p>
                        </div>
                    ) : (
                        <div>
                            <div className="flex justify-between items-center mb-4 px-1">
                                <h3 className="font-bold text-nature-950 dark:text-white text-[15px] m-0">Your Guardians</h3>
                                <div className={`text-xs font-bold px-3 py-1 rounded-full ${guardians.length >= 5 ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-amber-100 text-amber-700 border border-amber-200'}`}>
                                    {guardians.length}/5 selected
                                </div>
                            </div>
                            
                            <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                                {friends.map(f => (
                                    <div key={f.publicKey} className={`p-3 px-4 flex items-center justify-between transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30 ${
                                        f.isGuardian
                                            ? 'bg-amber-50/40 dark:bg-amber-950/10'
                                            : ''
                                    }`}>
                                        <div className="flex items-center gap-3">
                                            <Avatar 
                                                callsign={f.callsign} 
                                                avatarUrl={memberAvatarMap[f.publicKey]} 
                                                isGuardian={f.isGuardian} 
                                                size={36}
                                            />
                                            <div className={`font-bold text-[14px] ${f.isGuardian ? 'text-amber-900 dark:text-amber-400' : 'text-nature-900 dark:text-white'}`}>
                                                {f.callsign}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleToggleGuardian(f.publicKey, !f.isGuardian)}
                                            disabled={!f.isGuardian && guardians.length >= 5}
                                            className={`border-none rounded-lg px-3 py-1.5 text-xs font-bold cursor-pointer transition-all shadow-sm ${
                                                f.isGuardian 
                                                    ? 'bg-amber-600 text-white hover:bg-amber-700' 
                                                    : 'bg-nature-800 text-white hover:bg-nature-900'
                                            } ${(!f.isGuardian && guardians.length >= 5) ? 'opacity-40 cursor-not-allowed' : 'hover:shadow-md'}`}
                                        >
                                            {f.isGuardian ? 'Remove' : 'Make Guardian'}
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {guardians.length >= 3 && (
                                <div className="mt-5 p-4 rounded-xl bg-emerald-50 text-[13px] text-emerald-800 text-center leading-relaxed border border-emerald-200 shadow-sm font-medium">
                                    <div className="font-bold text-emerald-700 mb-1 flex items-center justify-center gap-1.5 animate-pulse">
                                        <span className="text-base">✅</span> Social Recovery Ready
                                    </div>
                                    If you lose your device, any 3 of them can help restore your identity.
                                    <div className="mt-2 text-[11px] font-bold text-emerald-600/70 border-t border-emerald-200/50 pt-2 uppercase tracking-wider">
                                        Full recovery flow coming soon.
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
