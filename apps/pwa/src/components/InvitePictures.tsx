/**
 * The QR pictures Share sends with an invite (lib/invite-picture.ts), and the note that stands in for them where the browser
 * cannot share.
 *
 * `InvitePictureQueue` makes the pictures BEFORE anyone taps Share (Safari refuses a share that awaits first), one code at a
 * time so a long list never works the page hard: it draws the code's QR out of sight, hands it to the picture maker, keeps
 * the file, then moves to the next code. Most recent first, and no more than `LIMIT` (a code past that shares its message
 * alone, as before). It renders nothing a member sees.
 */
import { useEffect, useReducer, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { t } from '@beanpool/core';
import {
    QR_PX, composeInvitePicture, invitePictureFor, invitePictureSettled, inviteQrValue, rememberInvitePicture, saveInvitePicture,
} from '../lib/invite-picture';

const QRCodeSVGComponent = QRCodeSVG as any;

/** The most pictures made for one page; owners and admins can hold hundreds of pending codes. */
export const LIMIT = 40;

function PictureMaker({ code, onDone }: { code: string; onDone: () => void }) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let alive = true;
        const finish = (file: File | null) => {
            if (!alive) return;
            rememberInvitePicture(code, file);
            onDone();
        };
        const svg = host.current?.querySelector('svg');
        if (!svg) {
            finish(null);
            return () => { alive = false; };
        }
        void composeInvitePicture(new XMLSerializer().serializeToString(svg), code).then(finish);
        return () => { alive = false; };
    }, [code, onDone]);
    // Out of sight and out of layout: the picture is made from the QR's markup, not from what is drawn.
    return (
        <div ref={host} aria-hidden="true" style={{ display: 'none' }}>
            <QRCodeSVGComponent value={inviteQrValue(code)} size={QR_PX} />
        </div>
    );
}

export function InvitePictureQueue({ codes }: { codes: Array<string | null | undefined> }) {
    const [, next] = useReducer((n: number) => n + 1, 0);
    const wanted = codes.filter((c): c is string => Boolean(c)).slice(0, LIMIT);
    const code = wanted.find((c) => !invitePictureSettled(c));
    if (!code) return null;
    return <PictureMaker key={code} code={code} onDone={next} />;
}

/**
 * Where Share could not send the message (the browser has no share, or refused it), it was copied instead: said plainly,
 * with the picture to save. `copied` false is a copy that did not work either, said just as plainly.
 */
export function InviteCopiedNote({ code, copied }: { code: string; copied: boolean }) {
    const file = invitePictureFor(code);
    return (
        <div role="status" className="mt-3 flex flex-col items-center gap-2 text-center" data-testid="invite-copied-note">
            <p className={`m-0 text-[14px] font-bold leading-snug ${copied ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
                {copied ? t('Invite message copied') : t('Could not copy the invite message')}
            </p>
            {file && (
                <button
                    type="button"
                    onClick={() => saveInvitePicture(file)}
                    className="min-h-[44px] py-2 px-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[14px] font-bold cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-700"
                    data-testid="invite-save-picture"
                >
                    {t('Save QR picture')}
                </button>
            )}
        </div>
    );
}
