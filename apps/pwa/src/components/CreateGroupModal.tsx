import { useState, useEffect } from 'react';
import { createGroup, type Group, type GroupCategory, type JoinPolicy } from '../lib/api';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (group: Group) => void;
}

const CATEGORIES: Array<{ key: GroupCategory; label: string; icon: string; desc: string }> = [
    { key: 'working_group', label: 'Working Group', icon: '🤝', desc: 'Practical focus group coordinating tasks' },
    { key: 'project', label: 'Project Team', icon: '🛠️', desc: 'Collaborating on an initiative or venture' },
    { key: 'guild', label: 'Guild', icon: '🛡️', desc: 'Skill sharing and craft practitioners' },
    { key: 'social', label: 'Social Circle', icon: '☕', desc: 'Community chats and shared interests' },
    { key: 'general', label: 'General', icon: '💬', desc: 'Open discussion space' },
];

const JOIN_POLICIES: Array<{ key: JoinPolicy; label: string; icon: string; desc: string }> = [
    { key: 'open', label: 'Open', icon: '🚪', desc: 'Anyone can join immediately' },
    { key: 'request_to_join', label: 'Request to Join', icon: '⏳', desc: 'Convenor approval required to join' },
    { key: 'invite_only', label: 'Invite Only', icon: '🔒', desc: 'Convenor must invite new members' },
];

export function CreateGroupModal({ isOpen, onClose, onCreated }: Props) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<GroupCategory>('working_group');
    const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>('open');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || name.trim().length < 2) {
            setError('Group name must be at least 2 characters long.');
            return;
        }

        setSubmitting(true);
        setError(null);
        try {
            const group = await createGroup({
                name: name.trim(),
                description: description.trim() || undefined,
                category,
                joinPolicy,
            });
            onCreated(group);
            setName('');
            setDescription('');
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to create group');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <h2 className="text-lg font-black text-nature-950 dark:text-white">
                        👥 Create a Group
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white hover:bg-nature-200 dark:hover:bg-nature-800 transition-colors"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 space-y-4">
                    {/* Plain Language Framing Banner */}
                    <div className="p-3 bg-nature-200/60 dark:bg-nature-900/60 border border-nature-300 dark:border-nature-800 rounded-xl text-xs text-nature-700 dark:text-nature-300 leading-relaxed">
                        ℹ️ <strong>A group is a place to talk to some people rather than everyone.</strong> It does not hold beans and does not confer trust or voting standing.
                    </div>

                    {error && (
                        <div className="p-3 bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300">
                            {error}
                        </div>
                    )}

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-1">
                            Group Name *
                        </label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Bindarrabi Garden Crew, Solar Guild"
                            maxLength={60}
                            required
                            className="w-full px-3 py-2 bg-white dark:bg-nature-950 border border-nature-300 dark:border-nature-800 rounded-xl text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-1">
                            Purpose / Description
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What does this group discuss or coordinate?"
                            rows={3}
                            maxLength={300}
                            className="w-full px-3 py-2 bg-white dark:bg-nature-950 border border-nature-300 dark:border-nature-800 rounded-xl text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            Category
                        </label>
                        <div className="space-y-2">
                            {CATEGORIES.map((cat) => {
                                const active = category === cat.key;
                                return (
                                    <button
                                        key={cat.key}
                                        type="button"
                                        onClick={() => setCategory(cat.key)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                                            active
                                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 dark:border-emerald-500'
                                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-800 hover:border-nature-300'
                                        }`}
                                    >
                                        <span className="text-2xl">{cat.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-nature-900 dark:text-white">{cat.label}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{cat.desc}</div>
                                        </div>
                                        {active && <span className="text-emerald-600 font-bold">✓</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            Join Policy
                        </label>
                        <div className="space-y-2">
                            {JOIN_POLICIES.map((pol) => {
                                const active = joinPolicy === pol.key;
                                return (
                                    <button
                                        key={pol.key}
                                        type="button"
                                        onClick={() => setJoinPolicy(pol.key)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                                            active
                                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 dark:border-emerald-500'
                                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-800 hover:border-nature-300'
                                        }`}
                                    >
                                        <span className="text-2xl">{pol.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-nature-900 dark:text-white">{pol.label}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{pol.desc}</div>
                                        </div>
                                        {active && <span className="text-emerald-600 font-bold">✓</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={submitting || !name.trim()}
                        className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2"
                    >
                        {submitting ? 'Creating...' : 'Create Group (You become Convenor)'}
                    </button>
                </form>
            </div>
        </div>
    );
}
