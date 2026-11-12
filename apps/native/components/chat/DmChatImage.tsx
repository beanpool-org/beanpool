/**
 * A direct message's photo in its bubble (app/chat/[id].tsx): fetched and opened lazily, drawn 220 × 220, a tap hands the
 * picture up to be shown full screen. Moved out of the screen unchanged but for the retry below, so a test can mount it.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Image, ActivityIndicator } from 'react-native';
import { t } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import { getDecryptedAttachment, type DmKeyChange } from '../../utils/db';

/**
 * The DM screen's word for the key its chat is under (the key-change check it already runs): it changes when the key on offer
 * does, when the pause is first sight's, or when the pause lifts, and is empty while nothing is on offer. A photo opens under
 * the phone's pinned key, so a photo that couldn't open under one key is asked for again under the next.
 */
export function dmKeyContextOf(change: Pick<DmKeyChange, 'offeredPeer' | 'firstSight' | 'unplaced'> | null | undefined): string {
    return change ? [change.offeredPeer ?? '', change.firstSight ? 'first-sight' : '', change.unplaced ? 'unplaced' : ''].join('|') : '';
}

/**
 * Image bubble that lazily fetches + decrypts an encrypted attachment for display.
 * Tapping calls onOpen(uri) so the parent can show it full-screen.
 *
 * Whatever the photo opens with can arrive after the bubble's first paint: `oldLine` (the thread check showing the line old),
 * the DM's key (`keyContext`: the screen's own word for which key the chat is under now, so the bubble need not know the
 * key itself, which the open reads from the phone's pins). When any of them, or the line, changes the bubble starts over:
 * the last answer is cleared and the photo is asked for again. Only the latest attempt may answer (an earlier one that
 * comes back late is dropped), and a failure is final until one of those changes: nothing here retries on its own.
 *
 * `oldLine`: a line from before 1.4.0, shown read-only; its photo opens as part of its words
 * (conversion code, log row OLDCHAT, remove after 12 Dec 2026).
 */
export function ChatImage({ conversationId, messageId, onOpen, oldLine = false, keyContext = '' }:
    { conversationId: string; messageId: string; onOpen?: (uri: string) => void; oldLine?: boolean; keyContext?: string }) {
    const { colors } = useTheme();
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        // Each run of this effect is one attempt; its cleanup (the inputs changed, or the bubble left) ends it, and an
        // ended attempt's answer is ignored, so the latest attempt always wins.
        let latest = true;
        setUri(null);
        setFailed(false);
        getDecryptedAttachment(conversationId, messageId, oldLine)
            .then(u => { if (latest) { if (u) { setUri(u); } else { setFailed(true); } } })
            .catch(() => { if (latest) setFailed(true); });
        return () => { latest = false; };
    }, [conversationId, messageId, oldLine, keyContext]);
    if (failed) return <Text style={{ color: colors.text.muted, fontStyle: 'italic', padding: 8 }}>{t('🔒 Image unavailable')}</Text>;
    if (!uri) return <View style={{ width: 220, height: 220, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.text.muted} /></View>;
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={t('View photo full screen')} onPress={() => onOpen?.(uri)}>
            <Image accessibilityLabel={t('Photo message')} source={{ uri }} style={{ width: 220, height: 220, borderRadius: 12 }} resizeMode="cover" />
        </Pressable>
    );
}
