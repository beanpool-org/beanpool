/**
 * Settings → Chat memory (DESIGN-dm-peer-key-pin §3.4 amendment 6 §3): one row per community on this phone, each
 * with its own reset of who this phone remembers its chats there are with. The reset asks first, in place, with the
 * design's sentence word for word: a chat paused because its key changed may open with the new key after it. Only the
 * member resets (db.ts resetDmChatMemory); the phone never does on its own.
 */
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import { t } from '@beanpool/core';
import { CHAT_MEMORY_COPY, chatMemoryConfirmTitle, chatMemoryDoneLine, chatMemoryResetLabel, chatMemoryStyleSpec } from '../utils/chat-memory';

export interface ChatMemoryCommunity { url: string; name: string }

export function ChatMemoryCard({ communities, onReset }: { communities: ChatMemoryCommunity[]; onReset: (url: string) => Promise<unknown> }) {
    const styles = useStyles(({ colors }) => chatMemoryStyleSpec(colors));
    const [asking, setAsking] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<{ url: string; ok: boolean } | null>(null);
    const reset = async (url: string) => {
        setBusy(true);
        try {
            await onReset(url);
            setOutcome({ url, ok: true });
        } catch {
            setOutcome({ url, ok: false });
        } finally {
            setBusy(false);
            setAsking(null);
        }
    };
    return (
        <View>
            <Text style={styles.body}>{t(CHAT_MEMORY_COPY.body)}</Text>
            {communities.length === 0 ? <Text style={styles.doneLine}>{t(CHAT_MEMORY_COPY.none)}</Text> : null}
            {communities.map((c) => (
                <View key={c.url} style={styles.row}>
                    <Text style={styles.name}>{c.name}</Text>
                    {asking === c.url ? (
                        <View style={styles.confirmBox}>
                            <Text style={styles.confirmTitle} accessibilityRole="header">{chatMemoryConfirmTitle(c.name)}</Text>
                            <Text style={styles.confirmText}>{t(CHAT_MEMORY_COPY.confirm)}</Text>
                            <Pressable style={styles.confirmBtn} onPress={() => { void reset(c.url); }} disabled={busy} accessibilityRole="button" accessibilityLabel={chatMemoryResetLabel(c.name)}>
                                <Text style={styles.confirmBtnText}>{t(CHAT_MEMORY_COPY.reset)}</Text>
                            </Pressable>
                            <Pressable style={styles.cancelBtn} onPress={() => setAsking(null)} disabled={busy} accessibilityRole="button">
                                <Text style={styles.cancelText}>{t(CHAT_MEMORY_COPY.cancel)}</Text>
                            </Pressable>
                        </View>
                    ) : (
                        <Pressable style={styles.resetBtn} onPress={() => { setOutcome(null); setAsking(c.url); }} accessibilityRole="button" accessibilityLabel={chatMemoryResetLabel(c.name)}>
                            <Text style={styles.resetText}>{t(CHAT_MEMORY_COPY.reset)}</Text>
                        </Pressable>
                    )}
                    {outcome?.url === c.url ? (
                        <Text style={outcome.ok ? styles.doneLine : styles.failedLine} accessibilityLiveRegion="polite">
                            {outcome.ok ? chatMemoryDoneLine(c.name) : t(CHAT_MEMORY_COPY.failed)}
                        </Text>
                    ) : null}
                </View>
            ))}
        </View>
    );
}
