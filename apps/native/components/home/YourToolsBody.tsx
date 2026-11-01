/**
 * Your tools card body on Home (home-tools-card): the member fills it with the tools they use.
 * Each tool shows its icon, name and short state line (manifest.row(doc, now), falling back to homeCard.line),
 * and tapping it opens that tool. An "Add a tool" row lists tools not yet on the card, and each tool on the card
 * can be removed. Empty, it invites the member to add one.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { t, toolLineText } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { homeStyles } from './HomeParts';
import { phoneTools, type PhoneTool } from '../../tools/index';
import { readToolDoc, subscribeToolStore } from '../../tools/store';
import { openTool, safeLine } from '../../tools/frame';

interface Props {
    tools: readonly string[];
    owner: string | null;
    colors: AppColors;
    now: number;
    onOpenTool?: (id: string) => void;
    onChangeTools: (tools: string[]) => void;
    allTools?: readonly PhoneTool[];
}

export function YourToolsBody({
    tools,
    owner,
    colors,
    now,
    onOpenTool = openTool,
    onChangeTools,
    allTools = phoneTools(),
}: Props) {
    const s = homeStyles(colors);

    // Only tools with a Home card and a phone half in this build are offered.
    const available = useMemo(
        () => allTools.filter((t) => !!t.manifest.homeCard),
        [allTools],
    );

    // Chosen tools in order, skipping unknown tool IDs.
    const chosen = useMemo(
        () => tools.map((toolId) => available.find((t) => t.manifest.id === toolId)).filter((t): t is PhoneTool => !!t),
        [tools, available],
    );

    // Tools not yet on the card.
    const notOnCard = useMemo(
        () => available.filter((t) => !tools.includes(t.manifest.id)),
        [available, tools],
    );

    const [docs, setDocs] = useState<Record<string, unknown>>({});

    const reload = useCallback(() => {
        if (!owner) return;
        let gone = false;
        void Promise.all(
            chosen.map(async (tool) => {
                const { doc } = await readToolDoc(owner, tool.manifest).catch(() => ({ doc: tool.manifest.doc.empty() }));
                return [tool.manifest.id, doc] as const;
            }),
        ).then((pairs) => {
            if (!gone) setDocs(Object.fromEntries(pairs));
        });
        return () => { gone = true; };
    }, [owner, chosen]);

    useFocusEffect(useCallback(() => {
        return reload();
    }, [reload]));

    useEffect(() => {
        if (!owner) return;
        return subscribeToolStore((o, tId) => {
            if (o === owner || o === '*') {
                if (tId === '*' || chosen.some((m) => m.manifest.id === tId)) {
                    reload();
                }
            }
        });
    }, [owner, reload, chosen]);

    return (
        <View testID="home-tools-body">
            {chosen.length === 0 ? (
                <Text style={[s.note, { marginBottom: 8 }]} testID="home-tools-empty">
                    {t('Add a tool to keep it here.')}
                </Text>
            ) : (
                <View style={{ marginBottom: 4 }}>
                    {chosen.map((tool) => {
                        const name = t(tool.manifest.name);
                        const doc = docs[tool.manifest.id];
                        const line = doc ? safeLine(() => tool.manifest.row(doc, now)) : null;
                        const stateText = line
                            ? toolLineText(line)
                            : (tool.manifest.homeCard?.line ? t(tool.manifest.homeCard.line) : t(tool.manifest.line));

                        return (
                            <View
                                key={tool.manifest.id}
                                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}
                                testID={`home-tool-row-${tool.manifest.id}`}
                            >
                                <Pressable
                                    onPress={() => onOpenTool(tool.manifest.id)}
                                    style={({ pressed }) => [{
                                        flex: 1,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        minHeight: 48,
                                        paddingVertical: 6,
                                        gap: 12,
                                    }, pressed && { opacity: 0.7 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('{tool}, {state}', { tool: name, state: stateText })}
                                    testID={`home-tool-open-${tool.manifest.id}`}
                                >
                                    <Text style={{ fontSize: 22 }}>{tool.manifest.icon}</Text>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.heading }} numberOfLines={1}>
                                            {name}
                                        </Text>
                                        <Text style={{ fontSize: 13, color: colors.text.secondary }} numberOfLines={1}>
                                            {stateText}
                                        </Text>
                                    </View>
                                </Pressable>
                                <Pressable
                                    onPress={() => onChangeTools(tools.filter((id) => id !== tool.manifest.id))}
                                    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Remove {tool} from Your tools', { tool: name })}
                                    testID={`home-tool-remove-${tool.manifest.id}`}
                                >
                                    <Text style={{ fontSize: 16, color: colors.text.secondary, fontWeight: '600' }}>✕</Text>
                                </Pressable>
                            </View>
                        );
                    })}
                </View>
            )}
            {notOnCard.length > 0 && (
                <View
                    testID="home-tools-add-row"
                    style={{ paddingTop: 8, marginTop: 4, borderTopWidth: 1, borderTopColor: colors.border.default }}
                >
                    <Text
                        style={{
                            fontSize: 11,
                            fontWeight: '800',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5,
                            color: colors.text.secondary,
                            marginBottom: 6,
                        }}
                    >
                        {t('Add a tool')}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {notOnCard.map((tool) => {
                            const name = t(tool.manifest.name);
                            return (
                                <Pressable
                                    key={tool.manifest.id}
                                    onPress={() => onChangeTools([...tools, tool.manifest.id])}
                                    style={({ pressed }) => [{
                                        minHeight: 44,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        borderRadius: 12,
                                        borderWidth: 1,
                                        borderColor: colors.border.default,
                                        backgroundColor: colors.surface.card,
                                    }, pressed && { opacity: 0.7 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Add {tool} to Your tools', { tool: name })}
                                    testID={`home-tools-add-${tool.manifest.id}`}
                                >
                                    <Text style={{ fontSize: 16 }}>{tool.manifest.icon}</Text>
                                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text.body }}>{name}</Text>
                                    <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text.secondary }}>+</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
            )}
        </View>
    );
}
