import { useEffect } from 'react';
import { COMMUNITY_SHAPE_CARD_WORDS, communityShapeLines, t, type CommunityShapeFeatures } from '@beanpool/core';
import { BoldWords } from './BoldWords';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    features?: CommunityShapeFeatures | null;
    onOpenGuide?: () => void;
}

export function CommunityShapeModal({ isOpen, onClose, features, onOpenGuide }: Props) {
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const lines = communityShapeLines(features);

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="community-shape-modal-title"
            data-testid="community-shape-modal"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <div className="flex items-center gap-2">
                        <span className="text-xl" aria-hidden="true">🧭</span>
                        <h2 id="community-shape-modal-title" className="font-bold text-nature-900 dark:text-white text-lg">
                            {t(COMMUNITY_SHAPE_CARD_WORDS.title)}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer text-lg font-bold p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl transition-colors"
                        aria-label={t('Close')}
                        data-testid="community-shape-close"
                    >
                        ✕
                    </button>
                </div>

                {/* Content */}
                <div className="p-5 flex flex-col gap-4">
                    {lines.map((line, idx) => (
                        <p key={idx} className="text-sm leading-relaxed text-nature-800 dark:text-nature-200 m-0">
                            <BoldWords text={line} />
                        </p>
                    ))}

                    <button
                        type="button"
                        onClick={() => {
                            onClose();
                            onOpenGuide?.();
                        }}
                        className="w-full min-h-[48px] py-3 px-4 rounded-xl border border-nature-300 dark:border-nature-700 hover:border-emerald-500 font-bold text-sm text-emerald-600 dark:text-emerald-400 bg-transparent cursor-pointer transition-colors mt-2"
                        data-testid="community-shape-read-more"
                    >
                        {t(COMMUNITY_SHAPE_CARD_WORDS.readMoreInGuide)}
                    </button>
                </div>
            </div>
        </div>
    );
}
