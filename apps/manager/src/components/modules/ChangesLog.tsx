import React from 'react';
import type { ShapeLogLine } from '../../lib/community-shape';
import { t } from '../../lib/fresh-proof';
import { coreLogWords, formatLogDate, logActorDisplay, logSettingName, logValueDisplay } from './ShapeRows';

/** The Changes log, newest first: the Core settings page's whole log, or one everyday card's own lines (`limit`). */
export function ChangesLog({ lines, limit = 50 }: { lines: ShapeLogLine[]; limit?: number }) {
    if (lines.length === 0) return <p className="text-xs text-nature-400 m-0">{t('No changes recorded yet.')}</p>;
    return (
        <div data-testid="shape-audit-log" className="space-y-2">
            {lines.slice(0, limit).map((entry) => {
                const actor = logActorDisplay(entry);
                const coreWords = coreLogWords(entry);
                const settingName = logSettingName(entry.setting);
                const fromVal = logValueDisplay(entry.setting, entry.from);
                const toVal = logValueDisplay(entry.setting, entry.to);
                return (
                    <div key={`${entry.kept}-${entry.id}`} className="text-xs text-nature-300 py-1 border-b border-nature-800/50 break-words leading-relaxed">
                        <span className="font-mono text-nature-400">{formatLogDate(entry.at)}</span>{' '}
                        ·{' '}
                        <span className="font-semibold text-white">{actor.name}</span>
                        {actor.role && <span className="text-nature-400"> ({actor.role})</span>}{' '}
                        ·{' '}
                        {coreWords ? (
                            <span className="text-white">{coreWords}</span>
                        ) : (
                            <>
                                <span className="text-white">{settingName}</span>
                                {entry.from !== null && entry.to !== null && <span>: {fromVal} → {toVal}</span>}
                            </>
                        )}
                        {entry.note && <span className="text-nature-400 italic"> · &ldquo;{entry.note}&rdquo;</span>}
                    </div>
                );
            })}
        </div>
    );
}
