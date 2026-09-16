import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

interface BulletinSectionProps {
    activeNode: NodeProfile;
    onRefresh: () => void;
}

interface PulseChannel {
    id: string;
    title?: string;
    feedUrl?: string;
    url?: string;
    handle?: string;
    platform?: string;
    category?: string;
    description?: string;
    itemCount?: number;
    enabled?: boolean;
}

export function BulletinSection({ activeNode, onRefresh }: BulletinSectionProps) {
    const [subTab, setSubTab] = useState<'announcements' | 'pulse'>('announcements');

    // Announcements state
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [severity, setSeverity] = useState<'info' | 'alert' | 'critical'>('info');
    const [sendingAnnouncement, setSendingAnnouncement] = useState(false);
    const [announcementSuccess, setAnnouncementSuccess] = useState<string | null>(null);

    // Pulse channels state
    const [channels, setChannels] = useState<PulseChannel[]>([]);
    const [loadingChannels, setLoadingChannels] = useState(false);
    const [showAddChannelModal, setShowAddChannelModal] = useState(false);
    const [channelTitle, setChannelTitle] = useState('');
    const [channelFeedUrl, setChannelFeedUrl] = useState('');
    const [channelDescription, setChannelDescription] = useState('');
    const [addingChannel, setAddingChannel] = useState(false);

    const loadChannels = async () => {
        setLoadingChannels(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/pulse/channels');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                const raw = data.channels || data;
                setChannels(Array.isArray(raw) ? raw : []);
            }
        } catch {
            setChannels([]);
        } finally {
            setLoadingChannels(false);
        }
    };

    useEffect(() => {
        loadChannels();
    }, [activeNode?.id, activeNode?.url]);

    const handleBroadcastAnnouncement = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!body.trim()) return;

        setSendingAnnouncement(true);
        setAnnouncementSuccess(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/announcements');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    title: title.trim() || 'System Notice',
                    body: body.trim(),
                    severity,
                }),
            });
            if (res.ok) {
                setAnnouncementSuccess('Announcement broadcasted to community feed!');
                setTitle('');
                setBody('');
                onRefresh();
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to send announcement');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        } finally {
            setSendingAnnouncement(false);
        }
    };

    const handleAddChannel = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!channelFeedUrl.trim() || !channelTitle.trim()) return;
        setAddingChannel(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/pulse/channels');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    url: channelFeedUrl.trim(),
                    category: 'learn',
                }),
            });
            if (res.ok) {
                setChannelTitle('');
                setChannelFeedUrl('');
                setChannelDescription('');
                setShowAddChannelModal(false);
                await loadChannels();
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to add pulse channel');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        } finally {
            setAddingChannel(false);
        }
    };

    const handleRemoveChannel = async (channelId: string) => {
        if (!confirm('Remove this Pulse feed channel?')) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/pulse/channels/remove');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ id: channelId }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to remove channel');
                return;
            }
            await loadChannels();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Header & Subtabs */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>📢</span>
                        <span>Bulletin &amp; News</span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Announcements with severity, community broadcast banners, and Pulse RSS channel curation
                    </p>
                </div>

                <div className="flex items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 self-start sm:self-auto">
                    <button
                        onClick={() => setSubTab('announcements')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'announcements'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Announcements
                    </button>
                    <button
                        onClick={() => setSubTab('pulse')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'pulse'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Pulse Channels ({channels.length})
                    </button>
                </div>
            </div>

            {/* Subtab: Announcements */}
            {subTab === 'announcements' && (
                <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 shadow-xl space-y-6 max-w-2xl">
                    <div>
                        <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                            <span>📣</span>
                            <span>Broadcast Announcement</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Push an urgent alert or general notice to all member mobile and PWA feeds.
                        </p>
                    </div>

                    {announcementSuccess && (
                        <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs font-semibold flex items-center gap-2">
                            <span>✓</span>
                            <span>{announcementSuccess}</span>
                        </div>
                    )}

                    <form onSubmit={handleBroadcastAnnouncement} className="space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">Headline / Title</label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="e.g. Village Market Time Change"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">Severity Level</label>
                            <div className="grid grid-cols-3 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setSeverity('info')}
                                    className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${
                                        severity === 'info'
                                            ? 'bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-sm'
                                            : 'bg-nature-950 text-nature-400 border-nature-800 hover:text-white'
                                    }`}
                                >
                                    ℹ️ Information
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSeverity('alert')}
                                    className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${
                                        severity === 'alert'
                                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm'
                                            : 'bg-nature-950 text-nature-400 border-nature-800 hover:text-white'
                                    }`}
                                >
                                    ⚠️ Warning Alert
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSeverity('critical')}
                                    className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${
                                        severity === 'critical'
                                            ? 'bg-red-500/20 text-red-300 border-red-500/40 shadow-sm'
                                            : 'bg-nature-950 text-nature-400 border-nature-800 hover:text-white'
                                    }`}
                                >
                                    🚨 Critical Emergency
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-300 mb-1">Message Content</label>
                            <textarea
                                value={body}
                                onChange={(e) => setBody(e.target.value)}
                                placeholder="Write the announcement message details here..."
                                rows={4}
                                required
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500 resize-none"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={sendingAnnouncement}
                            className="px-6 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md flex items-center gap-2 disabled:opacity-50"
                        >
                            {sendingAnnouncement ? 'Broadcasting...' : 'Broadcast to Community'}
                        </button>
                    </form>
                </div>
            )}

            {/* Subtab: Pulse Channels */}
            {subTab === 'pulse' && (
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-bold text-white m-0">Curated Pulse RSS Channels</h3>
                            <p className="text-xs text-nature-400 m-0 mt-0.5">
                                Feeds distributed through the community Pulse reader tab
                            </p>
                        </div>
                        <button
                            onClick={() => setShowAddChannelModal(true)}
                            className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md flex items-center gap-1.5"
                        >
                            <span>+</span>
                            <span>Add Feed Channel</span>
                        </button>
                    </div>

                    {loadingChannels ? (
                        <div className="p-8 text-center text-xs text-nature-400">Loading channels...</div>
                    ) : (Array.isArray(channels) ? channels : []).length === 0 ? (
                        <div className="p-8 text-center bg-nature-900/40 border border-nature-800 rounded-2xl">
                            <p className="text-sm font-semibold text-white mb-1">No channels added yet</p>
                            <p className="text-xs text-nature-400 mb-4">
                                Add local news, weather, or agricultural RSS feeds for your members.
                            </p>
                            <button
                                onClick={() => setShowAddChannelModal(true)}
                                className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white"
                            >
                                + Add First Channel
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {(Array.isArray(channels) ? channels : []).map((c) => (
                                <div
                                    key={c.id}
                                    className="p-4 rounded-xl bg-nature-900/80 border border-nature-800 flex items-center justify-between gap-3 shadow-md"
                                >
                                    <div>
                                        <h4 className="text-sm font-bold text-white m-0">{c.title || c.handle || c.url}</h4>
                                        <span className="text-[11px] font-mono text-nature-400 truncate block max-w-xs sm:max-w-sm mt-0.5">
                                            {c.url || c.feedUrl}
                                        </span>
                                        {c.description && (
                                            <p className="text-xs text-nature-300 m-0 mt-1">{c.description}</p>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => handleRemoveChannel(c.id)}
                                        className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs text-red-400 font-bold border border-nature-700 shrink-0"
                                    >
                                        Remove
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Add Channel Modal */}
            {showAddChannelModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-fade-in">
                        <h3 className="text-base font-bold text-white m-0">📚 Add Curated Pulse Feed</h3>
                        <form onSubmit={handleAddChannel} className="space-y-3">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Feed Title</label>
                                <input
                                    type="text"
                                    value={channelTitle}
                                    onChange={(e) => setChannelTitle(e.target.value)}
                                    placeholder="e.g. Local Permaculture Gazette"
                                    required
                                    autoFocus
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">RSS/Atom Feed URL</label>
                                <input
                                    type="url"
                                    value={channelFeedUrl}
                                    onChange={(e) => setChannelFeedUrl(e.target.value)}
                                    placeholder="https://example.org/feed.xml"
                                    required
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500 font-mono text-xs"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Description (optional)</label>
                                <input
                                    type="text"
                                    value={channelDescription}
                                    onChange={(e) => setChannelDescription(e.target.value)}
                                    placeholder="Brief summary of feed contents"
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowAddChannelModal(false)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={addingChannel}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                                >
                                    {addingChannel ? 'Adding...' : 'Add Channel'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
