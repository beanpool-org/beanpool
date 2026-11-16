/**
 * A direct message's ⋮ menu on the web, and its read-only "Key code" (DESIGN-dm-key-signal-model §5, slice S3). The phone's
 * DM menu has "Key code" too (slice S1), where a member can mark the person as verified.
 *
 * The web keeps no record of anyone's key, so this shows the code of the key the community lists for the other person
 * (lib/dm-lock dmListedPeer: the key every line leaves this browser sealed to) and says plainly that the browser doesn't
 * remember it. It never shows "verified" as a state and writes nothing: no key, no code, no mark, anywhere.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';
import { KeyCodeBox } from './KeyCode';
import { keyCodeOf, keyCodeSpoken } from '../lib/key-code';

interface Props {
    isOpen: boolean;
    /** The other person's name as the chat shows it, or null when it isn't known (the sentences' unknown-name twins). */
    peerName: string | null;
    /** The one key this chat's listing names for the other person, or null when it names none or several. */
    peerKey: string | null;
    onClose: () => void;
}

export function DmChatMenu(props: Props): ReactNode {
    if (!props.isOpen) return null;
    return <DmChatMenuContent {...props} />;
}

const ITEM_CLASS = 'w-full text-left min-h-[44px] py-2.5 px-3 rounded-xl text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-800 border-none bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

function DmChatMenuContent({ peerName, peerKey, onClose }: Omit<Props, 'isOpen'>): ReactNode {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<'menu' | 'key-code'>('menu');
    useDialogFocus(dialogRef, onClose);
    // The item pressed goes with the step: focus moves to the new heading, never to the page behind.
    useEffect(() => {
        if (view === 'key-code') dialogRef.current?.querySelector<HTMLElement>('h2')?.focus();
    }, [view]);
    const name = peerName?.trim() || null;

    return createPortal(
        <div
            className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="dm-chat-menu-title"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl w-full max-w-xs max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-5 shadow-xl flex flex-col gap-2 outline-none"
            >
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-nature-100 dark:border-nature-800">
                    <h2 id="dm-chat-menu-title" tabIndex={-1} className="text-base font-bold text-nature-950 dark:text-white outline-none m-0 min-w-0 break-words">
                        {view === 'key-code' ? t('Key code') : t('Chat menu')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('Close menu')}
                        className="shrink-0 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center p-1 rounded-xl text-nature-400 hover:text-nature-700 dark:hover:text-white border-none bg-transparent cursor-pointer text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                        ✕
                    </button>
                </div>

                {view === 'key-code' ? (
                    <DmKeyCodeView name={name} peerKey={peerKey} />
                ) : (
                    <div className="flex flex-col gap-1 pt-1">
                        <button
                            type="button"
                            data-testid="dm-chat-menu-key-code"
                            onClick={() => setView('key-code')}
                            className={ITEM_CLASS}
                        >
                            {t('Key code')}
                        </button>
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}

/** The listed key's code, read only, with the line that says this browser doesn't remember it. */
function DmKeyCodeView({ name, peerKey }: { name: string | null; peerKey: string | null }): ReactNode {
    const code = keyCodeOf(peerKey);
    if (!code) {
        return (
            <p data-testid="dm-key-code-none" className="m-0 pt-1 text-sm text-nature-700 dark:text-nature-200 leading-relaxed">
                {t('There is no key code to show for this chat yet.')}
            </p>
        );
    }
    return (
        <div data-testid="dm-key-code" className="flex flex-col pt-1">
            <h3 className="m-0 text-sm font-bold text-nature-950 dark:text-white break-words">
                {name ? t("{name}'s key code", { name }) : t("This chat's key code")}
            </h3>
            <KeyCodeBox
                code={code}
                label={t('Key code: {code}', { code: keyCodeSpoken(code) })}
                testId="dm-key-code-digits"
            />
            <p className="m-0 mt-3 text-sm text-nature-700 dark:text-nature-200 leading-relaxed">
                {name
                    ? t("This browser doesn't remember key codes. The phone app can mark {name} as verified and ask you if the code changes.", { name })
                    : t("This browser doesn't remember key codes. The phone app can mark this person as verified and ask you if the code changes.")}
            </p>
        </div>
    );
}
