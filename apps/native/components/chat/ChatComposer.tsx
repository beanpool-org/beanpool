/**
 * The message box, tuned for Android, now shared by every chat.
 *
 * Everything in here was paid for in field reports on the DM screen (2026-07-18) and must not be softened:
 *
 *  - The text that gets SENT comes from a ref written synchronously in onChangeText, never from state.
 *    State reaches the press handler through a render closure, and renders commit late whenever the JS
 *    thread is busy — reading state at press time sent a stale prefix of the box ("Go test your core
 *    business" went out as "Go test your", on two devices).
 *  - The box is UNCONTROLLED. A controlled value re-rendered on every keystroke and fought the IME.
 *  - JS owns the height: Android's multiline TextInput grows on keystrokes but never shrinks after a
 *    programmatic clear until the next real keystroke, so the box stayed tall after a send.
 *  - `inputRef.clear()` can be silently DROPPED (Android's ReactEditText skips stale-counted updates), so
 *    a clear sweep re-clears — but only on positive evidence that the residue is a dropped-clear echo.
 *    See scheduleClearSweep for the three designs that failed before this one.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../app/ThemeContext';
import { CHAT_INPUT_MAX_HEIGHT, CHAT_INPUT_MIN_HEIGHT, CHAT_INPUT_V_PADDING, type ChatStyles } from './styles';

export interface ChatComposerHandle {
    /** Put text in the box and in both mirrors — the way an Edit fills it. */
    setText: (text: string) => void;
    /** Empty the box, both mirrors and the height. */
    reset: () => void;
    focus: () => void;
    /** What would be sent right now, trimmed. */
    currentText: () => string;
}

interface Props {
    styles: ChatStyles;
    /** Called with the box's text. The box is already cleared; throw and the screen tells the member. */
    onSend: (text: string) => void | Promise<void>;
    placeholder: string;
    accessibilityLabel: string;
    /** The DM's photo button; nothing in a node-readable chat, where the node refuses images. */
    leading?: React.ReactNode;
    /** The honest line about who can read this chat, above the box. */
    notice?: string | null;
    /** A spinner on the send button while the node is being waited on (node-readable chats). */
    busy?: boolean;
    disabled?: boolean;
    maxLength?: number;
    bottomPadding: number;
}

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
    { styles, onSend, placeholder, accessibilityLabel, leading, notice, busy, disabled, maxLength, bottomPadding }, ref,
) {
    const { colors } = useTheme();
    const inputRef = useRef<TextInput>(null);
    const [draft, setDraft] = useState('');
    const [inputHeight, setInputHeight] = useState(CHAT_INPUT_MIN_HEIGHT);
    const sendingRef = useRef(false);

    // Mirror of the native input's text for SEND LOGIC — see the note at the top of this file.
    const draftRef = useRef('');
    // Counts draft writes so the clear sweep can tell a dropped-clear echo (one write carrying the full
    // sent text) from the member re-typing the same text (one write per keystroke).
    const draftWritesRef = useRef(0);
    const updateDraft = (text: string) => {
        draftWritesRef.current += 1;
        draftRef.current = text;
        setDraft(text);
    };

    const resetInputBox = () => {
        updateDraft('');
        inputRef.current?.clear();
        setInputHeight(CHAT_INPUT_MIN_HEIGHT);
    };

    // Field history (2026-07-18, keep for context — three designs failed before this):
    //  v1.1.79  no sweep: stuck box + dead button.
    //  v1.1.80  sweep gated on OBSERVING the pending event drain back within 600ms: never fired — the drain
    //           can take seconds under JS-thread blocks.
    //  v1.1.81  added unconditional rungs: rescued the stuck box but acted BLINDLY while the member typed
    //           the next message before their keystrokes drained — squishing the growing box ("glitching").
    //
    // Current design: act only on POSITIVE EVIDENCE. A dropped clear always leaves its rejected-count event
    // in flight, and in-flight events always drain eventually — so wait for the drain: when the residue
    // equals the just-sent text and it arrived as EXACTLY ONE write (the echo signature; human re-typing is
    // one write per keystroke), re-clear — that retry carries a current event count and sticks. Rungs spread
    // to 6s to outlast multi-second JS blocks (2.4s observed).
    const clearSweepTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const scheduleClearSweep = (sentText: string) => {
        if (!sentText) return;
        const writesBaseline = draftWritesRef.current;
        clearSweepTimersRef.current.forEach(clearTimeout);
        clearSweepTimersRef.current = [400, 1200, 3000, 6000].map(ms => setTimeout(() => {
            if (draftWritesRef.current - writesBaseline === 1 && draftRef.current.trim() === sentText) {
                console.log(`[Chat] clear sweep: re-clearing dropped-clear residue at ${ms}ms`);
                resetInputBox();
            }
        }, ms));
    };
    useEffect(() => () => clearSweepTimersRef.current.forEach(clearTimeout), []);

    useImperativeHandle(ref, () => ({
        setText: (text: string) => {
            updateDraft(text);
            // Uncontrolled input: push the text into the native field explicitly. The height follows from
            // the native onContentSizeChange the assignment triggers.
            inputRef.current?.setNativeProps({ text });
        },
        reset: () => {
            const prior = draftRef.current.trim();
            resetInputBox();
            scheduleClearSweep(prior);
        },
        focus: () => inputRef.current?.focus(),
        currentText: () => draftRef.current.trim(),
    }));

    const handleSend = async () => {
        // Guard and payload both come from draftRef, never `draft` state. Guarding on state made the button
        // silently swallow presses whenever state lagged the box (the "chat locked up" report).
        const text = draftRef.current.trim();
        if (!text || disabled || sendingRef.current) return;
        sendingRef.current = true;
        try {
            resetInputBox();
            scheduleClearSweep(text);
            await onSend(text);
        } finally {
            sendingRef.current = false;
        }
    };

    const canSend = draft.trim().length > 0 && !disabled && !busy;

    return (
        <View>
            {!!notice && <Text style={styles.composerNotice}>{notice}</Text>}
            <View style={[styles.inputContainer, { paddingBottom: bottomPadding }]}>
                {leading}
                <TextInput
                    ref={inputRef}
                    accessibilityLabel={accessibilityLabel}
                    style={[styles.input, { height: inputHeight }]}
                    onContentSizeChange={e => setInputHeight(Math.min(CHAT_INPUT_MAX_HEIGHT,
                        Math.max(CHAT_INPUT_MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height) + CHAT_INPUT_V_PADDING)))}
                    placeholder={placeholder}
                    placeholderTextColor={colors.text.muted}
                    onChangeText={updateDraft}
                    editable={!disabled}
                    maxLength={maxLength}
                    multiline
                    submitBehavior="newline"
                />
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Send message"
                    accessibilityState={{ disabled: !canSend, busy: !!busy }}
                    style={[styles.sendBtn, canSend ? styles.sendBtnActive : styles.sendBtnInactive]}
                    onPress={handleSend}
                >
                    {busy
                        ? <ActivityIndicator size="small" color={colors.text.inverse} />
                        : <MaterialCommunityIcons name="send" size={20} color={canSend ? colors.text.inverse : colors.text.muted} />}
                </Pressable>
            </View>
        </View>
    );
});
