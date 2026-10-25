/**
 * Chat menu sheet / modal for group chats (parity with phone's ChatMenuSheet).
 *
 * Offers:
 * - Invite people (for convenors)
 * - Mute notifications (opens duration choices: 8h, 1w, always) / Unmute (when muted)
 * - Search this chat
 * - Group info
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';
import { MUTE_CHOICES } from '../lib/chat-mute';

interface Props {
    isOpen: boolean;
    muteOpen: boolean;
    isMuted: boolean;
    isConvenor: boolean;
    onClose: () => void;
    onOpenMute: () => void;
    onPickMute: (duration: '8h' | '1w' | 'always' | 'off') => void;
    onSearch: () => void;
    onGroupInfo: () => void;
    onInvite?: () => void;
}

export function ChatMenuModal(props: Props): ReactNode {
    if (!props.isOpen) return null;
    return <ChatMenuModalContent {...props} />;
}

function ChatMenuModalContent({
    muteOpen,
    isMuted,
    isConvenor,
    onClose,
    onOpenMute,
    onPickMute,
    onSearch,
    onGroupInfo,
    onInvite,
}: Omit<Props, 'isOpen'>): ReactNode {
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialogFocus(dialogRef, onClose);

    return createPortal(
        <div
            className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="chat-menu-title"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl w-full max-w-xs p-4 sm:p-5 shadow-xl flex flex-col gap-2 outline-none"
            >
                <div className="flex items-center justify-between pb-2 border-b border-nature-100 dark:border-nature-800">
                    <h2 id="chat-menu-title" tabIndex={-1} className="text-base font-bold text-nature-950 dark:text-white outline-none m-0">
                        {muteOpen ? t('Mute notifications') : t('Chat menu')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('Close menu')}
                        className="min-w-[40px] min-h-[40px] flex items-center justify-center p-1 rounded-lg text-nature-400 hover:text-nature-700 dark:hover:text-white border-none bg-transparent cursor-pointer text-base"
                    >
                        ✕
                    </button>
                </div>

                {muteOpen ? (
                    <div className="flex flex-col gap-1 pt-1">
                        {MUTE_CHOICES.map((c) => (
                            <button
                                key={c.key}
                                type="button"
                                onClick={() => onPickMute(c.key)}
                                className="w-full text-left py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                {t(c.label)}
                            </button>
                        ))}
                        <p className="m-0 pt-2 text-xs text-nature-500 dark:text-nature-400 text-center">
                            {t('@mentions still reach you.')}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1 pt-1">
                        {isConvenor && onInvite && (
                            <button
                                type="button"
                                onClick={() => { onClose(); onInvite(); }}
                                className="w-full text-left py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                {t('Invite people')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                if (isMuted) {
                                    onPickMute('off');
                                } else {
                                    onOpenMute();
                                }
                            }}
                            className="w-full text-left py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {isMuted ? t('Unmute') : t('Mute notifications')}
                        </button>
                        <button
                            type="button"
                            onClick={() => { onClose(); onSearch(); }}
                            className="w-full text-left py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Search this chat')}
                        </button>
                        <button
                            type="button"
                            onClick={() => { onClose(); onGroupInfo(); }}
                            className="w-full text-left py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Group info')}
                        </button>
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}
