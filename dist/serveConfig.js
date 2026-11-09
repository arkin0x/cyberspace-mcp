// serveConfig.ts: the settings of `cyberspace-mcp serve` and its waker, from
// the flags and from the "serve" and "wake" keys of config.json (arkinox,
// 2026-10-13: "package the Waker and everything else that we need so that
// people can have an XOR-like experience"). Flags win over the file, the
// file over the defaults, as in config.ts. The agent's own settings (caps,
// relays, operator) stay in config.ts; this file adds only what a long-lived
// server and its waker need: the port, the bearer token, and the commands
// that start a model turn.
import { homedir } from 'node:os';
import { join } from 'node:path';
/** The port `serve` listens on, on 127.0.0.1 only. */
export const DEFAULT_PORT = 7777;
/** The MCP path on that port. */
export const MCP_PATH = '/mcp';
/** The state directory when none is named: $CYBERSPACE_MCP_STATE, else ~/.cyberspace-mcp. */
export function defaultStateDir(env = process.env) {
    const fromEnv = env.CYBERSPACE_MCP_STATE?.trim();
    return fromEnv ? expandHome(fromEnv) : join(homedir(), '.cyberspace-mcp');
}
/**
 * A path with a leading ~ or ~/ read as the home directory, the one
 * convenience a shell would add. MCP clients (Claude Desktop, OpenClaw)
 * start a stdio server with its arguments as written, without a shell, so
 * "--state ~/agent" would otherwise make a folder named ~ in whatever
 * directory the client started in. ~\ counts as ~/ (a Windows config).
 * ~user is left as it is.
 */
export function expandHome(path, home = homedir()) {
    if (path === '~')
        return home;
    return path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path;
}
/** The URL a client connects to. */
export function mcpUrl(port) {
    return `http://127.0.0.1:${port}${MCP_PATH}`;
}
export const WAKE_DEFAULTS = {
    pollSeconds: 20,
    idleKillMinutes: 10,
    maxTurnMinutes: 60,
    chatStrangerMinutes: 5,
    roamRewakeMinutes: 5,
    ordersRewakeMinutes: 10,
    followSettleSeconds: 12,
    maxContinuations: 12,
    continueDelaySeconds: 30,
    maxIdleTurns: 2,
    maxJobTurns: 12,
    resumeDelaySeconds: 60,
};
/** The placeholder a wake command carries where the prompt goes. */
export const PROMPT_PLACEHOLDER = '{prompt}';
/**
 * Split a command line into words the way a POSIX shell would quote them,
 * without a shell: single quotes keep everything, double quotes keep
 * everything but \" \\ \$ and \`, a backslash outside quotes keeps the next
 * character. Nothing is expanded or run; a leading ~/ in a word is the home
 * directory, the one convenience a shell would add here. The words are
 * handed to spawn as argv, so a prompt is always exactly one argument and
 * can never be read as shell syntax (arkinox, 2026-10-13).
 */
export function splitCommand(line) {
    const out = [];
    let cur = '';
    let has = false;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === "'") {
            if (c === "'")
                quote = null;
            else
                cur += c;
            continue;
        }
        if (quote === '"') {
            if (c === '"')
                quote = null;
            else if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]))
                cur += line[++i];
            else
                cur += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            has = true;
            continue;
        }
        if (c === '\\' && i + 1 < line.length) {
            cur += line[++i];
            has = true;
            continue;
        }
        if (/\s/.test(c)) {
            if (has) {
                out.push(cur);
                cur = '';
                has = false;
            }
            continue;
        }
        cur += c;
        has = true;
    }
    if (quote)
        throw new Error(`the command has an unclosed ${quote} quote`);
    if (has)
        out.push(cur);
    return out.map((w) => expandHome(w));
}
/** A wake command as argv: from a string (split as above) or an array of strings. Throws a sentence when it is unusable. */
export function commandArgv(where, value) {
    let argv;
    if (typeof value === 'string')
        argv = splitCommand(value);
    else if (Array.isArray(value) && value.every((w) => typeof w === 'string'))
        argv = [...value];
    else
        throw new Error(`${where} must be a command line (a string) or an array of strings`);
    if (argv.length === 0)
        throw new Error(`${where} is empty`);
    if (!argv.some((w) => w.includes(PROMPT_PLACEHOLDER))) {
        throw new Error(`${where} must contain ${PROMPT_PLACEHOLDER} where the prompt goes, for example: claude -p ${PROMPT_PLACEHOLDER} ...`);
    }
    return argv;
}
/** The argv of one turn: the placeholder replaced in each word, the prompt one argument however it reads. */
export function fillPrompt(argv, prompt) {
    return argv.map((w) => w.split(PROMPT_PLACEHOLDER).join(prompt));
}
function positive(flag, value) {
    if (value === undefined)
        throw new Error(`${flag} needs a value`);
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        throw new Error(`${flag} must be a positive number; got ${JSON.stringify(value)}`);
    return n;
}
/** A port; 0 asks the system for a free one (the tests). */
function port(flag, value) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error(`${flag} must be a port number, 1 to 65535`);
    return n;
}
/**
 * Take the flags that belong to serve and its waker out of argv, and leave
 * the rest for config.ts's parseArgs, so the agent's own flags mean the
 * same in both modes.
 */
export function splitServeArgs(argv) {
    const serve = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--port':
                serve.port = port(a, next());
                break;
            case '--token':
                serve.token = true;
                break;
            case '--no-token':
                serve.token = false;
                break;
            case '--no-wake':
                serve.noWake = true;
                break;
            case '--wake-command':
                serve.wakeCommand = next();
                if (!serve.wakeCommand)
                    throw new Error('--wake-command needs a command line');
                break;
            case '--reply-command':
                serve.replyCommand = next();
                if (!serve.replyCommand)
                    throw new Error('--reply-command needs a command line');
                break;
            case '--poll-seconds':
                serve.pollSeconds = positive(a, next());
                break;
            case '--idle-kill-minutes':
                serve.idleKillMinutes = positive(a, next());
                break;
            case '--max-turn-minutes':
                serve.maxTurnMinutes = positive(a, next());
                break;
            case '--chat-stranger-minutes':
                serve.chatStrangerMinutes = positive(a, next());
                break;
            case '--roam-rewake-minutes':
                serve.roamRewakeMinutes = positive(a, next());
                break;
            default: rest.push(a);
        }
    }
    return { serve, rest };
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const countOf = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
/** wake.activityPaths: a path or a list of paths; a leading ~/ is the home directory. Throws a sentence when it is unusable. */
export function activityPathsOf(value) {
    if (value === undefined || value === null || value === '')
        return [];
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && p.trim() !== '')) {
        throw new Error('config.json wake.activityPaths must be a path or an array of paths');
    }
    return list.map((p) => expandHome(p));
}
/** serve's settings: defaults, then config.json, then the flags. A wake command that is there and unusable stops serve with a sentence. */
export function serveSettingsFrom(args, file) {
    const s = obj(file.serve);
    const w = obj(file.wake);
    const portSetting = args.port ?? (s.port !== undefined ? port('config.json serve.port', s.port) : DEFAULT_PORT);
    const token = args.token ?? s.token === true;
    const commandRaw = args.wakeCommand ?? w.command;
    if (args.noWake || commandRaw === undefined || commandRaw === null || commandRaw === '')
        return { port: portSetting, token, wake: null };
    const command = commandArgv(args.wakeCommand !== undefined ? '--wake-command' : 'config.json wake.command', commandRaw);
    const replyRaw = args.replyCommand ?? w.replyCommand;
    const replyCommand = replyRaw === undefined || replyRaw === null || replyRaw === '' ? null : commandArgv(args.replyCommand !== undefined ? '--reply-command' : 'config.json wake.replyCommand', replyRaw);
    return {
        port: portSetting,
        token,
        wake: {
            command,
            replyCommand,
            pollSeconds: args.pollSeconds ?? posNum(w.pollSeconds) ?? WAKE_DEFAULTS.pollSeconds,
            idleKillMinutes: args.idleKillMinutes ?? posNum(w.idleKillMinutes) ?? WAKE_DEFAULTS.idleKillMinutes,
            maxTurnMinutes: args.maxTurnMinutes ?? posNum(w.maxTurnMinutes) ?? WAKE_DEFAULTS.maxTurnMinutes,
            chatStrangerMinutes: args.chatStrangerMinutes ?? posNum(w.chatStrangerMinutes) ?? WAKE_DEFAULTS.chatStrangerMinutes,
            roamRewakeMinutes: args.roamRewakeMinutes ?? posNum(w.roamRewakeMinutes) ?? WAKE_DEFAULTS.roamRewakeMinutes,
            ordersRewakeMinutes: posNum(w.ordersRewakeMinutes) ?? WAKE_DEFAULTS.ordersRewakeMinutes,
            followSettleSeconds: posNum(w.followSettleSeconds) ?? WAKE_DEFAULTS.followSettleSeconds,
            maxContinuations: posNum(w.maxContinuations) !== undefined ? Math.floor(posNum(w.maxContinuations)) : WAKE_DEFAULTS.maxContinuations,
            continueDelaySeconds: posNum(w.continueDelaySeconds) ?? WAKE_DEFAULTS.continueDelaySeconds,
            cwd: typeof w.cwd === 'string' && w.cwd.trim() ? w.cwd : null,
            activityPaths: activityPathsOf(w.activityPaths),
            maxIdleTurns: countOf(w.maxIdleTurns) ?? countOf(w.maxResumes) ?? WAKE_DEFAULTS.maxIdleTurns,
            maxJobTurns: posNum(w.maxJobTurns) !== undefined ? Math.max(1, Math.floor(posNum(w.maxJobTurns))) : WAKE_DEFAULTS.maxJobTurns,
            resumeDelaySeconds: posNum(w.resumeDelaySeconds) ?? WAKE_DEFAULTS.resumeDelaySeconds,
        },
    };
}
export const SERVE_USAGE = `cyberspace-mcp serve: one long-lived agent, over MCP Streamable HTTP on 127.0.0.1.

Usage: cyberspace-mcp serve [--state <dir>] [options] [agent options]

  --state <dir>                 The state directory. Default $CYBERSPACE_MCP_STATE, else ~/.cyberspace-mcp
  --port <n>                    The port, on 127.0.0.1 only. Default ${DEFAULT_PORT}; the URL is http://127.0.0.1:<port>${MCP_PATH}
  --token                       Require a bearer token, kept in <state>/http-token (made and printed once when absent).
  --no-token                    Do not require it, even when config.json says serve.token: true.
  --wake-command <cmd>          The command that runs one model turn; {prompt} is replaced by the prompt,
                                as one argument (no shell). Example: claude -p {prompt} --mcp-config ...
  --reply-command <cmd>         The same, for replies (a DM, a chat tag, your operator's move, a ride ready):
                                a faster model. Default: the wake command. With it, orders get a quick
                                reply turn and then a work turn on the wake command.
  --no-wake                     Serve without the waker, even when config.json has a wake command.
  --poll-seconds <n>            How often the waker looks for a reason to wake. Default ${WAKE_DEFAULTS.pollSeconds}
  --idle-kill-minutes <n>       Stop a turn with no tool call, no output and no write to wake.activityPaths
                                for this long. Default ${WAKE_DEFAULTS.idleKillMinutes}
  --max-turn-minutes <n>        Stop a turn that runs this long. Default ${WAKE_DEFAULTS.maxTurnMinutes}
  --chat-stranger-minutes <n>   Least minutes between turns woken by strangers in chat. Default ${WAKE_DEFAULTS.chatStrangerMinutes}
  --roam-rewake-minutes <n>     Least minutes between roam wakes. Default ${WAKE_DEFAULTS.roamRewakeMinutes}

Every agent option of the stdio mode works here too (--operator, --cap-call-seconds, ...);
see cyberspace-mcp --help. config.json keys: "serve": { "port", "token" } and
"wake": { "command", "replyCommand", "pollSeconds", "idleKillMinutes", "maxTurnMinutes",
"chatStrangerMinutes", "roamRewakeMinutes", "ordersRewakeMinutes", "maxContinuations", "cwd",
"activityPaths", "maxIdleTurns", "maxJobTurns", "resumeDelaySeconds" }.
Pause the waker with cyberspace-mcp wake pause (the file <state>/wake.pause); resume with wake resume.`;
//# sourceMappingURL=serveConfig.js.map