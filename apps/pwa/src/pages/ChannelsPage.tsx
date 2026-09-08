/**
 * Channels & Showcase — a member's own external publishing accounts (The Pulse, Phase 1).
 *
 * Rules:
 * - Each platform states its ongoing cost up front ("updates itself" vs "a tap per post").
 * - The cross-post warning fires at the moment of adding a second video platform.
 * - Out of scope: Creator OAuth linking (plainly explains linking is done in phone app).
 * - Responsive at 320dp and 1.3x font scale without clipping or horizontal overflow.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    type ChannelPlatform as Platform,
    type ChannelCategory as Category,
    LISTING_LABEL,
    PLATFORMS,
    CATEGORIES,
    VIDEO_PLATFORMS,
    platformMeta,
    categoryMeta,
} from '@beanpool/core';
import {
    type MemberCreatorChannel,
    getMemberChannels,
    addMemberChannel,
    updateMemberChannel,
    deleteMemberChannel,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { PulseNudges } from '../components/PulseNudges';

interface Props {
    identity: BeanPoolIdentity | null;
    onBack: () => void;
    onViewFeed: () => void;
    onSharePost: (channelId?: string) => void;
}

interface CrossPostPrompt {
    newChannel: MemberCreatorChannel;
    rivalChannel: MemberCreatorChannel;
    several: boolean;
}

export function ChannelsPage({ identity, onBack, onViewFeed, onSharePost }: Props) {
    const [channels, setChannels] = useState<MemberCreatorChannel[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);

    // Add channel form state
    const [adding, setAdding] = useState(false);
    const [platform, setPlatform] = useState<Platform>('youtube');
    const [category, setCategory] = useState<Category | null>(null);
    const [value, setValue] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);

    // Cross-post modal state
    const [crossPostPrompt, setCrossPostPrompt] = useState<CrossPostPrompt | null>(null);
    // Channel removal confirmation modal state
    const [channelToRemove, setChannelToRemove] = useState<MemberCreatorChannel | null>(null);

    const channelsRef = useRef<MemberCreatorChannel[]>([]);
    useEffect(() => { channelsRef.current = channels; }, [channels]);

    const load = useCallback(async () => {
        if (!identity) {
            setListError('No identity on this device yet.');
            setLoading(false);
            return;
        }
        try {
            const res = await getMemberChannels();
            setChannels(res.channels || []);
            setListError(null);
        } catch (e: any) {
            setListError(e?.message || 'Could not load your channels.');
        } finally {
            setLoading(false);
        }
    }, [identity]);

    useEffect(() => {
        void load();
    }, [load]);

    const handleAdd = async () => {
        if (!identity || !value.trim() || !category) return;
        setSaving(true);
        setFormError(null);

        try {
            const res = await addMemberChannel({
                platform,
                url: value.trim(),
                category,
            });

            setValue('');
            setCategory(null);
            setAdding(false);
            await load();

            // Cross-post prompt if another video channel exists
            const others: MemberCreatorChannel[] = res.otherVideoChannels || [];
            if (VIDEO_PLATFORMS.includes(platform) && others.length > 0 && res.channel?.id) {
                const rival = others.find(c => c.isPrimaryVideo) ?? others[0];
                setCrossPostPrompt({
                    newChannel: res.channel,
                    rivalChannel: rival,
                    several: others.length > 1,
                });
            }
        } catch (e: any) {
            setFormError(e?.message || 'Could not add that channel.');
        } finally {
            setSaving(false);
        }
    };

    const handlePatch = async (id: string, body: Record<string, unknown>, optimistic?: Partial<MemberCreatorChannel>) => {
        if (!identity) return;
        const prev = channelsRef.current.find(c => c.id === id);
        if (optimistic) {
            setChannels(cs => cs.map(c => (c.id === id ? { ...c, ...optimistic } : c)));
        }
        try {
            await updateMemberChannel(id, body);
            await load();
        } catch (e: any) {
            if (optimistic && prev) {
                setChannels(cs => cs.map(c => {
                    if (c.id !== id) return c;
                    const restored: MemberCreatorChannel = { ...c };
                    for (const key of Object.keys(optimistic) as (keyof MemberCreatorChannel)[]) {
                        (restored as any)[key] = (prev as any)[key];
                    }
                    return restored;
                }));
            }
            setListError(e?.message || 'Could not save that change.');
        }
    };

    useEffect(() => {
        if (!crossPostPrompt && !channelToRemove) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setCrossPostPrompt(null);
                setChannelToRemove(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [crossPostPrompt, channelToRemove]);

    const handleSetPrimary = (id: string) => handlePatch(id, { isPrimaryVideo: true });

    const handleChangeCategory = (id: string, next: Category) => {
        setEditingId(null);
        if (channelsRef.current.find(c => c.id === id)?.category === next) return;
        handlePatch(id, { category: next }, { category: next });
    };

    const confirmRemoveChannel = async () => {
        if (!channelToRemove) return;
        const channel = channelToRemove;
        setChannelToRemove(null);

        try {
            await deleteMemberChannel(channel.id);
            await load();
        } catch (e: any) {
            setListError(e?.message || 'Could not remove that channel.');
        }
    };

    const videoChannels = channels.filter(c => VIDEO_PLATFORMS.includes(c.platform));
    const showCrossPostBanner = videoChannels.length > 1;
    const primary = videoChannels.find(c => c.isPrimaryVideo);

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6 pb-24 min-h-full">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 mb-6 pb-4 border-b border-nature-200 dark:border-nature-800">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex items-center gap-1 text-sm font-bold text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer p-1 transition-colors"
                    aria-label="Go back"
                >
                    ‹ Back
                </button>

                <h2 className="text-lg sm:text-xl font-extrabold text-nature-950 dark:text-white m-0 tracking-tight text-center flex-1">
                    Channels & Showcase
                </h2>

                <button
                    type="button"
                    onClick={onViewFeed}
                    className="text-xs sm:text-sm font-bold text-terra-600 dark:text-terra-400 hover:text-terra-700 bg-transparent border-none cursor-pointer p-1 transition-colors whitespace-nowrap"
                    aria-label="View The Pulse community feed"
                >
                    View Feed ↗
                </button>
            </div>

            {loading ? (
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 rounded-full border-4 border-nature-200 dark:border-nature-800 border-t-terra-500 animate-spin"></div>
                </div>
            ) : (
                <>
                    {/* List Error Box */}
                    {listError && (
                        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 p-3.5 rounded-2xl mb-4 text-xs sm:text-sm" role="alert">
                            {listError}
                        </div>
                    )}

                    {/* Pulse Nudges */}
                    <PulseNudges
                        channels={channels}
                        onNudgeDismissed={load}
                        onAddFromClipboard={(url) => onSharePost(url)}
                        onShareChannel={(id) => onSharePost(id)}
                    />

                    {/* Empty State */}
                    {channels.length === 0 && !adding && (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-3xl p-6 sm:p-8 text-center my-4 shadow-sm">
                            <div className="text-4xl mb-3 select-none">📡</div>
                            <h3 className="text-base sm:text-lg font-bold text-nature-900 dark:text-white mb-2">
                                Already posting your work somewhere?
                            </h3>
                            <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 max-w-md mx-auto leading-relaxed mb-6">
                                Add it here so your neighbours can find it — and trade with you. You won't have to post twice.
                            </p>
                            <button
                                type="button"
                                onClick={() => { setAdding(true); setFormError(null); }}
                                className="px-5 py-2.5 rounded-xl font-bold text-sm bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-transform active:scale-95"
                            >
                                + Add a channel
                            </button>
                        </div>
                    )}

                    {/* Cross-Post Info Banner */}
                    {showCrossPostBanner && (
                        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200 p-3.5 rounded-2xl mb-4 text-xs sm:text-sm leading-relaxed" role="alert">
                            {primary
                                ? `You post video in more than one place. The feed uses your ${platformMeta(primary.platform).label} as the main one.`
                                : 'You post video in more than one place. Pick which one the feed should use.'}
                        </div>
                    )}

                    {/* Connected Channel Cards */}
                    <div className="space-y-4 mb-6">
                        {channels.map(channel => {
                            const meta = platformMeta(channel.platform);
                            const isOauthPlatform = channel.platform === 'tiktok' || channel.platform === 'instagram';

                            return (
                                <div
                                    key={channel.id}
                                    className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 shadow-sm"
                                >
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <h3 className="font-bold text-base text-nature-950 dark:text-white m-0 truncate">
                                            <span className="mr-1.5">{meta.icon}</span>
                                            <span>{meta.label}</span>
                                            {channel.handle && <span className="font-normal text-nature-500 dark:text-nature-400"> · {channel.handle}</span>}
                                        </h3>
                                        {channel.oauthVerifiedAt && (
                                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 shrink-0">
                                                ✓ Verified
                                            </span>
                                        )}
                                    </div>

                                    <p className="text-xs text-nature-500 dark:text-nature-400 mb-4">
                                        {channel.supportsAutolist
                                            ? (channel.oauthVerifiedAt ? 'Updates itself (connected)' : 'Updates itself')
                                            : LISTING_LABEL[meta.listing === 'auto' ? 'manual' : meta.listing]}
                                        {channel.isPrimaryVideo ? ' · main video channel' : ''}
                                    </p>

                                    {/* Show on local feed toggle */}
                                    <div className="flex items-center justify-between py-2 border-t border-nature-100 dark:border-nature-800/60">
                                        <span className="text-xs sm:text-sm font-semibold text-nature-800 dark:text-nature-200">
                                            Show on the local feed
                                        </span>
                                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                            <input
                                                type="checkbox"
                                                checked={channel.syndicateToNode}
                                                onChange={e => handlePatch(channel.id, { syndicateToNode: e.target.checked }, { syndicateToNode: e.target.checked })}
                                                className="sr-only peer"
                                                aria-label={`Show ${meta.label} on the local feed`}
                                            />
                                            <div className="w-11 h-6 bg-nature-200 peer-focus-visible:ring-2 peer-focus-visible:ring-terra-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-nature-900 rounded-full peer dark:bg-nature-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-terra-500"></div>
                                        </label>
                                    </div>

                                    {/* Category row & picker */}
                                    <div className="flex items-center justify-between py-2 border-t border-nature-100 dark:border-nature-800/60">
                                        <span className="text-xs sm:text-sm font-semibold text-nature-800 dark:text-nature-200 flex items-center gap-1">
                                            <span>{categoryMeta(channel.category).icon}</span>
                                            <span>{categoryMeta(channel.category).label}</span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setEditingId(editingId === channel.id ? null : channel.id)}
                                            className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-700 cursor-pointer transition-colors"
                                        >
                                            {editingId === channel.id ? 'Done' : 'Change category'}
                                        </button>
                                    </div>

                                    {/* Inline category picker drawer */}
                                    {editingId === channel.id && (
                                        <div className="p-3 my-2 rounded-xl bg-nature-50 dark:bg-nature-950/60 border border-nature-200 dark:border-nature-800 animate-in fade-in duration-150">
                                            <div className="text-xs font-bold text-nature-700 dark:text-nature-300 mb-2">
                                                Select Category
                                            </div>
                                            <div className="grid grid-cols-2 gap-1.5">
                                                {CATEGORIES.map(cat => {
                                                    const isSelected = channel.category === cat.id;
                                                    return (
                                                        <button
                                                            key={cat.id}
                                                            type="button"
                                                            onClick={() => handleChangeCategory(channel.id, cat.id)}
                                                            className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-semibold border text-left cursor-pointer transition-colors ${
                                                                isSelected
                                                                    ? 'bg-terra-500 border-terra-500 text-white shadow-xs'
                                                                    : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-800 dark:text-nature-200 hover:bg-nature-100 dark:hover:bg-nature-700'
                                                            }`}
                                                        >
                                                            <span>{cat.icon}</span>
                                                            <span className="truncate">{cat.label}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* OAuth informational notice (Task 2 parity guardrail) */}
                                    {isOauthPlatform && !channel.oauthVerifiedAt && (
                                        <div className="text-[11px] text-nature-500 dark:text-nature-400 bg-nature-50 dark:bg-nature-950/60 p-2.5 rounded-xl border border-nature-100 dark:border-nature-800 my-2 leading-relaxed">
                                            📱 <strong>Creator account linking:</strong> Automatic feed sync via OAuth is configured on the phone app. On the web client, you can share individual posts directly with "+ Share post" below.
                                        </div>
                                    )}

                                    {/* Channel Actions */}
                                    <div className="flex flex-wrap items-center gap-2 pt-3 mt-1 border-t border-nature-100 dark:border-nature-800/60">
                                        {!channel.supportsAutolist && (
                                            <button
                                                type="button"
                                                onClick={() => onSharePost(channel.id)}
                                                className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-colors"
                                            >
                                                + Share post
                                            </button>
                                        )}

                                        {VIDEO_PLATFORMS.includes(channel.platform) && !channel.isPrimaryVideo && videoChannels.length > 1 && (
                                            <button
                                                type="button"
                                                onClick={() => handleSetPrimary(channel.id)}
                                                className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-800 text-nature-700 dark:text-nature-200 hover:bg-nature-100 dark:hover:bg-nature-700 cursor-pointer transition-colors"
                                            >
                                                Make main
                                            </button>
                                        )}

                                        <button
                                            type="button"
                                            onClick={() => setChannelToRemove(channel)}
                                            className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 bg-transparent border-none cursor-pointer transition-colors ml-auto"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Add Channel Form or Trigger Button */}
                    {adding ? (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-3xl p-5 sm:p-6 shadow-sm mb-6">
                            <h3 className="text-sm sm:text-base font-bold text-nature-900 dark:text-white mb-3">
                                Where do you post?
                            </h3>

                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-5">
                                {PLATFORMS.map(p => {
                                    const active = p.id === platform;
                                    return (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => setPlatform(p.id)}
                                            className={`flex flex-col items-center justify-center p-3 rounded-2xl border text-center transition-all cursor-pointer ${
                                                active
                                                    ? 'border-terra-500 bg-terra-50/60 dark:bg-terra-950/30 ring-1 ring-terra-500'
                                                    : 'border-nature-200 dark:border-nature-800 bg-nature-50 dark:bg-nature-950 hover:bg-nature-100 dark:hover:bg-nature-900'
                                            }`}
                                        >
                                            <span className="text-2xl mb-1 select-none">{p.icon}</span>
                                            <span className={`text-xs font-bold ${active ? 'text-terra-900 dark:text-terra-300' : 'text-nature-900 dark:text-white'}`}>
                                                {p.label}
                                            </span>
                                            <span className="text-[10px] text-nature-500 dark:text-nature-400 mt-0.5">
                                                {LISTING_LABEL[p.listing]}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>

                            <label className="block text-xs sm:text-sm font-bold text-nature-900 dark:text-white mb-2">
                                Your link or handle
                            </label>
                            <input
                                type="url"
                                value={value}
                                onChange={e => setValue(e.target.value.replace(/\s/g, ''))}
                                placeholder={platformMeta(platform).hint}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck="false"
                                className="w-full py-2.5 px-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-terra-400 mb-5 font-mono"
                            />

                            <label className="block text-xs sm:text-sm font-bold text-nature-900 dark:text-white mb-2">
                                What's it about?
                            </label>
                            <div className="flex flex-wrap gap-2 mb-5">
                                {CATEGORIES.map(c => {
                                    const active = c.id === category;
                                    return (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => setCategory(c.id)}
                                            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                                                active
                                                    ? 'bg-terra-500 border-terra-500 text-white shadow-sm'
                                                    : 'bg-nature-50 dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-700'
                                            }`}
                                        >
                                            {c.icon} {c.label}
                                        </button>
                                    );
                                })}
                            </div>

                            {formError && (
                                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 p-3 rounded-xl mb-4 text-xs sm:text-sm" role="alert">
                                    {formError}
                                </div>
                            )}

                            <div className="flex items-center justify-end gap-2.5">
                                <button
                                    type="button"
                                    onClick={() => { setAdding(false); setValue(''); setCategory(null); setFormError(null); }}
                                    className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleAdd}
                                    disabled={saving || !value.trim() || !category}
                                    className="px-5 py-2 rounded-xl text-xs sm:text-sm font-bold bg-terra-600 hover:bg-terra-500 disabled:opacity-50 text-white cursor-pointer shadow-sm"
                                >
                                    {saving ? 'Adding…' : 'Add channel'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col sm:flex-row items-center gap-3">
                            <button
                                type="button"
                                onClick={() => { setAdding(true); setFormError(null); }}
                                className="w-full sm:w-auto px-5 py-2.5 rounded-xl font-bold text-sm bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-colors"
                            >
                                + Add a channel
                            </button>

                            {channels.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => onSharePost()}
                                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl font-bold text-sm border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer shadow-sm transition-colors"
                                >
                                    Share a post to Pulse →
                                </button>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* Cross-post warning modal */}
            {crossPostPrompt && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
                    onClick={() => setCrossPostPrompt(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="cross-post-dialog-title"
                        onClick={e => e.stopPropagation()}
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-3xl max-w-md w-full p-6 shadow-2xl"
                    >
                        <h4 id="cross-post-dialog-title" className="text-base sm:text-lg font-bold text-nature-900 dark:text-white mb-2">
                            {crossPostPrompt.several ? 'You post video in more than one place' : 'You post video in two places'}
                        </h4>
                        <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 mb-5 leading-relaxed">
                            If you put the same videos on {platformMeta(crossPostPrompt.newChannel.platform).label} and {platformMeta(crossPostPrompt.rivalChannel.platform).label}, they'd show up twice on the feed.
                            <br /><br />
                            Which should the feed use?
                        </p>

                        <div className="space-y-2">
                            <button
                                type="button"
                                onClick={async () => {
                                    await handleSetPrimary(crossPostPrompt.newChannel.id);
                                    setCrossPostPrompt(null);
                                }}
                                className="w-full py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold bg-terra-600 hover:bg-terra-500 text-white cursor-pointer"
                            >
                                {platformMeta(crossPostPrompt.newChannel.platform).label} {crossPostPrompt.newChannel.supportsAutolist ? '(updates itself)' : ''}
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    await handleSetPrimary(crossPostPrompt.rivalChannel.id);
                                    setCrossPostPrompt(null);
                                }}
                                className="w-full py-2.5 px-4 rounded-xl text-xs sm:text-sm font-bold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-50 cursor-pointer"
                            >
                                {platformMeta(crossPostPrompt.rivalChannel.platform).label} {crossPostPrompt.rivalChannel.supportsAutolist ? '(updates itself)' : ''}
                            </button>
                            <button
                                type="button"
                                onClick={() => setCrossPostPrompt(null)}
                                className="w-full py-2 text-xs text-nature-500 hover:text-nature-800 dark:hover:text-white bg-transparent border-none cursor-pointer"
                            >
                                {crossPostPrompt.several ? 'Keep all — I post different things' : 'Both — I post different things'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Remove channel confirmation modal */}
            {channelToRemove && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
                    onClick={() => setChannelToRemove(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="remove-channel-dialog-title"
                        onClick={e => e.stopPropagation()}
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl"
                    >
                        <h4 id="remove-channel-dialog-title" className="text-base font-bold text-nature-900 dark:text-white mb-2">
                            Remove this channel?
                        </h4>
                        <p className="text-sm text-nature-600 dark:text-nature-400 mb-5 leading-relaxed">
                            {platformMeta(channelToRemove.platform).label}{channelToRemove.handle ? ` · ${channelToRemove.handle}` : ''} will no longer appear on your profile.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <button
                                type="button"
                                onClick={() => setChannelToRemove(null)}
                                className="px-4 py-2 rounded-xl text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-200 hover:bg-nature-50 cursor-pointer"
                            >
                                Keep it
                            </button>
                            <button
                                type="button"
                                onClick={confirmRemoveChannel}
                                className="px-4 py-2 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white cursor-pointer"
                            >
                                Remove
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
