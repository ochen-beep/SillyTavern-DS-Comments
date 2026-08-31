// @ts-check
/**
 * DS Comments — slash command builder.
 *
 * ST 1.18.0 has NO `subcommands` support: SlashCommandParser executes
 * `executor.command.callback(args, value)` directly (SlashCommandClosure.js)
 * and fromProps is a plain Object.assign with no validation, so a parent
 * command registered only with `subcommands` throws a TypeError on every
 * input. The command is therefore FLAT — /dscomments <toggle|regenerate|clear>
 * — dispatched on the first unnamed argument. The user-facing syntax is
 * unchanged versus the old (broken) subcommand form.
 */

import { tr } from './core.js';

/**
 * Build the flat /dscomments command.
 *
 * @param {{ SlashCommand: object, SlashCommandArgument?: object|null, ARGUMENT_TYPE?: object|null }} st
 *     Slash command surfaces from getContext(); the argument surface is
 *     optional so registration still succeeds on older builds.
 * @param {{
 *     toggle: () => string | Promise<string>,
 *     regenerate: () => string | Promise<string>,
 *     clear: () => string | Promise<string>,
 * }} handlers action bodies owned by index.js (they close over generator/cache state)
 * @returns {object} the command object for SlashCommandParser.addCommandObject
 */
export function buildDscommentsCommand(st, handlers) {
    const { SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = st || {};
    const actions = {
        toggle: handlers.toggle,
        regenerate: handlers.regenerate,
        clear: handlers.clear,
    };
    /** @type {Record<string, unknown>} */
    const props = {
        name: 'dscomments',
        helpString: tr('/dscomments <toggle|regenerate|clear> — enable/disable DS Comments, regenerate commentary, or clear saved commentary', 'dscomments.command.helpMain'),
        returns: 'a status message',
        callback: (_namedArguments, unnamedArguments) => {
            const action = String(unnamedArguments ?? '').trim().toLowerCase() || 'toggle';
            const fn = actions[action];
            if (!fn) {
                return tr('Unknown action "{a}". Use toggle, regenerate or clear.', 'dscomments.command.unknownAction')
                    .split('{a}').join(action);
            }
            return fn();
        },
    };
    if (SlashCommandArgument && ARGUMENT_TYPE) {
        props.unnamedArgumentList = [SlashCommandArgument.fromProps({
            description: 'toggle | regenerate | clear',
            typeList: ARGUMENT_TYPE.STRING,
            defaultValue: 'toggle',
            enumList: ['toggle', 'regenerate', 'clear'],
        })];
    }
    return SlashCommand.fromProps(props);
}
