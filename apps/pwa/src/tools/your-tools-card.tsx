/**
 * A Your tools card on Home, on the web (home-tools-card): the member fills it with the tools they use.
 * Each tool shows its icon, name and short state line (manifest.row(doc, now), falling back to homeCard.line),
 * and tapping it opens that tool. An "Add a tool" row lists tools not yet on the card, and each tool on the card
 * can be removed. Empty, it invites the member to add one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TOOLS, t, toolLineText, type ToolLine, type ToolManifest } from '@beanpool/core';
import { HomeCard } from '../components/HomeCard';
import { TOOL_APPS } from './index';
import { readDoc } from './builder';
import { toolTarget } from './route';
import { readToolRecord, subscribeToolStore } from './store';

interface Props {
    id: string;
    title: string;
    menu?: Parameters<typeof HomeCard>[0]['menu'];
    style?: React.CSSProperties;
    tools: readonly string[];
    publicKey: string | null;
    now: number;
    onNavigate: (tab: string, contextId?: string) => void;
    onChangeTools: (tools: string[]) => void;
    allTools?: readonly ToolManifest[];
    apps?: Readonly<Record<string, unknown>>;
}

export function YourToolsCard({
    id,
    title,
    menu,
    style,
    tools,
    publicKey,
    now,
    onNavigate,
    onChangeTools,
    allTools = TOOLS,
    apps = TOOL_APPS,
}: Props) {
    // Only tools with a Home card and a web half in this build are offered.
    const available = useMemo(
        () => allTools.filter((m) => !!m.homeCard && !!apps[m.id]),
        [allTools, apps],
    );

    // Chosen tools in order, skipping unknown tool IDs.
    const chosen = useMemo(
        () => tools.map((toolId) => available.find((m) => m.id === toolId)).filter((m): m is ToolManifest => !!m),
        [tools, available],
    );

    // Tools not yet on the card.
    const notOnCard = useMemo(
        () => available.filter((m) => !tools.includes(m.id)),
        [available, tools],
    );

    const [docs, setDocs] = useState<Record<string, unknown>>({});

    const reload = useCallback(() => {
        if (!publicKey) return;
        let cancelled = false;
        Promise.all(
            chosen.map(async (tool) => {
                try {
                    const rec = await readToolRecord(publicKey, tool.id);
                    const doc = readDoc(tool, rec?.body ?? null);
                    return [tool.id, doc] as const;
                } catch {
                    return [tool.id, tool.doc.empty()] as const;
                }
            }),
        ).then((entries) => {
            if (!cancelled) setDocs(Object.fromEntries(entries));
        });
        return () => { cancelled = true; };
    }, [publicKey, chosen]);

    useEffect(() => {
        const cancel = reload();
        if (!publicKey) return cancel;
        const unsub = subscribeToolStore((owner, tId) => {
            if (owner === publicKey || owner === '*') {
                if (tId === '*' || chosen.some((m) => m.id === tId)) {
                    reload();
                }
            }
        });
        return () => {
            cancel?.();
            unsub();
        };
    }, [publicKey, reload, chosen]);

    return (
        <HomeCard id={id} title={title} menu={menu} style={style}>
            {chosen.length === 0 ? (
                <p data-testid="home-tools-empty" className="m-0 mb-3 text-sm text-text-secondary">
                    {t('Add a tool to keep it here.')}
                </p>
            ) : (
                <div className="space-y-1 mb-2">
                    {chosen.map((tool) => {
                        const name = t(tool.name);
                        const doc = docs[tool.id];
                        let line: ToolLine | null = null;
                        if (doc !== undefined) {
                            try { line = tool.row(doc, now); } catch { line = null; }
                        }
                        const stateText = line ? toolLineText(line) : (tool.homeCard?.line ? t(tool.homeCard.line) : t(tool.line));

                        return (
                            <div
                                key={tool.id}
                                data-testid={`home-tool-row-${tool.id}`}
                                className="w-full min-h-[44px] flex items-center justify-between gap-2 py-1 px-2 rounded-lg hover:bg-bg-hover min-w-0"
                            >
                                <button
                                    type="button"
                                    onClick={() => onNavigate('tool', toolTarget(tool.id))}
                                    aria-label={t('{tool} · {state}', { tool: name, state: stateText })}
                                    data-testid={`home-tool-open-${tool.id}`}
                                    className="flex-1 min-w-0 flex items-center gap-3 text-left bg-transparent border-0 cursor-pointer p-0 text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                                >
                                    <span aria-hidden="true" className="shrink-0 text-xl">{tool.icon}</span>
                                    <span className="flex-1 min-w-0 break-words">
                                        <span className="block font-semibold text-sm text-text-primary">{name}</span>
                                        <span className="block text-xs text-text-secondary">{stateText}</span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onChangeTools(tools.filter((tId) => tId !== tool.id))}
                                    aria-label={t('Remove {tool} from Your tools', { tool: name })}
                                    data-testid={`home-tool-remove-${tool.id}`}
                                    className="min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded-lg bg-transparent border-0 text-text-secondary hover:text-text-primary text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                >
                                    <span aria-hidden="true">✕</span>
                                    <span className="sr-only">{t('Remove')}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
            {notOnCard.length > 0 && (
                <div data-testid="home-tools-add-row" className="pt-2 border-t border-border-secondary">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">
                            {t('Add a tool')}
                        </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {notOnCard.map((tool) => {
                            const name = t(tool.name);
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    data-testid={`home-tools-add-${tool.id}`}
                                    onClick={() => onChangeTools([...tools, tool.id])}
                                    aria-label={t('Add {tool} to Your tools', { tool: name })}
                                    className="min-h-[44px] px-3 py-1.5 flex items-center gap-2 rounded-xl border border-border-primary bg-bg-card hover:bg-bg-hover text-sm font-semibold text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-w-0"
                                >
                                    <span aria-hidden="true" className="text-lg shrink-0">{tool.icon}</span>
                                    <span className="min-w-0 break-words">{name}</span>
                                    <span aria-hidden="true" className="text-text-secondary font-bold shrink-0">+</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </HomeCard>
    );
}
