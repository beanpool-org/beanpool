import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    ARCHETYPES,
    QUICK_SPARK_QUESTIONS,
    DEEP_RESONANCE_QUESTIONS,
    scoreQuiz,
    type ArchetypeKey,
    type QuizQuestion,
    type QuizResult,
} from '@beanpool/core';

interface ArchetypeQuizModalProps {
    visible: boolean;
    initialMode?: 'quick' | 'deep';
    onClose: () => void;
    onComplete: (result: QuizResult) => void | Promise<void>;
}

export function ArchetypeQuizModal({
    visible,
    initialMode = 'quick',
    onClose,
    onComplete,
}: ArchetypeQuizModalProps) {
    const [step, setStep] = useState<'intro' | 'quiz' | 'result'>('intro');
    const [mode, setMode] = useState<'quick' | 'deep'>(initialMode);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<ArchetypeKey[]>([]);
    const [result, setResult] = useState<QuizResult | null>(null);
    const [saving, setSaving] = useState(false);

    // One quiz run saves once. The result screen auto-saves the moment scoring finishes so a
    // dismissed modal never loses the answer, which means "Done" and the X button would otherwise
    // fire onComplete a SECOND time. The ref prevents duplicate writes.
    const hasSavedRef = useRef(false);

    useEffect(() => {
        if (visible) {
            setStep('intro');
            setMode(initialMode);
            setCurrentIndex(0);
            setAnswers([]);
            setResult(null);
            setSaving(false);
            hasSavedRef.current = false;
        }
    }, [visible, initialMode]);

    // Handle Escape key
    useEffect(() => {
        if (!visible) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                handleClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [visible, result]);

    const questions: QuizQuestion[] =
        mode === 'quick' ? QUICK_SPARK_QUESTIONS : DEEP_RESONANCE_QUESTIONS;
    const currentQ = questions[currentIndex];
    const totalQuestions = questions.length;
    const progress = totalQuestions > 0 ? (currentIndex + 1) / totalQuestions : 0;

    const persistResult = useCallback(async (res: QuizResult) => {
        if (hasSavedRef.current) return;
        hasSavedRef.current = true;
        try {
            await Promise.resolve(onComplete(res));
        } catch (e) {
            hasSavedRef.current = false; // let the explicit Save button retry
            console.warn('[ArchetypeQuiz] Save failed:', e);
        }
    }, [onComplete]);

    const handleSelectOption = (target: ArchetypeKey) => {
        const nextAnswers = [...answers];
        nextAnswers[currentIndex] = target;
        setAnswers(nextAnswers);

        if (currentIndex + 1 < totalQuestions) {
            setCurrentIndex(currentIndex + 1);
        } else {
            // Completed quiz!
            const finalResult = scoreQuiz(nextAnswers, mode);
            setResult(finalResult);
            setStep('result');
            void persistResult(finalResult);
        }
    };

    const handleBackQuestion = () => {
        if (currentIndex > 0) {
            setCurrentIndex(currentIndex - 1);
        } else {
            setStep('intro');
        }
    };

    const handleClose = () => {
        if (result) void persistResult(result);
        onClose();
    };

    const handleSave = async () => {
        if (!result) return;
        setSaving(true);
        try {
            await persistResult(result);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    if (!visible) return null;

    const primaryInfo = result ? ARCHETYPES[result.primary] : null;
    const secondaryInfo = result ? ARCHETYPES[result.secondary] : null;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Archetype Quiz"
            className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex justify-center items-start sm:items-center p-0 sm:p-4 animate-in fade-in duration-200"
        >
            <div className="w-full max-w-lg min-h-screen sm:min-h-0 sm:max-h-[90vh] bg-oat-50 dark:bg-nature-950 sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-nature-200 dark:border-nature-800 transition-colors">
                {/* ─── Header ─── */}
                <div className="flex items-center justify-between px-4 py-3.5 bg-white dark:bg-nature-900 border-b border-nature-200 dark:border-nature-800 shrink-0">
                    {step === 'quiz' ? (
                        <button
                            type="button"
                            aria-label="Go back to previous question"
                            onClick={handleBackQuestion}
                            className="w-9 h-9 flex items-center justify-center rounded-xl bg-transparent hover:bg-nature-100 dark:hover:bg-nature-800 text-nature-700 dark:text-nature-300 transition-colors cursor-pointer border-none"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                    ) : (
                        <div className="w-9 h-9" />
                    )}

                    <h3 className="text-base sm:text-lg font-bold text-nature-950 dark:text-white m-0 text-center flex-1 px-2 truncate">
                        {step === 'intro'
                            ? 'Discover Your Archetype'
                            : step === 'quiz'
                            ? `${mode === 'quick' ? '⚡ Quick Spark' : '🧭 Deep Resonance'}`
                            : '✨ Your Working Style'}
                    </h3>

                    <button
                        type="button"
                        aria-label="Close quiz modal"
                        onClick={handleClose}
                        className="w-9 h-9 flex items-center justify-center rounded-xl bg-transparent hover:bg-nature-100 dark:hover:bg-nature-800 text-nature-500 hover:text-nature-900 dark:text-nature-400 dark:hover:text-white transition-colors cursor-pointer border-none text-lg font-bold"
                    >
                        ✕
                    </button>
                </div>

                {/* ─── Body Content ─── */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    {step === 'intro' && (
                        <div className="flex flex-col items-center max-w-md mx-auto py-2">
                            <div className="w-20 h-20 rounded-3xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 flex items-center justify-center text-4xl mb-4 shadow-sm">
                                🌱
                            </div>

                            <h2 className="text-xl sm:text-2xl font-extrabold text-nature-950 dark:text-white text-center mb-2 tracking-tight">
                                Community Working Style
                            </h2>
                            <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 text-center leading-relaxed mb-6 px-1">
                                Every community thrives on a balance of different energies — from
                                creative visionaries and organizers to anchors and champions. Discover
                                your natural superpowers and see your collaboration synergy with neighbours.
                            </p>

                            {/* Mode Card: Quick Spark */}
                            <button
                                type="button"
                                aria-label="Quick Spark: 9 questions, approx 1 minute. A fast 60-second snapshot to discover your core community rhythm."
                                onClick={() => {
                                    setMode('quick');
                                    setCurrentIndex(0);
                                    setAnswers([]);
                                    setStep('quiz');
                                }}
                                className="w-full text-left bg-white dark:bg-nature-900 p-4 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm hover:border-emerald-500 dark:hover:border-emerald-500 transition-all cursor-pointer mb-3 group"
                            >
                                <div className="flex items-start gap-3.5">
                                    <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-2xl shrink-0">
                                        ⚡
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <span className="text-[15px] font-bold text-nature-950 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                                Quick Spark
                                            </span>
                                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 shrink-0">
                                                9 Qs • ~1 min
                                            </span>
                                        </div>
                                        <p className="text-xs text-nature-600 dark:text-nature-400 leading-normal m-0">
                                            A fast 60-second snapshot to discover your core community
                                            rhythm and start seeing synergy with others.
                                        </p>
                                    </div>
                                </div>
                            </button>

                            {/* Mode Card: Deep Resonance */}
                            <button
                                type="button"
                                aria-label="Deep Resonance: 27 questions, approx 3 minutes. Recommended for deep accuracy."
                                onClick={() => {
                                    setMode('deep');
                                    setCurrentIndex(0);
                                    setAnswers([]);
                                    setStep('quiz');
                                }}
                                className="w-full text-left bg-white dark:bg-nature-900 p-4 rounded-2xl border-2 border-emerald-500/80 dark:border-emerald-500 shadow-sm hover:border-emerald-600 transition-all cursor-pointer mb-5 group"
                            >
                                <div className="flex items-start gap-3.5">
                                    <div className="w-11 h-11 rounded-xl bg-emerald-100 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700 flex items-center justify-center text-2xl shrink-0">
                                        🧭
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <span className="text-[15px] font-bold text-nature-950 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                                Deep Resonance
                                            </span>
                                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 shrink-0">
                                                27 Qs • ~3 min
                                            </span>
                                        </div>
                                        <p className="text-xs text-nature-600 dark:text-nature-400 leading-normal m-0">
                                            Recommended for deep accuracy. Maps your primary archetype,
                                            secondary wings, and complementary collaborator pairings.
                                        </p>
                                    </div>
                                </div>
                            </button>

                            {/* Privacy Note */}
                            <div className="w-full flex items-start gap-2.5 p-3.5 rounded-2xl bg-emerald-50/60 dark:bg-nature-900/60 border border-emerald-200/80 dark:border-nature-800 text-xs text-nature-700 dark:text-nature-300 leading-relaxed">
                                <span className="text-emerald-600 dark:text-emerald-400 text-base shrink-0 leading-none mt-0.5">🛡️</span>
                                <div>
                                    <strong className="font-bold text-nature-900 dark:text-white">Privacy-First:</strong> We never
                                    display psychological type numbers or clinical labels. The app only
                                    calculates relational synergy between members.
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'quiz' && currentQ && (
                        <div className="flex flex-col max-w-md mx-auto">
                            {/* Progress Header */}
                            <div
                                role="progressbar"
                                aria-label="Quiz progress"
                                aria-valuemin={1}
                                aria-valuemax={totalQuestions}
                                aria-valuenow={currentIndex + 1}
                                className="mb-5"
                            >
                                <div className="w-full h-2 rounded-full bg-nature-200 dark:bg-nature-800 overflow-hidden mb-2">
                                    <div
                                        className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
                                        style={{ width: `${Math.round(progress * 100)}%` }}
                                    />
                                </div>
                                <div className="text-xs font-semibold text-nature-500 dark:text-nature-400 text-right">
                                    Question {currentIndex + 1} of {totalQuestions}
                                </div>
                            </div>

                            {/* Question Prompt Card */}
                            <div className="bg-white dark:bg-nature-900 p-5 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm mb-4">
                                <h4 className="text-base sm:text-lg font-bold text-nature-950 dark:text-white leading-snug m-0">
                                    {currentQ.prompt}
                                </h4>
                            </div>

                            {/* Options List */}
                            <div role="radiogroup" aria-label={currentQ.prompt} className="flex flex-col gap-2.5">
                                {currentQ.options.map((opt, idx) => {
                                    const isSelected = answers[currentIndex] === opt.target;
                                    return (
                                        <button
                                            key={idx}
                                            type="button"
                                            role="radio"
                                            aria-checked={isSelected}
                                            aria-label={opt.text}
                                            onClick={() => handleSelectOption(opt.target)}
                                            className={`w-full flex items-center gap-3 p-4 rounded-2xl border text-left transition-all cursor-pointer shadow-sm ${
                                                isSelected
                                                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-emerald-950 dark:text-emerald-200 font-bold ring-2 ring-emerald-500/20'
                                                    : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-800 dark:text-nature-200 hover:border-emerald-300 dark:hover:border-nature-700'
                                            }`}
                                        >
                                            {opt.emoji && (
                                                <span className="text-2xl shrink-0 leading-none" aria-hidden="true">
                                                    {opt.emoji}
                                                </span>
                                            )}
                                            <span className="flex-1 text-sm sm:text-base leading-normal">
                                                {opt.text}
                                            </span>
                                            {isSelected && (
                                                <span className="text-emerald-600 dark:text-emerald-400 font-bold text-lg shrink-0">
                                                    ✓
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {step === 'result' && result && primaryInfo && (
                        <div className="flex flex-col max-w-md mx-auto space-y-4">
                            {/* Primary Hero Card */}
                            <div className="bg-white dark:bg-nature-900 p-6 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm text-center flex flex-col items-center">
                                <span className="text-5xl mb-2 select-none" aria-hidden="true">
                                    {primaryInfo.emoji}
                                </span>
                                <h3 className="text-2xl font-black text-nature-950 dark:text-white m-0 tracking-tight">
                                    {primaryInfo.name}
                                </h3>
                                <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-1 mb-3">
                                    {primaryInfo.tagline}
                                </div>
                                <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-300 leading-relaxed m-0 text-center">
                                    {primaryInfo.description}
                                </p>

                                {secondaryInfo && (
                                    <div className="mt-4 px-3.5 py-1.5 rounded-full bg-oat-100 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-xs font-semibold text-nature-800 dark:text-nature-200">
                                        Secondary Rhythm: {secondaryInfo.emoji} {secondaryInfo.name}
                                    </div>
                                )}
                            </div>

                            {/* Superpowers */}
                            <div className="bg-white dark:bg-nature-900 p-5 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm">
                                <h4 className="text-sm font-bold text-nature-950 dark:text-white uppercase tracking-wider mb-3">
                                    🌟 Your Community Superpowers
                                </h4>
                                <ul className="space-y-2 m-0 p-0 list-none">
                                    {primaryInfo.superpowers.map((power, i) => (
                                        <li key={i} className="flex items-start gap-2.5 text-xs sm:text-sm text-nature-700 dark:text-nature-300 leading-normal">
                                            <span className="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">•</span>
                                            <span>{power}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            {/* Ideal Collaborators */}
                            <div className="bg-white dark:bg-nature-900 p-5 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm">
                                <h4 className="text-sm font-bold text-nature-950 dark:text-white uppercase tracking-wider mb-1">
                                    👥 Ideal Collaborator Pairings
                                </h4>
                                <p className="text-xs text-nature-500 dark:text-nature-400 mb-3 leading-normal">
                                    You naturally build high synergy when collaborating on projects or deals with:
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {primaryInfo.idealPartners.map((partnerKey) => {
                                        const p = ARCHETYPES[partnerKey];
                                        if (!p) return null;
                                        return (
                                            <div
                                                key={partnerKey}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-oat-100 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-xs font-bold text-nature-900 dark:text-white"
                                            >
                                                <span>{p.emoji}</span>
                                                <span>{p.name}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="pt-2 flex flex-col gap-2.5">
                                <button
                                    type="button"
                                    aria-label={saving ? "Saving archetype to profile" : "Done · Save to Profile"}
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="w-full py-3.5 px-4 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white shadow-md transition-all cursor-pointer text-sm sm:text-base border-none flex items-center justify-center gap-2"
                                >
                                    {saving ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            <span>Saving...</span>
                                        </>
                                    ) : (
                                        'Done · Save to Profile'
                                    )}
                                </button>

                                {mode === 'quick' && (
                                    <button
                                        type="button"
                                        aria-label="Deepen with 27 Questions, approx 3 minutes"
                                        onClick={() => {
                                            setMode('deep');
                                            setCurrentIndex(0);
                                            setAnswers([]);
                                            setStep('quiz');
                                        }}
                                        className="w-full py-3 px-4 rounded-xl font-bold bg-transparent hover:bg-nature-100 dark:hover:bg-nature-800 text-emerald-600 dark:text-emerald-400 transition-all cursor-pointer text-xs sm:text-sm border border-emerald-300 dark:border-emerald-800"
                                    >
                                        🧭 Deepen with 27 Questions (~3 min)
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
