import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    DEFAULT_AI_CONFIG,
    loadAiConfig,
    saveAiConfig,
    askAiCopilot,
    AiConfig,
} from './ai-client';

describe('ai-client', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('loadAiConfig & saveAiConfig', () => {
        it('should return DEFAULT_AI_CONFIG when localStorage is empty', () => {
            const config = loadAiConfig();
            expect(config).toEqual(DEFAULT_AI_CONFIG);
        });

        it('should return DEFAULT_AI_CONFIG when localStorage contains invalid JSON', () => {
            localStorage.setItem('bp_fleet_ai_config', 'invalid-json-{');
            const config = loadAiConfig();
            expect(config).toEqual(DEFAULT_AI_CONFIG);
        });

        it('should save and load custom AI configuration correctly', () => {
            const customConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'sk-test-key',
                model: 'meta-llama/llama-3-8b-instruct:free',
            };

            saveAiConfig(customConfig);
            const loaded = loadAiConfig();
            expect(loaded).toEqual(customConfig);
        });
    });

    describe('askAiCopilot', () => {
        const mockContext = {
            telemetry: { status: 'ONLINE', dbSizeBytes: 10485760, activeWsConnections: 2, p2pActivePeers: 5 },
            gateway: { features: { messaging: true } },
            members: [{ id: '1' }, { id: '2' }],
            logs: [{ message: 'Log 1' }],
        };

        it('should return response from Ollama on successful fetch', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: 'Ollama diagnostic response' }),
            });
            vi.stubGlobal('fetch', mockFetch);

            const ollamaConfig: AiConfig = {
                provider: 'ollama',
                baseUrl: 'http://localhost:11434/',
                model: 'llama3:latest',
            };

            const result = await askAiCopilot('What is the status?', mockContext, ollamaConfig);

            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:11434/api/generate',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                })
            );
            expect(result).toBe('Ollama diagnostic response');
        });

        it('should return default fallback message when Ollama returns empty response', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({}),
            });
            vi.stubGlobal('fetch', mockFetch);

            const result = await askAiCopilot('Status', mockContext, DEFAULT_AI_CONFIG);
            expect(result).toBe('No response received from Ollama.');
        });

        it('should return fallback diagnostic analysis when Ollama fetch fails', async () => {
            const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
            vi.stubGlobal('fetch', mockFetch);

            const result = await askAiCopilot('Status check', mockContext, DEFAULT_AI_CONFIG);

            expect(result).toContain('Sovereign AI Copilot Analysis (Local Diagnostic Mode)');
            expect(result).toContain('Target node status is `ONLINE`');
            expect(result).toContain('10.00 MB');
            expect(result).toContain('2 active WebSocket streams, 5 P2P peers');
        });

        it('should return response from OpenRouter on successful fetch', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'OpenRouter AI response' } }],
                }),
            });
            vi.stubGlobal('fetch', mockFetch);

            const openRouterConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'test-api-key',
                model: 'meta-llama/llama-3-8b-instruct:free',
            };

            const result = await askAiCopilot('Hello OpenRouter', mockContext, openRouterConfig);

            expect(mockFetch).toHaveBeenCalledWith(
                'https://openrouter.ai/api/v1/chat/completions',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer test-api-key',
                    },
                })
            );
            expect(result).toBe('OpenRouter AI response');
        });

        it('should handle OpenRouter fetch error gracefully', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            });
            vi.stubGlobal('fetch', mockFetch);

            const openRouterConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'invalid-key',
                model: 'meta-llama/llama-3-8b-instruct:free',
            };

            const result = await askAiCopilot('Hello', mockContext, openRouterConfig);
            expect(result).toContain('OpenRouter API Request Failed: OpenRouter HTTP 401: Unauthorized');
        });

        it('should return unsupported provider message for unknown providers', async () => {
            const customConfig = {
                provider: 'custom' as any,
                baseUrl: 'http://custom-ai.local',
                model: 'custom-model',
            };

            const result = await askAiCopilot('Hello', mockContext, customConfig);
            expect(result).toBe('Selected AI Provider is not supported yet.');
        });
    });
});
