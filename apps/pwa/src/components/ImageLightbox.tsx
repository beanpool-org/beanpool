import React, { useEffect, useRef, useState, useCallback } from 'react';
import { resolveImageUrl } from '../lib/avatar';

export interface ImageLightboxProps {
    isOpen: boolean;
    photos: string[];
    initialIndex?: number;
    title?: string;
    subtitle?: string;
    onClose: () => void;
    triggerElement?: HTMLElement | null;
}

export function ImageLightbox({
    isOpen,
    photos,
    initialIndex = 0,
    title,
    subtitle,
    onClose,
    triggerElement,
}: ImageLightboxProps) {
    const validPhotos = (photos || []).filter(
        (p) => typeof p === 'string' && p.trim() !== '' && p !== 'null' && p !== 'undefined'
    );
    const count = validPhotos.length;

    const [currentIndex, setCurrentIndex] = useState(() =>
        Math.max(0, Math.min(count - 1, initialIndex))
    );
    const [imageStatus, setImageStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
    const [retryKey, setRetryKey] = useState(0);

    const dialogRef = useRef<HTMLDivElement>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    // Touch gesture tracking
    const touchStartRef = useRef<{ x: number; y: number } | null>(null);
    const touchDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    // Sync currentIndex when initialIndex or validPhotos change on open
    useEffect(() => {
        if (isOpen) {
            const clamped = Math.max(0, Math.min(count - 1, initialIndex));
            setCurrentIndex(clamped);
            setImageStatus('loading');
            setRetryKey(0);
        }
    }, [isOpen, initialIndex, count]);

    // Reset loading state when currentIndex changes
    useEffect(() => {
        if (isOpen) {
            setImageStatus('loading');
        }
    }, [currentIndex, isOpen, retryKey]);

    // Focus management & scroll lock
    useEffect(() => {
        if (!isOpen) return;

        // Remember active element to restore focus on close
        triggerRef.current = triggerElement || (document.activeElement as HTMLElement | null);

        // Focus close button initially
        const focusTimer = setTimeout(() => {
            closeBtnRef.current?.focus();
        }, 30);

        // Lock background scroll safely without layout shifts or resetting scroll position
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            clearTimeout(focusTimer);
            document.body.style.overflow = prevOverflow;
            // Restore focus safely
            if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
                triggerRef.current.focus();
            }
        };
    }, [isOpen, triggerElement]);

    const handlePrev = useCallback(() => {
        if (count <= 1) return;
        setCurrentIndex((prev) => (prev - 1 + count) % count);
    }, [count]);

    const handleNext = useCallback(() => {
        if (count <= 1) return;
        setCurrentIndex((prev) => (prev + 1) % count);
    }, [count]);

    // Keyboard navigation & focus trap
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
                return;
            }

            if (count > 1) {
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    handlePrev();
                    return;
                }
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    handleNext();
                    return;
                }
            }

            // Focus trap
            if (e.key === 'Tab') {
                const container = dialogRef.current;
                if (!container) return;

                const focusable = container.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
                );
                if (focusable.length === 0) return;

                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, count, handlePrev, handleNext, onClose]);

    // Touch event handlers for swipe
    const handleTouchStart = (e: React.TouchEvent) => {
        if (count <= 1) return;
        const touch = e.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        touchDeltaRef.current = { x: 0, y: 0 };
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (!touchStartRef.current) return;
        const touch = e.touches[0];
        touchDeltaRef.current = {
            x: touch.clientX - touchStartRef.current.x,
            y: touch.clientY - touchStartRef.current.y,
        };
    };

    const handleTouchEnd = () => {
        if (!touchStartRef.current || count <= 1) return;
        const { x, y } = touchDeltaRef.current;
        // Check horizontal swipe threshold: at least 40px and more horizontal than vertical
        if (Math.abs(x) > 40 && Math.abs(x) > Math.abs(y) * 1.3) {
            if (x < 0) {
                handleNext();
            } else {
                handlePrev();
            }
        }
        touchStartRef.current = null;
        touchDeltaRef.current = { x: 0, y: 0 };
    };

    if (!isOpen || count === 0) return null;

    const rawUrl = validPhotos[currentIndex];
    const resolvedUrl = resolveImageUrl(rawUrl);
    // Cache-bust a retry by query string — but never on a data: URI, where the payload IS
    // the URL and appending to it corrupts the base64 rather than reloading anything.
    const isDataUri = !!resolvedUrl && resolvedUrl.startsWith('data:');
    const displayUrl = resolvedUrl
        ? retryKey > 0 && !isDataUri
            ? `${resolvedUrl}${resolvedUrl.includes('?') ? '&' : '?'}retry=${retryKey}`
            : resolvedUrl
        : null;

    const altText = title
        ? `${title} - Photo ${currentIndex + 1} of ${count}`
        : `Photo ${currentIndex + 1} of ${count}`;

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={title ? `Photo viewer: ${title}` : 'Photo viewer'}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 dark:bg-black/95 backdrop-blur-sm select-none p-3 sm:p-6 transition-opacity duration-200"
            onClick={onClose}
        >
            {/* Header bar: Counter (if multiple) & Close button */}
            <div
                className="absolute top-3 left-3 right-3 sm:top-5 sm:left-5 sm:right-5 flex items-center justify-between z-20 pointer-events-none"
                style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
            >
                {/* Counter / Title badge */}
                <div className="flex items-center gap-2 pointer-events-auto">
                    {count > 1 && (
                        <div
                            className="bg-black/60 backdrop-blur-md text-white border border-white/20 rounded-full px-3 py-1 text-xs font-bold tracking-wider shadow-md"
                            aria-live="polite"
                            aria-atomic="true"
                        >
                            {currentIndex + 1} / {count}
                        </div>
                    )}
                    {title && count <= 1 && (
                        <div className="bg-black/60 backdrop-blur-md text-white border border-white/20 rounded-full px-3 py-1 text-xs font-semibold tracking-wide truncate max-w-[200px] shadow-md">
                            {title}
                        </div>
                    )}
                </div>

                {/* Close Button: prominent, min 44x44px touch target */}
                <button
                    ref={closeBtnRef}
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                    aria-label="Close photo viewer"
                    className="pointer-events-auto min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 active:scale-95 text-white border border-white/25 shadow-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="w-6 h-6"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Main Content Area (image container & swipe listener) */}
            <div
                className="relative max-w-full max-h-full flex flex-col items-center justify-center w-full h-full p-2 sm:p-4"
                onClick={(e) => e.stopPropagation()}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Loading state spinner */}
                {imageStatus === 'loading' && (
                    <div
                        role="status"
                        aria-label="Loading photo"
                        className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/90 z-10"
                    >
                        <div className="w-10 h-10 border-3 border-white/20 border-t-white rounded-full animate-spin" />
                        <span className="text-xs font-medium tracking-wide text-white/75">
                            Loading photo…
                        </span>
                    </div>
                )}

                {/* Error state fallback (never an empty black box) */}
                {(imageStatus === 'error' || !displayUrl) && (
                    <div
                        role="alert"
                        className="flex flex-col items-center justify-center p-6 text-center max-w-xs bg-nature-900/90 dark:bg-nature-950/90 rounded-2xl border border-nature-700/60 text-white shadow-2xl z-10"
                    >
                        <div className="text-4xl mb-3" aria-hidden="true">
                            📷
                        </div>
                        <h3 className="font-extrabold text-base text-white mb-1">
                            Photo failed to load
                        </h3>
                        <p className="text-xs text-white/70 mb-4 leading-relaxed">
                            The image could not be displayed or network connection is slow.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                setImageStatus('loading');
                                setRetryKey((k) => k + 1);
                            }}
                            className="min-w-[44px] min-h-[44px] px-5 py-2.5 bg-white/20 hover:bg-white/30 active:scale-95 text-white rounded-xl text-xs font-bold transition-all border border-white/20 shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                            Retry
                        </button>
                    </div>
                )}

                {/* Enlarged Image */}
                {displayUrl && (
                    <img
                        {/* currentIndex is part of the key deliberately: a post can carry the
                            same URL twice, and without it React reuses the element, the browser
                            fires no new load event for an identical src, and the spinner that
                            currentIndex just re-armed never clears. */}
                        key={`${currentIndex}-${displayUrl}-${retryKey}`}
                        src={displayUrl}
                        alt={altText}
                        onLoad={() => setImageStatus('loaded')}
                        onError={() => setImageStatus('error')}
                        className={`max-w-full max-h-[75vh] sm:max-h-[82vh] object-contain rounded-xl shadow-2xl transition-opacity duration-200 ${
                            imageStatus === 'loaded' ? 'opacity-100' : 'opacity-0 absolute'
                        }`}
                        style={{
                            // Ensure image stays centered and constrained cleanly on small screens (320dp)
                            maxWidth: '100%',
                            maxHeight: '75vh',
                        }}
                    />
                )}

                {/* Bottom title/subtitle bar (matching native MemberAvatar or Post Detail context) */}
                {(title || subtitle) && imageStatus === 'loaded' && (
                    <div className="mt-3 text-center px-4 max-w-md">
                        {title && (
                            <p className="text-sm font-bold text-white tracking-wide truncate">
                                {title}
                            </p>
                        )}
                        {subtitle && (
                            <p className="text-xs text-white/70 tracking-normal mt-0.5">
                                {subtitle}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Navigation Controls for Multiple Photos */}
            {count > 1 && (
                <>
                    {/* Previous Button (Left) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            handlePrev();
                        }}
                        aria-label="Previous photo"
                        className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 active:scale-95 text-white border border-white/25 shadow-lg transition-all z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-6 h-6"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            aria-hidden="true"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>

                    {/* Next Button (Right) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            handleNext();
                        }}
                        aria-label="Next photo"
                        className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 active:scale-95 text-white border border-white/25 shadow-lg transition-all z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-6 h-6"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            aria-hidden="true"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* Bottom Dot Indicators */}
                    <div
                        className="absolute bottom-3 sm:bottom-5 left-0 right-0 flex justify-center items-center gap-1.5 z-20 pointer-events-none"
                        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
                    >
                        <div className="bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-full flex items-center gap-1.5 pointer-events-auto border border-white/10 shadow-md">
                            {validPhotos.map((_, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setCurrentIndex(i);
                                    }}
                                    aria-label={`Go to photo ${i + 1} of ${count}`}
                                    aria-current={i === currentIndex ? 'true' : undefined}
                                    className={`transition-all duration-200 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                                        i === currentIndex
                                            ? 'w-5 h-2 bg-white'
                                            : 'w-2 h-2 bg-white/40 hover:bg-white/70'
                                    }`}
                                />
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
