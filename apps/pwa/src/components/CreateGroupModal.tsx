import { useState, useEffect } from 'react';
import {
    t,
    GROUP_CATEGORY_OPTIONS,
    GROUP_JOIN_POLICY_OPTIONS,
    CREATE_GROUP_DEFAULTS,
    START_ENTERPRISE_BRIDGE,
    bundledGroupEmblem,
    type GroupCategory,
    type JoinPolicy,
} from '@beanpool/core';
import { createGroup, type Group } from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { AvatarPresetPicker } from './AvatarPresetPicker';
import { usePictureCrop } from './PictureCropDialog';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (group: Group) => void;
    /** With Beans involved, the form hands over to the project or enterprise form (group decisions §3.1). */
    onStartWithBeans?: (lifecycle?: 'bounded' | 'ongoing') => void;
}

const JOIN_ICONS: Record<JoinPolicy, string> = {
    open: '🚪',
    request_to_join: '⏳',
    invite_only: '🔒',
};

export function CreateGroupModal({ isOpen, onClose, onCreated, onStartWithBeans }: Props) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<GroupCategory>(CREATE_GROUP_DEFAULTS.category);
    const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>(CREATE_GROUP_DEFAULTS.joinPolicy);
    const [picture, setPicture] = useState<string>(() => bundledGroupEmblem(CREATE_GROUP_DEFAULTS.category));
    const [userPickedPicture, setUserPickedPicture] = useState(false);
    const [showPresetPicker, setShowPresetPicker] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cropper = usePictureCrop();

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const cropped = await cropper.crop(file, 1);
            if (cropped) {
                setUserPickedPicture(true);
                setPicture(cropped);
            }
        } catch { /* cancelled */ }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || name.trim().length < 2) {
            setError(t('Group name must be at least 2 characters long.'));
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
                avatarUrl: picture,
            });
            onCreated(group);
            setName('');
            setDescription('');
            onClose();
        } catch (err: any) {
            setError(err.message || t('Failed to create group'));
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
            aria-labelledby="create-group-title"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <h2 id="create-group-title" className="text-lg font-black text-nature-950 dark:text-white flex items-center gap-1.5">
                        <span aria-hidden="true">👥</span> {t('Create a Group')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center p-1 rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white hover:bg-nature-200 dark:hover:bg-nature-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        aria-label={t('Close')}
                    >
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 space-y-4">
                    {/* Plain Language Framing Banner */}
                    <div className="p-3 bg-nature-200/60 dark:bg-nature-900/60 border border-nature-300 dark:border-nature-800 rounded-xl text-xs text-nature-700 dark:text-nature-300 leading-relaxed">
                        <span aria-hidden="true">ℹ️</span> <strong>{t('A group is a place to talk to some people rather than everyone.')}</strong> {t('It does not hold beans and does not confer trust or voting standing.')}
                    </div>

                    {error && (
                        <div className="p-3 bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300">
                            {error}
                        </div>
                    )}

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            {t('Picture')}
                        </label>
                        <div className="flex items-center gap-3">
                            <img
                                src={resolveAvatarUrl(picture) || ''}
                                alt={t('Group picture')}
                                className="w-14 h-14 rounded-full object-cover border-2 border-emerald-500 shrink-0"
                            />
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => setShowPresetPicker((p) => !p)}
                                    className="px-3 py-1.5 text-xs font-bold rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 cursor-pointer"
                                >
                                    {t('Choose another')}
                                </button>
                                <label className="px-3 py-1.5 text-xs font-bold rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800 cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500">
                                    {t('Choose a photo')}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handlePhotoUpload}
                                        className="sr-only"
                                    />
                                </label>
                            </div>
                        </div>
                        {showPresetPicker && (
                            <div className="mt-3">
                                <AvatarPresetPicker
                                    selected={picture}
                                    onSelect={(uri) => {
                                        setUserPickedPicture(true);
                                        setPicture(uri);
                                        setShowPresetPicker(false);
                                    }}
                                />
                            </div>
                        )}
                        {cropper.dialog}
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-1">
                            {t('Group Name *')}
                        </label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('e.g. Bindarrabi Garden Crew, Solar Guild')}
                            maxLength={60}
                            required
                            className="w-full px-3 py-2 bg-white dark:bg-nature-950 border border-nature-300 dark:border-nature-600 rounded-xl text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-1">
                            {t('Purpose / Description')}
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('What does this group discuss or coordinate?')}
                            rows={3}
                            maxLength={300}
                            className="w-full px-3 py-2 bg-white dark:bg-nature-950 border border-nature-300 dark:border-nature-600 rounded-xl text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 text-sm"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            {t('Category')}
                        </label>
                        <div className="space-y-2">
                            {GROUP_CATEGORY_OPTIONS.map((cat) => {
                                const active = category === cat.key;
                                return (
                                    <button
                                        key={cat.key}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => {
                                            setCategory(cat.key);
                                            if (!userPickedPicture) {
                                                setPicture(bundledGroupEmblem(cat.key));
                                            }
                                        }}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                            active
                                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 dark:border-emerald-500'
                                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-800 hover:border-nature-300'
                                        }`}
                                    >
                                        <span className="text-2xl" aria-hidden="true">{cat.emoji}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-nature-900 dark:text-white">{t(cat.label)}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t(cat.desc)}</div>
                                        </div>
                                        {active && <span className="text-emerald-600 font-bold">✓</span>}
                                    </button>
                                );
                            })}
                        </div>
                        {onStartWithBeans && (
                            <button
                                type="button"
                                onClick={() => onStartWithBeans()}
                                className="w-full mt-3 p-3 border border-dashed border-nature-300 dark:border-nature-700 hover:border-emerald-500 rounded-xl text-left text-xs text-nature-700 dark:text-nature-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                <span className="font-semibold">{t(START_ENTERPRISE_BRIDGE.lead)}</span>{' '}
                                <span className="text-emerald-600 dark:text-emerald-400 font-bold hover:underline">{t(START_ENTERPRISE_BRIDGE.link)}</span>
                            </button>
                        )}
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            {t('Join Policy')}
                        </label>
                        <div className="space-y-2">
                            {GROUP_JOIN_POLICY_OPTIONS.map((pol) => {
                                const active = joinPolicy === pol.key;
                                return (
                                    <button
                                        key={pol.key}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => setJoinPolicy(pol.key)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                            active
                                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 dark:border-emerald-500'
                                                : 'bg-white dark:bg-nature-950 border-nature-200 dark:border-nature-800 hover:border-nature-300'
                                        }`}
                                    >
                                        <span className="text-2xl" aria-hidden="true">{JOIN_ICONS[pol.key]}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-nature-900 dark:text-white">{t(pol.label)}</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">{t(pol.desc)}</div>
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
                        className="w-full py-3 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover disabled:opacity-50 text-bp-commit-on font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                    >
                        {submitting ? t('Creating...') : t('Create Group (You become Convenor)')}
                    </button>
                </form>
            </div>
        </div>
    );
}
