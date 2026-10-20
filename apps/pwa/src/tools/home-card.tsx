/**
 * A tool's card on Home, on the web (scratch/tools/DESIGN-tool-template-fable.md §1.2, §1.3, slice T0.3): the default
 * branch of Home's switch (pages/HomePage.tsx). Its type is `tool-<id>` (core's `toolHomeCardTypes`, `asks: 'none'`), so
 * the node is never asked and builds nothing: the lines are the tool's manifest's `homeCard.lines()` on its own document,
 * read from this browser's store, at most two, each opening the tool at the screen it names. A tool with nothing to say
 * yet shows one line that opens it. The tool's chunk is not loaded for this: the manifest is core's.
 *
 * Which types are a tool's card is tools/cards.ts, which lib/home-layout.ts `HOME_DRAWN` is built from too: a tool's card
 * is drawn only for a tool with both a Home card and a web half.
 */
import { useCallback, useEffect, useState } from 'react';
import { TOOLS, TOOL_LIMITS, t, type ToolLine, type ToolManifest } from '@beanpool/core';
import { HomeCard, HomeLine } from '../components/HomeCard';
import { TOOL_APPS } from './index';
import { toolOfCard } from './cards';
import { readDoc } from './builder';
import { toolTarget } from './route';
import { readToolRecord, subscribeToolStore } from './store';

interface Props {
    id: string;
    title: string;
    menu?: Parameters<typeof HomeCard>[0]['menu'];
    style?: React.CSSProperties;
    type: string;
    publicKey: string | null;
    now: number;
    onNavigate: (tab: string, contextId?: string) => void;
    tools?: readonly ToolManifest[];
    apps?: Readonly<Record<string, unknown>>;
}

export function ToolHomeCard({ id, title, menu, style, type, publicKey, now, onNavigate, tools = TOOLS, apps = TOOL_APPS }: Props) {
    const tool = toolOfCard(type, tools, apps);
    const [lines, setLines] = useState<ToolLine[] | null>(null);
    const toolId = tool?.id;

    const readLines = useCallback(() => {
        if (!tool?.homeCard || !publicKey) return;
        readToolRecord(publicKey, tool.id).then((rec) => {
            const doc = readDoc(tool, rec?.body ?? null);
            let out: ToolLine[];
            try { out = tool.homeCard!.lines(doc, now).slice(0, TOOL_LIMITS.homeLines); } catch { out = []; }
            setLines(out);
        });
    }, [tool, publicKey, now]);

    useEffect(() => {
        readLines();
        if (!publicKey || !toolId) return;
        return subscribeToolStore((owner, t) => {
            if ((owner === publicKey || owner === '*') && (t === toolId || t === '*')) {
                readLines();
            }
        });
    }, [toolId, publicKey, readLines]);
    if (!tool) return null;
    const open = (screen?: string) => onNavigate('tool', toolTarget(tool.id, screen && tool.screens.includes(screen) ? screen : 'main'));
    return (
        <HomeCard id={id} title={title} menu={menu} style={style}>
            {lines && lines.length > 0
                ? lines.map((l, i) => (
                    <HomeLine key={i} onClick={() => open(l.screen)} testId={`home-tool-line-${i}`}>
                        <span aria-hidden="true" className="shrink-0">{tool.icon}</span>
                        <span className="min-w-0 break-words">{t(l.key, l.values)}</span>
                    </HomeLine>
                ))
                : (
                    <HomeLine onClick={() => open()} testId="home-tool-open">
                        <span aria-hidden="true" className="shrink-0">{tool.icon}</span>
                        <span className="min-w-0 break-words">{t('Open {tool}', { tool: t(tool.name) })}</span>
                    </HomeLine>
                )}
        </HomeCard>
    );
}
