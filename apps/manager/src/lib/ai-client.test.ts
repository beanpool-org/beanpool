import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    DEFAULT_AI_CONFIG,
    loadAiConfig,
    saveAiConfig,
    askAiCopilot,
    type AiConfig,
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
        it('returns DEFAULT_AI_CONFIG when localStorage is empty', () => {
            const config = loadAiConfig();
            expect(config).toEqual(DEFAULT_AI_CONFIG);
        });

        it('saves and loads config from localStorage', () => {
            const customConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'test-key-123',
                model: 'anthropic/claude-3-haiku',
            };

            saveAiConfig(customConfig);
            const loaded = loadAiConfig();
            expect(loaded).toEqual(customConfig);
        });

        it('returns DEFAULT_AI_CONFIG if stored config is invalid JSON', () => {
            localStorage.setItem('bp_fleet_ai_config', 'invalid-json{');
            const config = loadAiConfig();
            expect(config).toEqual(DEFAULT_AI_CONFIG);
        });
    });

    describe('askAiCopilot', () => {
        const mockContext = {
            telemetry: { status: 'ONLINE', dbSizeBytes: 10485760, activeWsConnections: 3, p2pActivePeers: 5 },
            gateway: { rateLimiting: { enabled: true } },
            members: [{ id: 'm1' }, { id: 'm2' }],
            logs: [{ message: 'log 1' }],
        };

        describe('ollama provider', () => {
            it('returns response from Ollama server on successful fetch', async () => {
                const mockFetch = vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ response: 'All systems operational.' }),
                });
                vi.stubGlobal('fetch', mockFetch);

                const config: AiConfig = {
                    provider: 'ollama',
                    baseUrl: 'http://localhost:11434/',
                    model: 'llama3:latest',
                };

                const result = await askAiCopilot('How is the node doing?', mockContext, config);

                expect(result).toBe('All systems operational.');
                expect(mockFetch).toHaveBeenCalledWith(
                    'http://localhost:11434/api/generate',
                    expect.objectContaining({
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    })
                );
            });

            it('returns local diagnostic fallback response when Ollama server is unreachable', async () => {
                const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
                vi.stubGlobal('fetch', mockFetch);

                const config: AiConfig = {
                    provider: 'ollama',
                    baseUrl: 'http://localhost:11434',
                    model: 'llama3:latest',
                };

                const result = await askAiCopilot('Check telemetry', mockContext, config);

                expect(result).toContain('Local Diagnostic Mode');
                expect(result).toContain('ONLINE');
                expect(result).toContain('10.00 MB');
            });
        });

        describe('openrouter provider', () => {
            it('returns response content on successful OpenRouter API call', async () => {
                const mockFetch = vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                        choices: [{ message: { content: 'OpenRouter diagnostic analysis.' } }],
                    }),
                });
                vi.stubGlobal('fetch', mockFetch);

                const config: AiConfig = {
                    provider: 'openrouter',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    apiKey: 'sk-or-test-key',
                    model: 'meta-llama/llama-3-8b-instruct:free',
                };

                const result = await askAiCopilot('Analyze logs', mockContext, config);

                expect(result).toBe('OpenRouter diagnostic analysis.');
                expect(mockFetch).toHaveBeenCalledWith(
                    'https://openrouter.ai/api/v1/chat/completions',
                    expect.objectContaining({
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer sk-or-test-key',
                        },
                    })
                );
            });

            it('returns error message when OpenRouter API call fails', async () => {
                const mockFetch = vi.fn().mockResolvedValue({
                    ok: false,
                    status: 401,
                    statusText: 'Unauthorized',
                });
                vi.stubGlobal('fetch', mockFetch);

                const config: AiConfig = {
                    provider: 'openrouter',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    apiKey: 'bad-key',
                    model: 'meta-llama/llama-3-8b-instruct:free',
                };

                const result = await askAiCopilot('Analyze logs', mockContext, config);

                expect(result).toContain('OpenRouter API Request Failed');
                expect(result).toContain('401');
            });
        });

        describe('unsupported provider', () => {
            it('returns unsupported provider message', async () => {
                const config = {
                    provider: 'unknown-provider' as any,
                    baseUrl: 'http://localhost',
                    model: 'custom',
                };

                const result = await askAiCopilot('Hello', mockContext, config);

                expect(result).toBe('Selected AI Provider is not supported yet.');
            });
        });
    });
});
