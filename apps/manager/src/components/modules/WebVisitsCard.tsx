import React, { useEffect, useMemo, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { fetchWebVisits, getTfaSessionToken, type WebVisitDay } from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';

/**
 * Web app visits a day, as the node counts them itself (no cookies, no addresses kept; server engine/web-visits.ts):
 * today's number, and the last 30 days as a sparkline with a readout and a table.
 *
 * A stat tile, not a chart: one series, so no legend (the heading names it). The trend line is the de-emphasis hue
 * (nature-400) and today, the current period, the accent (terra-500): the only shades of either that the manager's
 * palette defines at those steps. The line and its wash are drawn in an SVG stretched to the width; the dots and the
 * crosshair are HTML placed by percentage, so they stay round at any width. Hover, a tap or the arrow keys put a day in
 * the readout under it; otherwise the readout gives the 30 days' total (today's own numbers are the tile's).
 */

const DAYS = 30;

/** 'YYYY-MM-DD' (UTC) as "Tue 29 Sep". */
function dayLabel(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return day;
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// The sparkline's drawing box: the SVG stretches it to the card's width.
const W = 300;
const H = 56;
const PAD = 5;

function Sparkline({ series, selected, onSelect }: {
    series: WebVisitDay[];
    selected: number | null;
    onSelect: (i: number | null) => void;
}) {
    const n = series.length;
    const max = Math.max(1, ...series.map((d) => d.visits));
    const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
    const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
    const line = series.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.visits).toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    const pct = (i: number) => ({ left: `${(x(i) / W) * 100}%`, top: `${(y(series[i].visits) / H) * 100}%` });
    const last = n - 1;

    const fromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
        onSelect(Math.min(last, Math.max(0, i)));
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const at = selected ?? last;
        const next = e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowRight' ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
        if (next === null) return;
        e.preventDefault();
        onSelect(Math.min(last, Math.max(0, next)));
    };

    return (
        <div
            data-testid="web-visits-sparkline"
            role="group"
            tabIndex={0}
            aria-label={`Visits a day for the last ${n} days. Use the left and right arrow keys to read a day.`}
            className="relative w-full h-14 cursor-crosshair touch-pan-y rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-terra-500"
            onPointerMove={fromPointer}
            onPointerDown={fromPointer}
            onPointerLeave={() => onSelect(null)}
            onKeyDown={onKeyDown}
            onBlur={() => onSelect(null)}
        >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden="true">
                <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} className="stroke-nature-800" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <path d={area} className="fill-nature-400/10" />
                <path d={line} fill="none" className="stroke-nature-400" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {selected !== null && (
                <>
                    <span aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-nature-600 -translate-x-1/2 pointer-events-none" style={{ left: pct(selected).left }} />
                    {selected !== last && (
                        <span aria-hidden="true" className="absolute w-2.5 h-2.5 rounded-full bg-nature-300 ring-2 ring-nature-950 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={pct(selected)} />
                    )}
                </>
            )}
            <span data-testid="web-visits-today-dot" aria-hidden="true" className="absolute w-2.5 h-2.5 rounded-full bg-terra-500 ring-2 ring-nature-950 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={pct(last)} />
        </div>
    );
}

export function WebVisitsCard({ node }: { node: NodeProfile }) {
    const [series, setSeries] = useState<WebVisitDay[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Cleared first, so one node's numbers never show under another's name while the next loads.
        setSeries(null);
        setError(null);
        setSelected(null);
        fetchWebVisits(node.url, nodeCredential(node), DAYS, getTfaSessionToken(node.id))
            .then((res) => { if (!cancelled) setSeries(Array.isArray(res?.series) ? res.series : []); })
            .catch((e) => { if (!cancelled) setError(e?.message || 'Could not reach this node'); });
        return () => { cancelled = true; };
    }, [node.id, node.url, nodeCredential(node)]);

    const view = useMemo(() => {
        if (!series || series.length === 0) return null;
        const total = series.reduce((sum, d) => sum + d.visits, 0);
        return { total, today: series[series.length - 1] };
    }, [series]);

    // The day being read (hover, tap, arrow keys), or none: then the readout gives the window's total instead.
    const shown = series && selected !== null ? series[selected] : null;
    const isToday = series !== null && selected === series.length - 1;

    return (
        <section
            data-testid="web-visits-card"
            aria-labelledby="web-visits-title"
            className="bg-nature-900/60 border border-nature-800 rounded-2xl p-5 shadow-lg"
            style={{ overflowWrap: 'anywhere' }}
        >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3">
                <h3 id="web-visits-title" className="text-xs font-bold uppercase tracking-wider text-nature-400 m-0 flex items-center gap-2">
                    <span aria-hidden="true">📈</span>
                    <span>Web app visits</span>
                </h3>
                <span className="text-xs text-nature-400">Last {DAYS} days · days in UTC</span>
            </div>

            {error ? (
                <p role="alert" className="text-sm text-amber-300 m-0">{error}</p>
            ) : !series ? (
                <p className="text-sm text-nature-400 m-0">Counting…</p>
            ) : !view || view.total === 0 ? (
                <p data-testid="web-visits-empty" className="text-sm text-nature-300 m-0">
                    No visits counted yet. Each time someone opens the web app on this server, it counts here.
                </p>
            ) : (
                <>
                    <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
                        <div className="min-w-0">
                            <div className="text-xs font-bold text-nature-400 uppercase tracking-wider">Today</div>
                            <div data-testid="web-visits-today" className="text-3xl font-black text-white leading-tight">
                                {view.today.visits.toLocaleString()}
                            </div>
                            <div className="text-xs text-nature-300">
                                {view.today.visits === 1 ? 'visit' : 'visits'} · {count(view.today.uniques, 'visitor', 'visitors')}
                            </div>
                        </div>
                        <div className="flex-1 min-w-[10rem]">
                            <Sparkline series={series} selected={selected} onSelect={setSelected} />
                        </div>
                    </div>
                    <p data-testid="web-visits-readout" aria-live="polite" className="text-xs text-nature-300 m-0 mt-2">
                        {shown ? (
                            <>
                                <strong className="text-white">{count(shown.visits, 'visit', 'visits')}</strong>
                                {' · '}{count(shown.uniques, 'visitor', 'visitors')}
                                <span className="text-nature-400"> — {isToday ? 'today' : dayLabel(shown.day)}</span>
                            </>
                        ) : (
                            <>
                                <strong className="text-white">{count(view.total, 'visit', 'visits')}</strong> in {DAYS} days
                                <span className="text-nature-400"> — point at the line to read a day</span>
                            </>
                        )}
                    </p>
                    <details className="mt-2">
                        <summary className="text-xs font-bold text-nature-300 cursor-pointer min-h-[44px] flex items-center">
                            Show the {DAYS} days as a table
                        </summary>
                        <table className="w-full text-xs text-nature-300 mt-1">
                            <thead>
                                <tr className="text-nature-400 text-left">
                                    <th scope="col" className="font-bold py-1 pr-2">Day (UTC)</th>
                                    <th scope="col" className="font-bold py-1 pr-2 text-right">Visits</th>
                                    <th scope="col" className="font-bold py-1 text-right">Visitors</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...series].reverse().map((d) => (
                                    <tr key={d.day} className="border-t border-nature-800">
                                        <td className="py-1 pr-2">{dayLabel(d.day)}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{d.visits.toLocaleString()}</td>
                                        <td className="py-1 text-right tabular-nums">{d.uniques.toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </details>
                </>
            )}

            <p className="text-xs text-nature-400 m-0 mt-3">
                Counted by this server when someone opens the web app: no cookies, and no internet address or browser is
                kept. Visitors is an estimate.
            </p>
        </section>
    );
}
