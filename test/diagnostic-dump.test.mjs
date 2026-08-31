// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticDump } from '../src/diagnostic-dump.js';

test('diagnostic dump uses the metadata-only allowlist', () => {
    const payload = buildDiagnosticDump({
        exportedAt: '2026-08-19T12:00:00.000Z',
        runtime: { lastGenerationDiagnostics: { outcome: 'stored-and-rendered' } },
        restoreLog: 'restore metadata',
        debugLog: 'debug metadata',
        eventLog: 'event metadata',
        lastGeneration: {
            systemPrompt: 'SECRET SYSTEM PROMPT',
            userMessages: ['SECRET SCENE'],
            response: 'SECRET MODEL RESPONSE',
        },
    });

    assert.deepEqual(payload, {
        probe: 'DS Comments diagnostic',
        exportedAt: '2026-08-19T12:00:00.000Z',
        runtime: { lastGenerationDiagnostics: { outcome: 'stored-and-rendered' } },
        restoreLog: 'restore metadata',
        debugLog: 'debug metadata',
        eventLog: 'event metadata',
    });
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('SECRET'), 'full generation bodies are excluded');
    assert.ok(!('lastGeneration' in payload));
});
