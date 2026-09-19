import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, AppState, DeviceEventEmitter } from 'react-native';
import { router, usePathname } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { getConversations, getDecisions, getMarketplaceTransactions, signedGet } from '../utils/db';
import {
    buildNeedsYou, fitNeedsYou, moreLabel, needsYouRowOrder, NEEDS_YOU_SLOT,
    type NeedsYouEntry, type NeedsYouKind, type NeedsYouTarget,
} from '../utils/needs-you';

// The slot between the bean and the invite icon holds one small icon per kind of thing that needs the
// member, only while something of that kind does. No text. What counts, the order, the accent and the
// wording live in utils/needs-you.ts.

const ICON: Record<NeedsYouKind, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
    deal: 'handshake-outline',
    vote: 'vote-outline',
    message: 'message-text-outline',
    group: 'account-group-outline',
};

// Warm and readable on the vine header, which is dark in both themes. Calm: no red.
const ACCENT = palette.amber300;
const NEUTRAL = '#ffffff';
const POLL_MS = 30_000;
// A ws nudge usually means a message is on its way into the local database; the tab layout's sync
// writes it there, so read a moment later rather than immediately.
const WS_SETTLE_MS = 3_000;

function go(target: NeedsYouTarget) {
    switch (target.to) {
        case 'deal': return router.push({ pathname: '/post/[id]', params: { id: target.postId, txId: target.txId } });
        case 'my-deals': return router.push({ pathname: '/(tabs)/', params: { tab: 'deals' } });
        // Commons has no route or param for one Decision, so every vote lands on its Decide section.
        case 'decide': return router.push({ pathname: '/(tabs)/projects', params: { section: 'decide' } });
        case 'chat': return router.push(target.event
            ? { pathname: '/chat/[id]', params: { id: target.conversationId, event: '1' } }
            : { pathname: '/chat/[id]', params: { id: target.conversationId } });
        // Talk → Messages lists direct and group chats together; the Unread filter narrows it to these.
        case 'unread-messages': return router.push({ pathname: '/(tabs)/chats', params: { view: 'messages', filter: 'unread' } });
    }
}

async function load(me: string, guest: boolean): Promise<NeedsYouEntry[]> {
    const settle = <T,>(p: Promise<T>) => p.catch(() => null);
    const [transactions, decisions, conversations, yourGroups] = await Promise.all([
        settle(getMarketplaceTransactions(me)),
        // A guest has no vote here, so their list is never asked for.
        guest ? null : settle(getDecisions('open')),
        settle(getConversations(me)),
        settle(signedGet('/api/your-groups').then(r => (r.ok ? r.json() : null))),
    ]);
    return buildNeedsYou({
        me,
        now: Date.now(),
        transactions,
        decisions: decisions && { ...decisions, signed: decisions.canPropose !== null },
        conversations,
        groupChats: Array.isArray(yourGroups?.items) ? yourGroups.items : null,
    });
}

function NeedIcon({ e }: { e: NeedsYouEntry }) {
    const color = e.accent ? ACCENT : NEUTRAL;
    return (
        <Pressable onPress={() => go(e.target)} style={({ pressed }) => [s.slot, pressed && s.pressed]}
            accessibilityRole="button" accessibilityLabel={e.label}>
            <MaterialCommunityIcons name={ICON[e.kind]} size={24} color={color} style={s.iconShadow} />
            {e.count > 1 && (
                <View style={[s.countDot, { backgroundColor: e.accent ? ACCENT : 'rgba(255,255,255,0.9)' }]}>
                    <Text style={s.countText} allowFontScaling={false}>{e.count > 9 ? '9+' : e.count}</Text>
                </View>
            )}
        </Pressable>
    );
}

export function NeedsYouIcons({ guest, sheetTop }: { guest: boolean; sheetTop: number }) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const pathname = usePathname();
    const [entries, setEntries] = useState<NeedsYouEntry[]>([]);
    const [sheet, setSheet] = useState(false);
    const [width, setWidth] = useState(0);
    const busy = useRef(false);
    const again = useRef(false);
    const me = identity?.publicKey;

    const refresh = useCallback(async () => {
        if (!me) { setEntries([]); return; }
        if (busy.current) { again.current = true; return; }
        busy.current = true;
        try {
            do {
                again.current = false;
                const next = await load(me, guest);
                setEntries(next);
            } while (again.current);
        } catch { /* keep what we had */ } finally { busy.current = false; }
    }, [me, guest]);

    // On each page change (which is also every return to the tabs), every 30s while the app is active,
    // and shortly after a ws nudge.
    useEffect(() => { refresh(); }, [refresh, pathname]);
    useEffect(() => {
        let settle: ReturnType<typeof setTimeout> | null = null;
        const iv = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, POLL_MS);
        const app = AppState.addEventListener('change', st => { if (st === 'active') refresh(); });
        const ws = DeviceEventEmitter.addListener('ws_activity', () => {
            if (settle) clearTimeout(settle);
            settle = setTimeout(refresh, WS_SETTLE_MS);
        });
        return () => { clearInterval(iv); app.remove(); ws.remove(); if (settle) clearTimeout(settle); };
    }, [refresh]);

    const fit = fitNeedsYou(entries, width);
    const byKind = new Map(fit.shown.map(e => [e.kind, e]));

    return (
        <View style={s.row} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
            {needsYouRowOrder(fit).map(k => k === 'more' ? (
                <Pressable key="more" onPress={() => setSheet(true)} style={({ pressed }) => [s.slot, pressed && s.pressed]}
                    accessibilityRole="button" accessibilityLabel={moreLabel(fit.hidden)}>
                    <MaterialCommunityIcons name="dots-horizontal" size={24} color={NEUTRAL} style={s.iconShadow} />
                </Pressable>
            ) : <NeedIcon key={k} e={byKind.get(k)!} />)}

            <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)}>
                <Pressable style={s.sheetBg} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel="Close">
                    <View style={[s.sheet, { marginTop: sheetTop, backgroundColor: colors.surface.card }]}>
                        <Text style={[s.sheetTitle, { color: colors.text.secondary }]} accessibilityRole="header">Needs you</Text>
                        {entries.map(e => (
                            <Pressable key={e.kind} style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: colors.surface.subtle }]}
                                onPress={() => { setSheet(false); go(e.target); }} accessibilityRole="button" accessibilityLabel={e.label}>
                                <MaterialCommunityIcons name={ICON[e.kind]} size={22}
                                    color={e.accent ? palette.amber600 : colors.text.secondary} />
                                <Text style={[s.sheetText, { color: colors.text.heading, fontWeight: e.accent ? '700' : '500' }]} numberOfLines={2}>
                                    {e.label}
                                </Text>
                                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} />
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Modal>
        </View>
    );
}

const s = StyleSheet.create({
    // Right-aligned: the icons grow leftwards from the invite/Settings/avatar group, the gap sits by the bean.
    row: { flex: 1, minWidth: 0, height: NEEDS_YOU_SLOT, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    slot: { width: NEEDS_YOU_SLOT, height: NEEDS_YOU_SLOT, alignItems: 'center', justifyContent: 'center', borderRadius: NEEDS_YOU_SLOT / 2 },
    pressed: { backgroundColor: 'rgba(255,255,255,0.15)' },
    iconShadow: { textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
    countDot: { position: 'absolute', top: 7, right: 5, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
    countText: { color: '#1f2937', fontSize: 10, fontWeight: '900' },
    sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' },
    sheet: { width: '92%', borderRadius: 16, paddingVertical: 8, elevation: 6 },
    sheetTitle: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 8 },
    sheetText: { flex: 1, fontSize: 15 },
});
