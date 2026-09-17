import { useState, useEffect, useRef } from 'react';
import { reportAbuse } from '../lib/api';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    reporterPubkey: string;
    targetPubkey: string;
    targetName: string;
    targetPostId?: string;
    onReported?: () => void;
}

const REPORT_REASONS = [
    'Spam or scam',
    'Offensive content',
    'Misleading post',
    'Other',
];

export function ReportModal({
    isOpen,
    onClose,
    reporterPubkey,
    targetPubkey,
    targetName,
    targetPostId,
    onReported,
}: Props) {
    const [selectedReason, setSelectedReason] = useState(REPORT_REASONS[0]);
    const [details, setDetails] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const modalCardRef = useRef<HTMLDivElement>(null);

    // Reset draft state and errors cleanly whenever modal opens, and establish focus
    useEffect(() => {
        if (isOpen) {
            setSelectedReason(REPORT_REASONS[0]);
            setDetails('');
            setSubmitting(false);
            setError(null);
            const timer = setTimeout(() => {
                modalCardRef.current?.focus();
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [isOpen]);

    // Handle Escape key to dismiss
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !submitting) {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, submitting, onClose]);

    if (!isOpen) return null;

    async function handleSubmit() {
        if (!selectedReason || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const finalReason = details.trim()
                ? `${selectedReason}: ${details.trim()}`
                : selectedReason;

            await reportAbuse(reporterPubkey, targetPubkey, finalReason, targetPostId);
            alert('Report submitted. Thank you for helping keep the community safe.');
            onReported?.();
            onClose();
        } catch (e: any) {
            setError(e?.message || 'Failed to submit report. Please try again.');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        >
            <div
                ref={modalCardRef}
                tabIndex={-1}
                className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl w-full max-w-md p-5 sm:p-6 shadow-xl flex flex-col gap-4 outline-none"
            >
                <div className="flex items-center justify-between border-b border-nature-100 dark:border-nature-800 pb-3">
                    <h3 id="report-modal-title" className="text-base font-bold text-nature-950 dark:text-white flex items-center gap-2">
                        <span aria-hidden="true">🚩</span> Report {targetName}
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        aria-label="Close report dialog"
                        className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center text-nature-400 hover:text-nature-700 dark:hover:text-white bg-transparent border-none text-lg cursor-pointer p-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-600 dark:text-red-400 font-medium">
                        {error}
                    </div>
                )}

                <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2">
                        Select reason
                    </label>
                    <div className="flex flex-wrap gap-2">
                        {REPORT_REASONS.map(reason => {
                            const isSelected = selectedReason === reason;
                            return (
                                <button
                                    key={reason}
                                    type="button"
                                    aria-pressed={isSelected}
                                    onClick={() => setSelectedReason(reason)}
                                    className={`min-h-[44px] px-3.5 py-2 rounded-full text-xs font-bold cursor-pointer transition-all border flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                                        isSelected
                                            ? 'bg-red-600 text-white border-red-600 shadow-sm'
                                            : 'bg-nature-50 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-nature-200 dark:border-nature-700 hover:bg-nature-100 dark:hover:bg-nature-700'
                                    }`}
                                >
                                    {isSelected ? '✓ ' : ''}{reason}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div>
                    <label htmlFor="report-details" className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2">
                        Additional details (optional)
                    </label>
                    <textarea
                        id="report-details"
                        rows={3}
                        value={details}
                        onChange={e => setDetails(e.target.value)}
                        placeholder="Provide any additional context or comments for moderators..."
                        disabled={submitting}
                        className="w-full p-3 rounded-xl bg-nature-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 text-xs font-medium text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
                    />
                </div>

                <div className="flex gap-2 pt-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl font-bold text-xs bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-200 dark:hover:bg-nature-700 border-none cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-400"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={submitting || !selectedReason}
                        className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl font-bold text-xs bg-red-600 text-white hover:bg-red-500 disabled:opacity-60 border-none cursor-pointer shadow-sm transition-all flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                        {submitting ? 'Sending…' : 'Submit Report'}
                    </button>
                </div>
            </div>
        </div>
    );
}
