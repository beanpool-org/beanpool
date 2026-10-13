/**
 * PeoplePage — Friends, Community, Invites
 *
 * Multi-view People tab with search, avatars, and relative dates.
 */

import { useState, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import {
    getFriends, addFriendApi, removeFriendApi,
    getMembers,
    type FriendEntry, type Member, type MemberCard,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { InvitePage } from './InvitePage';
import { getBlockedUsers, onBlocklistUpdated } from '../lib/blocklist';
import {
    useMembersOnDemand, useMemberSearch, membersNear, MEMBERS_SEARCH_LIMIT, MEMBERS_SEARCH_MIN_CHARS,
} from '../lib/members-on-demand';
import { readMyArea } from '../lib/member-area';

interface Props {
    identity: BeanPoolIdentity;
    initialView?: SubView;
    onNavigate?: (tab: string, conversationId?: string) => void;
    onOpenProfile?: (pubkey: string) => void;
}

type SubView = 'friends' | 'community' | 'invites';

const SUB_VIEWS: SubView[] = ['friends', 'community', 'invites'];
const tabId = (v: SubView) => `people-tab-${v}`;
const panelId = (v: SubView) => `people-panel-${v}`;

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
function Avatar({ callsign, avatarUrl, size = 40 }: { callsign: string; avatarUrl?: string | null; size?: number }) {
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
            className="rounded-full flex items-center justify-center font-bold text-lg border bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 border-nature-200 dark:border-nature-700"
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

    const [blocklistVersion, setBlocklistVersion] = useState(0);

    const tabRefs = useRef<Partial<Record<SubView, HTMLButtonElement | null>>>({});

    // WAI-ARIA tabs pattern: one tab in the Tab order (the selected one); Left/Right move between tabs and
    // wrap, Home/End jump to the ends. Moving focus also selects, as the tabs only swap an in-page view.
    const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
        const i = SUB_VIEWS.indexOf(view);
        let next: SubView | null = null;
        if (e.key === 'ArrowRight') next = SUB_VIEWS[(i + 1) % SUB_VIEWS.length];
        else if (e.key === 'ArrowLeft') next = SUB_VIEWS[(i - 1 + SUB_VIEWS.length) % SUB_VIEWS.length];
        else if (e.key === 'Home') next = SUB_VIEWS[0];
        else if (e.key === 'End') next = SUB_VIEWS[SUB_VIEWS.length - 1];
        if (!next) return;
        e.preventDefault();
        setView(next);
        tabRefs.current[next]?.focus();
    };

    // On a community where people are asked for, not read whole (lib/members-on-demand, the worldwide one): the 50
    // nearest the member's area and a search the node answers. Elsewhere, and while the node hasn't said, as before.
    const onDemand = useMembersOnDemand();
    const [near, setNear] = useState<MemberCard[]>([]);
    // 'none': the member has set no area; 'failed': it couldn't be read, or the nearest couldn't be.
    const [nearState, setNearState] = useState<'loading' | 'done' | 'none' | 'failed'>('loading');
    const [nearTry, setNearTry] = useState(0);

    useEffect(() => { loadFriends(); }, []);
    useEffect(() => { if (view === 'community' && onDemand === false) loadMembers(); }, [view, onDemand]);
    useEffect(() => { if (initialView) setView(initialView); }, [initialView]);

    useEffect(() => {
        if (view !== 'community' || onDemand !== true) return;
        let cancelled = false;
        setNearState('loading');
        (async () => {
            const area = await readMyArea();
            if (cancelled) return;
            if (area === undefined) { setNearState('failed'); return; }
            if (area === null) { setNear([]); setNearState('none'); return; }
            try {
                const people = await membersNear(area);
                if (!cancelled) { setNear(people); setNearState('done'); }
            } catch {
                if (!cancelled) setNearState('failed');
            }
        })();
        return () => { cancelled = true; };
    }, [view, onDemand, nearTry]);

    // The search goes to the node once the typing pauses, from 2 characters.
    const { found, state: searchState } = useMemberSearch(searchQuery, onDemand === true);

    useEffect(() => {
        return onBlocklistUpdated(() => {
            setBlocklistVersion(v => v + 1);
        });
    }, []);

    const blockedSet = useMemo(() => new Set(getBlockedUsers()), [blocklistVersion]);

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

    async function handleMessage(friendPubkey: string) {
        if (onNavigate) {
            // Navigate to messages tab and open conversation with this friend
            onNavigate('messages', friendPubkey);
        }
    }

    // Filter friends who are not blocked
    const visibleFriends = useMemo(() => {
        return friends.filter(f => !blockedSet.has(f.publicKey));
    }, [friends, blockedSet]);

    // ⚡ Bolt: Memoize friendPubkeys Set to prevent rebuilding on every render cycle
    const friendPubkeys = useMemo(() => new Set(visibleFriends.map(f => f.publicKey)), [visibleFriends]);

    // Build avatar lookup from members for friends view
    const memberAvatarMap = useMemo(() => {
        const map: Record<string, string | null> = {};
        for (const m of members) {
            if (m.avatarUrl) map[m.publicKey] = m.avatarUrl;
        }
        return map;
    }, [members]);

    // The people the node gave, without this member and anyone they've blocked.
    const shown = (people: MemberCard[]) => people.filter(m => m.publicKey !== identity.publicKey && !blockedSet.has(m.publicKey));
    const visibleNear = useMemo(() => shown(near), [near, identity.publicKey, blockedSet]);
    const visibleFound = useMemo(() => (found ? shown(found) : null), [found, identity.publicKey, blockedSet]);

    /** One person on the by-area view: face and name open the profile; every control at least 44 px. */
    const personRow = (m: MemberCard, distance: boolean) => (
        <div key={m.publicKey} data-testid="people-row" className="p-2 px-3 flex items-center justify-between gap-2 min-w-0">
            <button
                type="button"
                aria-label={`View ${m.callsign}'s profile`}
                className="flex items-center gap-3 min-w-0 min-h-[44px] bg-transparent border-none p-0 cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg"
                onClick={() => onOpenProfile && onOpenProfile(m.publicKey)}
            >
                <Avatar callsign={m.callsign} avatarUrl={m.avatarUrl} size={36} />
                <span className="min-w-0">
                    <span className="block font-bold text-[14px] text-nature-900 dark:text-white break-words">{m.callsign}</span>
                    <span className="block text-[11px] text-nature-500 dark:text-nature-400 font-medium mt-0.5">
                        {distance && typeof m.distanceKm === 'number'
                            ? (m.distanceKm < 1 ? 'Under 1 km away' : `About ${m.distanceKm} km away`)
                            : `Joined ${relativeDate(m.joinedAt)}`}
                    </span>
                </span>
            </button>
            {friendPubkeys.has(m.publicKey) ? (
                <span className="shrink-0 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 px-2.5 py-1 rounded-lg border border-emerald-100 dark:border-emerald-800">
                    ✓ Friend
                </span>
            ) : (
                <button
                    type="button"
                    onClick={() => handleAddFriend(m.publicKey)}
                    aria-label={`Add ${m.callsign} as friend`}
                    className="shrink-0 min-h-[44px] min-w-[44px] bg-emerald-600 border-none text-white rounded-lg px-3 text-xs font-bold cursor-pointer hover:bg-emerald-700 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                    + Add
                </button>
            )}
        </div>
    );
    const listBox = 'bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden';
    const lineText = 'm-0 px-1 text-sm text-nature-600 dark:text-nature-300';
    const linkButton = 'min-h-[44px] px-2 font-bold underline text-nature-800 dark:text-nature-100 bg-transparent border-none cursor-pointer';

    // Filtered community members (excluding blocked users)
    const filteredMembers = useMemo(() => {
        const base = members.filter(m => m.publicKey !== identity.publicKey && !blockedSet.has(m.publicKey));
        if (!searchQuery.trim()) return base;
        const q = searchQuery.trim().toLowerCase();
        return base.filter(m => m.callsign.toLowerCase().includes(q));
    }, [members, searchQuery, identity.publicKey, blockedSet]);

    return (
        <div className="p-4 md:p-6 max-w-4xl mx-auto w-full">
            {/* Sub-nav pills */}
            <div className="flex gap-1 mb-5 bg-oat-100 dark:bg-nature-900 rounded-xl p-1 shadow-inner border border-nature-200 dark:border-nature-800" role="tablist" aria-label="People navigation">
                {SUB_VIEWS.map(v => (
                    <button
                        key={v}
                        ref={el => { tabRefs.current[v] = el; }}
                        type="button"
                        role="tab"
                        id={tabId(v)}
                        aria-selected={view === v}
                        aria-controls={panelId(v)}
                        tabIndex={view === v ? 0 : -1}
                        onClick={() => setView(v)}
                        onKeyDown={onTabKeyDown}
                        className={`flex-1 min-h-[48px] py-2 px-1 border-none rounded-lg text-xs font-bold cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                            view === v 
                                ? 'bg-white dark:bg-nature-800 text-rainbow shadow-sm border border-nature-200/50 dark:border-nature-700/50 scale-95 drop-shadow-sm' 
                                : 'bg-transparent text-nature-500 dark:text-nature-400 hover:text-nature-700 dark:hover:text-oat-50 hover:bg-oat-200 dark:hover:bg-nature-800'
                        }`}
                    >
                        {v === 'friends' && '👫 Friends'}
                        {v === 'community' && '🏘️ Community'}
                        {v === 'invites' && '🎟️ Invites'}
                    </button>
                ))}
            </div>

            {/* Each tab's panel always exists so aria-controls points at something; only the selected one is shown
                and has content, so Community and Invites still load only when opened. */}
            {/* ===== FRIENDS ===== */}
            <div role="tabpanel" id={panelId('friends')} aria-labelledby={tabId('friends')} hidden={view !== 'friends'} tabIndex={0} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-2xl">
            {view === 'friends' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {visibleFriends.length === 0 ? (
                        <div className="text-center p-10 text-nature-500 dark:text-nature-400 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm mt-4">
                            <p className="text-4xl mb-3">👫</p>
                            <p className="text-[15px] font-semibold text-nature-800 dark:text-white">No friends yet</p>
                            <p className="text-xs mt-2 text-nature-500 dark:text-nature-400 leading-relaxed">
                                Go to <strong className="text-nature-700 dark:text-oat-50">Community</strong> to browse members and add friends.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                            {visibleFriends.map(f => (
                                <div key={f.publicKey} className="p-3 px-4 flex items-center justify-between transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30">
                                    <div className="flex items-center gap-3">
                                        <button 
                                            type="button"
                                            aria-label={`View ${f.callsign}'s profile`}
                                            className="bg-transparent border-none p-0 cursor-pointer text-left hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-full"
                                            onClick={() => onOpenProfile && onOpenProfile(f.publicKey)}
                                        >
                                            <Avatar 
                                                callsign={f.callsign} 
                                                avatarUrl={f.avatarUrl || memberAvatarMap[f.publicKey]}
                                                size={36}
                                            />
                                        </button>
                                        <div>
                                            <button 
                                                type="button"
                                                className="font-bold text-[14px] text-nature-900 dark:text-white flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer hover:underline text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                                                onClick={() => onOpenProfile && onOpenProfile(f.publicKey)}
                                            >
                                                {f.callsign}
                                            </button>
                                            <div className="text-[11px] text-nature-400 dark:text-nature-500 font-medium mt-0.5">
                                                Added {relativeDate(f.addedAt)}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {onNavigate && (
                                            <button
                                                type="button"
                                                onClick={() => handleMessage(f.publicKey)}
                                                className="bg-emerald-600 border-none text-white rounded-lg px-2.5 py-1 text-xs font-bold cursor-pointer hover:bg-emerald-700 shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                                title={`Message ${f.callsign}`}
                                                aria-label={`Message ${f.callsign}`}
                                            >
                                                💬
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveFriend(f.publicKey)}
                                            aria-label={`Remove ${f.callsign} from friends`}
                                            className="bg-transparent border-none text-red-500 text-xs font-semibold cursor-pointer px-2.5 py-1 rounded-lg hover:bg-red-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
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

            </div>

            {/* ===== COMMUNITY ===== */}
            <div role="tabpanel" id={panelId('community')} aria-labelledby={tabId('community')} hidden={view !== 'community'} tabIndex={0} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-2xl">
            {view === 'community' && onDemand === true && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300" data-testid="people-on-demand">
                    <p className="text-[13px] font-medium text-nature-600 dark:text-nature-300 mb-4 bg-oat-50 dark:bg-nature-900 p-3 rounded-xl border border-nature-200 dark:border-nature-800 shadow-sm">
                        Find someone by name, or see who's near you. Tap <strong className="text-emerald-700 dark:text-emerald-300 font-bold">+ Add</strong> to add someone as a friend.
                    </p>

                    {/* Search: the node answers, from 2 characters */}
                    <div className="mb-4">
                        <label htmlFor="people-search" className="sr-only">Search members by name</label>
                        <input
                            id="people-search"
                            type="search"
                            placeholder="🔍 Search by name..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="w-full min-h-[44px] p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-[14px] font-medium focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none shadow-sm placeholder:text-nature-500 dark:placeholder:text-nature-400"
                        />
                        <div className="text-xs text-nature-600 dark:text-nature-300 mt-1.5 font-medium" aria-live="polite" data-testid="people-search-status">
                            {searchQuery.trim() && searchQuery.trim().length < MEMBERS_SEARCH_MIN_CHARS
                                ? `Type at least ${MEMBERS_SEARCH_MIN_CHARS} letters of a name.`
                                : searchState === 'searching' ? 'Searching…'
                                : searchState === 'failed' ? "Couldn't search just now. Check your connection and try again."
                                : visibleFound ? (visibleFound.length === 0
                                    ? 'Nobody here has a name starting with that.'
                                    : `${visibleFound.length} member${visibleFound.length !== 1 ? 's' : ''} found${(found?.length ?? 0) >= MEMBERS_SEARCH_LIMIT ? ` (the first ${MEMBERS_SEARCH_LIMIT}: type more of the name to narrow it)` : ''}`)
                                : null}
                        </div>
                    </div>
                    {visibleFound && visibleFound.length > 0 && (
                        <div className={`${listBox} mb-5`} data-testid="people-found">
                            {visibleFound.map(m => personRow(m, false))}
                        </div>
                    )}

                    {/* Near you: the 50 nearest the member's area, never everyone */}
                    <h3 className="text-[13px] font-bold text-nature-800 dark:text-oat-50 mb-2 px-1">Near you</h3>
                    {nearState === 'loading' ? (
                        <p className={`${lineText} p-4 text-center animate-pulse`}>Finding who's near you…</p>
                    ) : nearState === 'none' ? (
                        <p className={lineText} data-testid="people-no-area">Set your area to see who's near you (Settings → Your area). Search works without it.</p>
                    ) : nearState === 'failed' ? (
                        <p className={`${lineText} flex flex-wrap items-center gap-x-2`} data-testid="people-near-failed">
                            <span>Couldn't check who's near you just now.</span>
                            <button type="button" onClick={() => setNearTry(n => n + 1)} className={linkButton}>Try again</button>
                        </p>
                    ) : visibleNear.length === 0 ? (
                        <p className={lineText}>Nobody else is here yet. Search by name, or invite someone.</p>
                    ) : (
                        <>
                            <p className={`${lineText} mb-2`}>The {visibleNear.length} closest member{visibleNear.length !== 1 ? 's' : ''} to your area.</p>
                            <div className={listBox} data-testid="people-near">
                                {visibleNear.map(m => personRow(m, true))}
                            </div>
                        </>
                    )}
                </div>
            )}
            {view === 'community' && onDemand !== true && (
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

                    {loading || onDemand === null ? (
                        <p className="text-center text-nature-500 p-8 font-medium animate-pulse">Loading community...</p>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                            {filteredMembers.map(m => (
                                    <div key={m.publicKey} className="p-3 px-4 flex items-center justify-between transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30">
                                        <div className="flex items-center gap-3">
                                            <button 
                                                type="button"
                                                aria-label={`View ${m.callsign}'s profile`}
                                                className="bg-transparent border-none p-0 cursor-pointer text-left hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-full"
                                                onClick={() => onOpenProfile && onOpenProfile(m.publicKey)}
                                            >
                                                <Avatar callsign={m.callsign} avatarUrl={m.avatarUrl} size={36} />
                                            </button>
                                            <div>
                                                <button 
                                                    type="button"
                                                    className="font-bold text-[14px] text-nature-900 dark:text-white flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer hover:underline text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
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
                                                type="button"
                                                onClick={() => handleAddFriend(m.publicKey)}
                                                aria-label={`Add ${m.callsign} as friend`}
                                                className="bg-emerald-600 border-none text-white rounded-lg px-3.5 py-1.5 text-xs font-bold cursor-pointer hover:bg-emerald-700 shadow-sm transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
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

            </div>

            {/* ===== INVITES ===== */}
            <div role="tabpanel" id={panelId('invites')} aria-labelledby={tabId('invites')} hidden={view !== 'invites'} tabIndex={0} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-2xl">
            {view === 'invites' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 bg-white dark:bg-nature-900 rounded-2xl shadow-soft border border-nature-200 dark:border-nature-800 overflow-hidden">
                    <InvitePage identity={identity} onNavigate={onNavigate} />
                </div>
            )}
            </div>


        </div>
    );
}
