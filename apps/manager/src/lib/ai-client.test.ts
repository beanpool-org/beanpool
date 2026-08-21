import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadAiConfig, saveAiConfig, askAiCopilot, DEFAULT_AI_CONFIG, AiConfig } from './ai-client';

describe('ai-client', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('loadAiConfig', () => {
        it('returns DEFAULT_AI_CONFIG when localStorage is empty', () => {
            expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
        });

        it('returns parsed config from localStorage when present', () => {
            const customConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'test-key',
                model: 'meta-llama/llama-3-8b-instruct:free',
            };
            localStorage.setItem('bp_fleet_ai_config', JSON.stringify(customConfig));
            expect(loadAiConfig()).toEqual(customConfig);
        });

        it('returns DEFAULT_AI_CONFIG if localStorage contains invalid JSON', () => {
            localStorage.setItem('bp_fleet_ai_config', 'invalid-json');
            expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
        });
    });

    describe('saveAiConfig', () => {
        it('saves configuration to localStorage under bp_fleet_ai_config', () => {
            const newConfig: AiConfig = {
                provider: 'ollama',
                baseUrl: 'http://127.0.0.1:11434/',
                model: 'mistral:latest',
            };
            saveAiConfig(newConfig);
            expect(localStorage.getItem('bp_fleet_ai_config')).toBe(JSON.stringify(newConfig));
        });
    });

    describe('askAiCopilot', () => {
        const sampleContext = {
            telemetry: { status: 'ONLINE', dbSizeBytes: 20971520, activeWsConnections: 5, p2pActivePeers: 12 },
            gateway: { rateLimiting: { enabled: true } },
            members: [{ id: '1' }, { id: '2' }],
            logs: [{ id: 'log-1' }],
        };

        describe('ollama provider', () => {
            const ollamaConfig: AiConfig = {
                provider: 'ollama',
                baseUrl: 'http://localhost:11434/',
                model: 'llama3:latest',
            };

            it('returns response from ollama on success', async () => {
                const globalFetch = vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ response: 'All systems operational.' }),
                });
                vi.stubGlobal('fetch', globalFetch);

                const result = await askAiCopilot('Status check', sampleContext, ollamaConfig);

                expect(globalFetch).toHaveBeenCalledWith(
                    'http://localhost:11434/api/generate',
                    expect.objectContaining({
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    })
                );
                expect(result).toBe('All systems operational.');
            });

            it('returns default fallback message if ollama response lacks response property', async () => {
                vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({}),
                }));

                const result = await askAiCopilot('Status check', sampleContext, ollamaConfig);
                expect(result).toBe('No response received from Ollama.');
            });

            it('returns offline diagnostic simulation on network/HTTP error', async () => {
                vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

                const result = await askAiCopilot('Status check', sampleContext, ollamaConfig);
                expect(result).toContain('🤖 Sovereign AI Copilot Analysis (Local Diagnostic Mode)');
                expect(result).toContain('Target node status is `ONLINE`.');
                expect(result).toContain('20.00 MB.');
            });
        });

        describe('openrouter provider', () => {
            const openRouterConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'sk-or-test',
                model: 'meta-llama/llama-3-8b-instruct:free',
            };

            it('returns choices content on success', async () => {
                const globalFetch = vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        choices: [{ message: { content: 'OpenRouter diagnostic result.' } }],
                    }),
                });
                vi.stubGlobal('fetch', globalFetch);

                const result = await askAiCopilot('Analyze logs', sampleContext, openRouterConfig);

                expect(globalFetch).toHaveBeenCalledWith(
                    'https://openrouter.ai/api/v1/chat/completions',
                    expect.objectContaining({
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: 'Bearer sk-or-test',
                        },
                    })
                );
                expect(result).toBe('OpenRouter diagnostic result.');
            });

            it('returns fallback string if choices array is empty', async () => {
                vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ choices: [] }),
                }));

                const result = await askAiCopilot('Analyze logs', sampleContext, openRouterConfig);
                expect(result).toBe('No response from OpenRouter.');
            });

            it('returns error message if fetch fails or status is not ok', async () => {
                vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                    ok: false,
                    status: 401,
                    statusText: 'Unauthorized',
                }));

                const result = await askAiCopilot('Analyze logs', sampleContext, openRouterConfig);
                expect(result).toContain('❌ OpenRouter API Request Failed: OpenRouter HTTP 401: Unauthorized.');
            });
        });

        describe('unsupported provider', () => {
            it('returns unsupported provider message', async () => {
                const customConfig: AiConfig = {
                    provider: 'custom' as any,
                    baseUrl: 'http://custom-ai.internal',
                    model: 'custom-model',
                };

                const result = await askAiCopilot('Hello', {}, customConfig);
                expect(result).toBe('Selected AI Provider is not supported yet.');
            });
        });
    });
});
