/**
 * Backups & Restore → "Ready for the hall" (lights-out H4; scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §3.7, §5).
 *
 * A checklist for the owner who wants the community to keep going on a laptop in the hall if the internet goes: each line has
 * its date and says in amber when it needs them (lib/hall-ready.ts has every rule). Below it, the steps to pair the laptop as
 * the standby, and the way into the kit page of the operator manual.
 *
 * Owners and admins only (Settings is never shown to members; a moderator's session is turned away here too). It gates
 * nothing and it never ticks what it cannot see: a line that rests on the owner's own word says so, and one it could not read
 * says that.
 *
 * It reads only this node: the diagnostics the screen already has, two of this node's own routes, and this browser's notes.
 * No other address, font or picture, so it reads the same with the internet unplugged and Settings served by the laptop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiagnosticsResponse, OwnerWordsCheck, TakeoverStatus } from '../../lib/node-client';
import { fetchTakeoverStatus, getOwnerWordsChecks } from '../../lib/node-client';
import { nodeCredential, type NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';
import { useManual } from '../manual/Manual';
import {
    HALL_KIT_PAGE, HALL_NOTES_EVENT, apkLine, codeLine, copyLine, downloadLine, drillLine, imageLine, ownersLine, readHallNotes,
    readySummary, writeHallNote, type HallNoteKey, type ReadyLine, type ReadyState,
} from '../../lib/hall-ready';

/** The operator manual page with "A standby server": the pairing steps in full (a page that exists today). */
const STANDBY_PAGE = 'backups-and-replicas';

/** The card's own anchor: other screens can bring it into view. */
export const READY_FOR_THE_HALL_ANCHOR = 'ready-for-the-hall';

type Fetched<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; value: T };

const MARKS: Record<ReadyState, { glyph: string; word: string; mark: string; chip: string }> = {
    ok: { glyph: '✓', word: 'Ready', mark: 'text-bp-ink-success', chip: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink' },
    amber: { glyph: '!', word: 'Needs you', mark: 'text-bp-ink-warning', chip: 'bg-bp-chip-warn-tint text-bp-chip-warn-ink' },
    unknown: { glyph: '?', word: 'Cannot tell', mark: 'text-nature-300', chip: 'bg-nature-800 text-nature-200' },
};

/** The note each line lets the owner make, with the words on its button. */
const NOTE_BUTTONS: Partial<Record<ReadyLine['id'], { key: HallNoteKey; label: string }>> = {
    image: { key: 'imagePulledAt', label: 'I pulled it today' },
    drill: { key: 'drillAt', label: 'I tried it today' },
};

const BUTTON = 'min-h-[44px] px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all';
const CODE = 'font-mono text-white break-all';

function Command({ children }: { children: string }) {
    return <code className={CODE} style={{ overflowWrap: 'anywhere' }}>{children}</code>;
}

export interface ReadyForTheHallCardProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    /** Who is looking. Without one, a fleet profile's token (owner level for what a token may do). */
    viewer?: RolesViewer;
    /** A standby's Settings has its own panels; the card is the main server's. */
    isStandby?: boolean;
    /** Tests only: the clock. */
    now?: number;
}

export function ReadyForTheHallCard({ activeNode, diag, viewer = { kind: 'token' }, isStandby = false, now: nowProp }: ReadyForTheHallCardProps) {
    const manual = useManual();
    const isOwner = viewer.kind === 'token' || viewer.role === 'owner';
    const allowed = isOwner || (viewer.kind === 'key' && viewer.role === 'admin');
    const show = allowed && !isStandby;

    const [code, setCode] = useState<Fetched<TakeoverStatus>>({ status: 'loading' });
    const [owners, setOwners] = useState<Fetched<OwnerWordsCheck[]>>({ status: 'loading' });
    const [notes, setNotes] = useState(() => readHallNotes(activeNode.id));
    const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);

    const credential = nodeCredential(activeNode);
    useEffect(() => {
        if (!show) return;
        let live = true;
        setCode({ status: 'loading' });
        setOwners({ status: 'loading' });
        fetchTakeoverStatus(activeNode.url, credential)
            .then((value) => { if (live) setCode({ status: 'ok', value }); })
            .catch(() => { if (live) setCode({ status: 'error' }); });
        getOwnerWordsChecks(activeNode.url, credential)
            .then((r) => { if (live) setOwners(Array.isArray(r?.owners) ? { status: 'ok', value: r.owners } : { status: 'error' }); })
            .catch(() => { if (live) setOwners({ status: 'error' }); });
        return () => { live = false; };
    }, [show, activeNode.id, activeNode.url, credential]);

    // The owner's notes: re-read when the node changes, when this page stamps one (a download), or another tab does.
    useEffect(() => {
        setNotes(readHallNotes(activeNode.id));
        const reread = (e: Event) => {
            const id = (e as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
            if (e.type === 'storage' || id === activeNode.id) setNotes(readHallNotes(activeNode.id));
        };
        window.addEventListener(HALL_NOTES_EVENT, reread);
        window.addEventListener('storage', reread);
        return () => {
            window.removeEventListener(HALL_NOTES_EVENT, reread);
            window.removeEventListener('storage', reread);
        };
    }, [activeNode.id]);

    const note = useCallback((key: HallNoteKey, at: number | null) => setNotes(writeHallNote(activeNode.id, key, at)), [activeNode.id]);

    const now = nowProp ?? Date.now();
    const lines: ReadyLine[] = useMemo(() => {
        // Until this node has answered, a line says it is reading: never amber (a false alarm) and never ok.
        const reading = (base: ReadyLine): ReadyLine => ({ ...base, state: 'unknown', text: 'Reading from this server…', hint: undefined, rows: undefined });
        return [
            imageLine(notes, now),
            diag ? copyLine(diag.standbyHealth, isOwner, now) : reading(copyLine(null, isOwner, now)),
            code.status === 'loading' ? reading(codeLine(null)) : codeLine(code.status === 'ok' ? code.value : null),
            owners.status === 'loading' ? reading(ownersLine(null, now)) : ownersLine(owners.status === 'ok' ? owners.value : null, now),
            downloadLine(notes, now),
            diag ? apkLine(diag.apk) : reading(apkLine(null)),
            drillLine(notes, now),
        ];
    }, [notes, code, owners, diag, isOwner, now]);

    if (!show) return null;

    const { ready, total } = readySummary(lines);
    const copy = lines.find((l) => l.id === 'copy');
    const open = stepsOpen ?? copy?.state === 'amber';

    const goToReplicationAccess = () => {
        document.getElementById('replication-access-panel')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div id={READY_FOR_THE_HALL_ANCHOR} data-testid="ready-for-the-hall" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4 min-w-0">
            <div className="space-y-1 min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2 break-words">
                    <span aria-hidden="true">🏛️</span>
                    <span>Ready for the hall</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                    If the internet goes down, a laptop in the hall can keep your community going. This shows what is ready now and
                    what needs you. It only reports: nothing here is locked or blocked.
                </p>
            </div>

            <p data-testid="hall-summary" className={`text-sm font-semibold m-0 break-words ${ready === total ? 'text-bp-ink-success' : 'text-bp-ink-warning'}`}>
                {ready} of {total} ready.
            </p>

            <ul className="m-0 p-0 list-none space-y-4">
                {lines.map((line) => {
                    const m = MARKS[line.state];
                    const noteButton = NOTE_BUTTONS[line.id];
                    const noted = noteButton ? notes[noteButton.key] !== undefined : false;
                    return (
                        <li key={line.id} data-testid={`hall-line-${line.id}`} data-state={line.state} className="flex gap-3 items-start min-w-0">
                            <span aria-hidden="true" className={`shrink-0 w-5 text-center text-base font-extrabold leading-snug ${m.mark}`}>{m.glyph}</span>
                            <div className="min-w-0 flex-1 space-y-1">
                                <p className="m-0 text-sm font-semibold text-white break-words">
                                    {line.title}{' '}
                                    <span className={`inline-block align-middle text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${m.chip}`}>{m.word}</span>
                                </p>
                                <p className="m-0 text-sm text-nature-200 leading-relaxed break-words" data-testid={`hall-text-${line.id}`}>{line.text}</p>
                                {line.rows && (
                                    <ul className="m-0 pl-4 text-xs text-nature-300 space-y-0.5 break-words">
                                        {line.rows.map((r) => <li key={r}>{r}</li>)}
                                    </ul>
                                )}
                                {line.hint && <p className="m-0 text-xs text-nature-400 leading-relaxed break-words">{line.hint}</p>}
                                {noteButton && (
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        <button type="button" className={BUTTON} onClick={() => note(noteButton.key, Date.now())}>{noteButton.label}</button>
                                        {noted && <button type="button" className={BUTTON} onClick={() => note(noteButton.key, null)}>Clear my note</button>}
                                    </div>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>

            <div className="border-t border-nature-800 pt-4 space-y-3">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? 'hall-pair-steps' : undefined}
                    onClick={() => setStepsOpen(!open)}
                    className={`${BUTTON} w-full text-left flex items-center justify-between gap-2`}
                >
                    <span>Pair this laptop as the standby</span>
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                </button>
                {open && (
                    <ol id="hall-pair-steps" data-testid="hall-pair-steps" className="m-0 pl-5 text-sm text-nature-200 space-y-3 leading-relaxed break-words">
                        <li>
                            On the laptop, install Docker and get the BeanPool folder, as for any server. In its <Command>.env</Command> file
                            add <Command>NODE_ROLE=backup</Command>. Then, in that folder, run <Command>docker network create beanpool-shared</Command> (if it
                            says the network already exists, carry on), <Command>docker compose pull</Command> and then <Command>docker compose up -d</Command>.
                        </li>
                        <li>
                            Here, make a pairing code under <strong className="text-white">Replication Access</strong>, a little further down
                            this page. It is shown once.
                            <div className="pt-2"><button type="button" className={BUTTON} onClick={goToReplicationAccess}>Go to Replication Access</button></div>
                        </li>
                        <li>
                            On the laptop, in the same folder, run <Command>docker compose exec beanpool-node beanpool pair</Command> and
                            paste the code when it asks. Never type the code on the command line.
                        </li>
                        <li>
                            Within a minute the laptop starts its first copy (a large community takes longer), and the line above shows when it
                            lands. After that it copies about every minute whenever it can reach this server. Keep it plugged in and on.
                        </li>
                    </ol>
                )}
                {open && manual && (
                    <div>
                        <button type="button" className={BUTTON} onClick={() => manual.openManual(STANDBY_PAGE)}>
                            More in the manual: A standby server
                        </button>
                    </div>
                )}
                <p className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                    The kit page also covers what this list cannot see: the authenticator app on a phone that will be in the hall, every
                    member having the app, and the printed poster.
                </p>
                {manual && (
                    <button type="button" className={BUTTON} onClick={() => manual.openManual(HALL_KIT_PAGE)}>
                        Open the kit page: Before the lights go out
                    </button>
                )}
            </div>
        </div>
    );
}
