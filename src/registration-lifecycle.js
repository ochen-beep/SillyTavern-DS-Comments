// @ts-check
/**
 * DS Comments — Permanent SillyTavern registration lifecycle.
 * Slash commands and debug functions are registered once per page lifetime and
 * intentionally survive enable/disable cycles. This controller owns that guard
 * so runtime teardown (index.js cleanup()) never touches it.
 */

/**
 * Create a controller that registers slash commands and debug functions once
 * per page lifetime and never tears them down. Idempotent: re-calls are no-ops
 * once a command/function is registered.
 */
export function createPermanentRegistrationController({
    getContext,
    buildSlashCommand,
    debugDefinitions,
    warn,
}) {
    let slashRegistered = false;
    const registeredDebugNames = new Set();

    /** Register the slash command once. Returns true on success or if already registered. */
    function ensureSlashCommandRegistered() {
        if (slashRegistered) return true;
        try {
            const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = getContext() || {};
            if (!SlashCommandParser || !SlashCommand) return false;
            SlashCommandParser.addCommandObject(buildSlashCommand({ SlashCommand, SlashCommandArgument, ARGUMENT_TYPE }));
            slashRegistered = true;
            return true;
        } catch (cause) {
            warn('Failed to register slash commands:', cause);
            return false;
        }
    }

    /** Register any not-yet-registered debug functions. Returns true only if all succeeded. */
    function ensureDebugFunctionsRegistered() {
        const { registerDebugFunction } = getContext() || {};
        if (!registerDebugFunction) return false;
        let complete = true;
        for (const definition of debugDefinitions()) {
            if (registeredDebugNames.has(definition.id)) continue;
            try {
                registerDebugFunction(
                    definition.id,
                    definition.name,
                    definition.description,
                    definition.callback,
                );
                registeredDebugNames.add(definition.id);
            } catch (cause) {
                complete = false;
                warn(`Failed to register debug function ${definition.id}:`, cause);
            }
        }
        return complete;
    }

    return {
        ensureSlashCommandRegistered,
        ensureDebugFunctionsRegistered,
        snapshot: () => ({
            slashRegistered,
            registeredDebugNames: [...registeredDebugNames],
        }),
    };
}
