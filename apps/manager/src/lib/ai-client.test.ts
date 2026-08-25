import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadAiConfig, saveAiConfig, askAiCopilot, DEFAULT_AI_CONFIG, AiConfig } from './ai-client';

describe('ai-client', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    describe('loadAiConfig', () => {
        it('returns default config when local storage is empty', () => {
            expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
        });

        it('returns saved config when present in local storage', () => {
            const customConfig: AiConfig = {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'test-key',
                model: 'gpt-4',
            };
            localStorage.setItem('bp_fleet_ai_config', JSON.stringify(customConfig));
            expect(loadAiConfig()).toEqual(customConfig);
        });

        it('returns default config when local storage contains invalid JSON', () => {
            localStorage.setItem('bp_fleet_ai_config', 'invalid json');
            expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
        });
    });

    describe('saveAiConfig', () => {
        it('saves config to local storage', () => {
            const customConfig: AiConfig = {
                provider: 'ollama',
                baseUrl: 'http://localhost:11434',
                model: 'llama3:latest',
            };
            saveAiConfig(customConfig);
            expect(localStorage.getItem('bp_fleet_ai_config')).toBe(JSON.stringify(customConfig));
        });
    });

    describe('askAiCopilot', () => {
        const mockContext = {
            telemetry: { status: 'ONLINE', dbSizeBytes: 1048576, activeWsConnections: 2, p2pActivePeers: 5 },
            gateway: { rateLimit: true },
            members: [{ id: '1' }, { id: '2' }],
            logs: ['log1', 'log2'],
        };

        it('handles successful Ollama completion', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: true,
                json: async () => ({ response: 'Ollama answer' }),
            } as Response);

            const config: AiConfig = { provider: 'ollama', baseUrl: 'http://localhost:11434/', model: 'llama3' };
            const res = await askAiCopilot('Hello', mockContext, config);

            expect(res).toBe('Ollama answer');
            expect(fetchSpy).toHaveBeenCalledWith(
                'http://localhost:11434/api/generate',
                expect.objectContaining({ method: 'POST' })
            );
        });

        it('returns diagnostic fallback if Ollama request fails', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network Error'));

            const config: AiConfig = { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3' };
            const res = await askAiCopilot('Hello', mockContext, config);

            expect(res).toContain('Sovereign AI Copilot Analysis (Local Diagnostic Mode)');
            expect(res).toContain('ONLINE');
        });

        it('handles successful OpenRouter completion', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'OpenRouter answer' } }] }),
            } as Response);

            const config: AiConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'key123', model: 'llama3' };
            const res = await askAiCopilot('Hello', mockContext, config);

            expect(res).toBe('OpenRouter answer');
        });

        it('handles OpenRouter request error', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            } as Response);

            const config: AiConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'key123', model: 'llama3' };
            const res = await askAiCopilot('Hello', mockContext, config);

            expect(res).toContain('OpenRouter API Request Failed: OpenRouter HTTP 401: Unauthorized');
        });

        it('returns unsupported message for unknown provider', async () => {
            const config = { provider: 'custom', baseUrl: '', model: '' } as AiConfig;
            const res = await askAiCopilot('Hello', mockContext, config);

            expect(res).toBe('Selected AI Provider is not supported yet.');
        });
    });
});
