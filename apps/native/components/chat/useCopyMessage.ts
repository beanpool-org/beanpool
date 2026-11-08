/**
 * Copy one chat message's words to the clipboard, and say so ("Copied", for a moment).
 *
 * For every kind of chat: ChatMessageRow owns it, so a DM, a group chat, an enterprise thread and an event chat copy the
 * same way. The words are the bubble's own, as shown (never a stand-in for a line that did not open: those have no bubble).
 *
 * expo-clipboard is loaded when a member first copies, not when a chat opens: Expo's native modules do not load outside a
 * device (vitest.config.ts), and the dozen tests that render a chat row need no clipboard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { t } from '@beanpool/core';

/** How long "Copied" stays before the button goes back to "Copy message". */
export const COPIED_SHOWN_MS = 1800;

export type CopyAnswer = 'idle' | 'copied' | 'failed';

export function useCopyMessage(text: string | undefined): { answer: CopyAnswer; copy: () => Promise<void> } {
    const [answer, setAnswer] = useState<CopyAnswer>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const copy = useCallback(async () => {
        if (!text) return;
        let done = true;
        try {
            const Clipboard = await import('expo-clipboard');
            await Clipboard.setStringAsync(text);
        } catch {
            done = false;
        }
        setAnswer(done ? 'copied' : 'failed');
        // Said as well as drawn: the button's own name stays "Copy message" for a screen reader.
        AccessibilityInfo.announceForAccessibility(done ? t('Copied') : t('Could not copy'));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnswer('idle'), COPIED_SHOWN_MS);
    }, [text]);

    return { answer, copy };
}
