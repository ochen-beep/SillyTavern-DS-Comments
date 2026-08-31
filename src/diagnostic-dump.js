// @ts-check

/**
 * Build the shareable diagnostic export from an explicit metadata-only allowlist.
 *
 * @param {{ exportedAt?: string, runtime: unknown, restoreLog: unknown, debugLog: unknown, eventLog: unknown }} data
 */
export function buildDiagnosticDump({ exportedAt = new Date().toISOString(), runtime, restoreLog, debugLog, eventLog }) {
    return {
        probe: 'DS Comments diagnostic',
        exportedAt,
        runtime,
        restoreLog,
        debugLog,
        eventLog,
    };
}
