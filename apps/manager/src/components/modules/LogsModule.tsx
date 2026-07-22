import React, { useState } from 'react';

interface LogsModuleProps {
    logs: any[];
    onRefresh: () => void;
}

export function LogsModule({ logs, onRefresh }: LogsModuleProps) {
    const [levelFilter, setLevelFilter] = useState<string>('ALL');
    const [searchQuery, setSearchQuery] = useState<string>('');

    const filteredLogs = logs.filter((log: any) => {
        if (levelFilter !== 'ALL' && (log.level || 'INFO').toUpperCase() !== levelFilter) {
            return false;
        }
        if (searchQuery) {
            const msg = (log.message || JSON.stringify(log)).toLowerCase();
            if (!msg.includes(searchQuery.toLowerCase())) return false;
        }
        return true;
    });

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-white m-0">📜 Real-Time Node Logs Streamer</h3>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Filterable system diagnostic and event log stream from the target node database.
                    </p>
                </div>
                <button
                    onClick={onRefresh}
                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center gap-2 active:scale-95"
                >
                    <span>🔄</span>
                    <span>Refresh Stream</span>
                </button>
            </div>

            {/* Filter controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-nature-950/60 p-4 rounded-xl border border-nature-800 text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-nature-400 font-semibold">Log Level:</span>
                    <select
                        value={levelFilter}
                        onChange={(e) => setLevelFilter(e.target.value)}
                        className="bg-nature-900 border border-nature-800 px-3 py-1.5 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-terra-500 cursor-pointer"
                    >
                        <option value="ALL">ALL LEVELS</option>
                        <option value="INFO">INFO</option>
                        <option value="WARN">WARN</option>
                        <option value="ERROR">ERROR</option>
                        <option value="DEBUG">DEBUG</option>
                    </select>
                </div>

                <div className="flex items-center gap-2 flex-1 max-w-xs">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search log messages..."
                        className="w-full bg-nature-900 border border-nature-800 px-3 py-1.5 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-terra-500 shadow-inner"
                    />
                </div>
            </div>

            {/* Stream Console */}
            <div className="h-96 bg-nature-950 border border-nature-800 rounded-xl p-4 font-mono text-xs overflow-y-auto space-y-2 text-nature-300 shadow-inner custom-scrollbar">
                {filteredLogs.length > 0 ? (
                    filteredLogs.map((log: any, idx: number) => {
                        const level = (log.level || 'INFO').toUpperCase();
                        const colorClass =
                            level === 'ERROR'
                                ? 'text-red-400 bg-red-950/40 border-red-900/50'
                                : level === 'WARN'
                                ? 'text-amber-400 bg-amber-950/40 border-amber-900/50'
                                : 'text-emerald-400 bg-emerald-950/40 border-emerald-900/50';

                        return (
                            <div key={idx} className="flex items-start gap-3 p-2 bg-nature-900/40 rounded-lg border border-nature-800/40 hover:bg-nature-900/70 transition-colors">
                                <span className="text-nature-500 shrink-0 text-[11px]">
                                    {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'NOW'}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 border ${colorClass}`}>
                                    {level}
                                </span>
                                <span className="text-nature-200 break-all leading-relaxed">{log.message || JSON.stringify(log)}</span>
                            </div>
                        );
                    })
                ) : (
                    <div className="p-8 text-center text-nature-500 italic">
                        No log records match current filters.
                    </div>
                )}
            </div>
        </div>
    );
}
