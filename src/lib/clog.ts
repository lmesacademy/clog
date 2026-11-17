import * as os from 'os';
import * as path from 'path';
import { format, inspect } from 'util';

import { Logtail } from '@logtail/node';

/**
 * Levels from most to least important. `LOG_LEVEL=warn` keeps `error` and
 * `warn` and drops the rest.
 */
export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

/** `json` for containers and log shippers, `pretty` for a person at a terminal. */
export type Format = 'json' | 'pretty';

export type ClogOptions = {
  /** Shown on every line and in Better Stack. Defaults to SERVICE_NAME, then npm_package_name. */
  service?: string;
  /** Lowest level that is printed and shipped. Defaults to LOG_LEVEL, then `info`. */
  level?: Level;
  /** Defaults to LOG_FORMAT, then `pretty` on a TTY and `json` everywhere else. */
  format?: Format;
  /**
   * Route console.log/info/warn/error/debug through clog. Default true, so a
   * service that only calls console.* is covered by one `Clog.init()`.
   */
  patchConsole?: boolean;
  /**
   * Path fragments of a service's own logging wrapper, e.g. `['src/logger.ts']`.
   * Frames in those files are skipped too, so the reported caller is the code
   * that called the wrapper rather than the wrapper itself.
   */
  ignoreFiles?: string[];
  /**
   * 0.0.x accepted pino-pretty options here (singleLine, colorize, ...).
   * They are ignored now, but still accepted so old init calls compile.
   */
  [legacyOption: string]: unknown;
};

/** Options passed straight to `@logtail/node`, e.g. `{ endpoint }`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogtailOptions = Record<string, any>;

/**
 * Sources created before Better Stack moved to per-source ingesting hosts
 * still accept this. 0.0.x used it implicitly, so a plain `Clog.init(token)`
 * keeps working; newer sources should pass their own endpoint.
 */
const LEGACY_ENDPOINT = 'https://in.logs.betterstack.com';

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

type State = {
  service?: string;
  level?: Level;
  format?: Format;
  ignoreFiles: string[];
  logtail: Logtail | null;
  consolePatched: boolean;
};

const state: State = { ignoreFiles: [], logtail: null, consolePatched: false };

/**
 * Set while clog is writing. Logtail reports its own send failures through
 * console.error, which would come straight back here and loop.
 */
let writing = false;

/** The file this code lives in, found once from a stack trace. */
let ownFile: string | null | undefined;

type Frame = { file: string; line: number; column: number; fn?: string };

/**
 * Parses one V8/Bun stack line, `at fn (file:1:2)` or `at file:1:2`.
 * The stack string is used rather than CallSite objects because Node only
 * applies source maps (`--enable-source-maps`) to the string, and that is
 * what turns `dist/app.js:5` back into `src/app.ts:6`.
 */
function parseFrame(line: string): Frame | null {
  const match = line.match(
    /^\s*at (?:(.*?) \()?((?:file:\/\/)?[^()]+?):(\d+):(\d+)\)?\s*$/
  );
  if (!match) return null;
  return {
    fn: match[1] || undefined,
    file: match[2].replace(/^file:\/\//, ''),
    line: Number(match[3]),
    column: Number(match[4]),
  };
}

/**
 * Finds the first frame outside this file: the code that called the logger
 * (or console.log, once patched). 0.0.x read a fixed stack depth and then let
 * Logtail guess again, which is why Better Stack showed clog's own lines.
 */
function findCaller(): Frame | null {
  const frames = (new Error().stack || '')
    .split('\n')
    .slice(1)
    .map(parseFrame)
    .filter((frame): frame is Frame => frame !== null);

  if (ownFile === undefined) {
    ownFile = frames.length ? frames[0].file : null;
  }

  for (const frame of frames) {
    if (frame.file === ownFile) continue;
    if (frame.file.startsWith('node:') || frame.file.startsWith('internal/'))
      continue;
    if (state.ignoreFiles.some((fragment) => frame.file.includes(fragment)))
      continue;
    return frame;
  }
  return null;
}

/** Relative to the working directory when it is inside it, so lines stay short. */
function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') ? file : relative;
}

function threshold(): number {
  const configured = String(
    state.level || process.env.LOG_LEVEL || 'info'
  ).toLowerCase() as Level;
  const index = LEVELS.indexOf(configured);
  return index === -1 ? LEVELS.indexOf('info') : index;
}

function outputFormat(): Format {
  if (state.format) return state.format;
  const configured = String(process.env.LOG_FORMAT || '').toLowerCase();
  if (configured === 'json' || configured === 'pretty') return configured;
  return process.stdout.isTTY ? 'pretty' : 'json';
}

function serviceName(): string | undefined {
  return (
    state.service ||
    process.env.SERVICE_NAME ||
    process.env.npm_package_name ||
    undefined
  );
}

type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  cause?: SerializedError | unknown;
};

function serializeError(error: Error, depth = 0): SerializedError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extra = error as any;
  const serialized: SerializedError = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (extra.code !== undefined) serialized.code = extra.code;
  if (extra.cause !== undefined && depth < 3) {
    serialized.cause =
      extra.cause instanceof Error
        ? serializeError(extra.cause, depth + 1)
        : extra.cause;
  }
  return serialized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type Entry = {
  message: string;
  fields?: Record<string, unknown>;
  err?: SerializedError;
};

/**
 * Turns console-style arguments into a message plus searchable fields.
 *
 * `logger.info('order paid', { orderId })` keeps orderId as a field instead of
 * flattening it into the text, so it can be filtered on in Better Stack.
 * Anything else is formatted the way console.log would format it.
 */
function buildEntry(args: unknown[]): Entry {
  const entry: Entry = { message: '' };
  let rest = args;

  if (
    args.length >= 2 &&
    typeof args[0] === 'string' &&
    isPlainObject(args[args.length - 1])
  ) {
    entry.fields = args[args.length - 1] as Record<string, unknown>;
    rest = args.slice(0, -1);
  }

  const error = args.find((arg): arg is Error => arg instanceof Error);
  if (error) entry.err = serializeError(error);

  // An Error formats as its whole stack; keep the message to one line and
  // leave the stack in `err`, where it is not repeated.
  entry.message = format(
    ...rest.map((arg) =>
      arg instanceof Error ? `${arg.name}: ${arg.message}` : arg
    )
  );
  return entry;
}

/** JSON.stringify that survives cycles and BigInt instead of throwing mid-log. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return serializeError(item);
    if (item !== null && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

const COLORS: Record<Level, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function writeLine(level: Level, line: string): void {
  const stream =
    level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS.indexOf(level) > threshold()) return;

  if (writing) {
    // Re-entered from inside clog (Logtail reporting a failed send). Write it
    // plainly and do not ship it, or a broken network becomes an endless loop.
    process.stderr.write(`[clog] ${format(...args)}\n`);
    return;
  }

  writing = true;
  try {
    const caller = findCaller();

    // Logtail reports a failed send through console.error from its batch
    // timer, outside the `writing` guard. Shipping that report would fail the
    // same way and queue yet another one, so print it and stop there.
    if (caller && caller.file.includes(`${path.sep}@logtail${path.sep}`)) {
      const text = args
        .map((arg) => (arg instanceof Error ? arg.message : format(arg)))
        .join(' ');
      process.stderr.write(`[clog] Better Stack send failed: ${text}\n`);
      return;
    }

    const callerText = caller
      ? `${displayPath(caller.file)}:${caller.line}`
      : undefined;
    const entry = buildEntry(args);
    const service = serviceName();
    const time = new Date().toISOString();

    if (outputFormat() === 'json') {
      writeLine(
        level,
        safeStringify({
          ...entry.fields,
          time,
          level,
          service,
          caller: callerText,
          msg: entry.message,
          err: entry.err,
        })
      );
    } else {
      // Colours only for a terminal; LOG_FORMAT=pretty piped to a file stays plain.
      const colors = Boolean(process.stdout.isTTY);
      const paint = (code: string, text: string) =>
        colors ? `${code}${text}${RESET}` : text;
      const parts = [
        paint(DIM, time.slice(11, 23)),
        paint(COLORS[level], level.toUpperCase().padEnd(5)),
        callerText ? paint(DIM, callerText) : '',
        entry.message,
        entry.fields ? inspect(entry.fields, { colors, depth: 4 }) : '',
      ].filter(Boolean);
      let line = parts.join(' ');
      if (entry.err?.stack) line += `\n${entry.err.stack}`;
      writeLine(level, line);
    }

    if (state.logtail) {
      // captureStackContext is off, so this runtime block is the only caller
      // information Better Stack gets, and it is the right one.
      void state.logtail
        .log(entry.message, level as never, {
          ...entry.fields,
          service,
          caller: callerText,
          err: entry.err,
          context: {
            runtime: caller
              ? {
                  file: displayPath(caller.file),
                  line: caller.line,
                  column: caller.column,
                  function: caller.fn,
                }
              : undefined,
            system: systemInfo(),
          },
        })
        .catch(() => undefined);
    }
  } finally {
    writing = false;
  }
}

let cachedSystemInfo: Record<string, unknown> | undefined;

/** Static per process, so built once rather than on every line. */
function systemInfo(): Record<string, unknown> {
  if (!cachedSystemInfo) {
    cachedSystemInfo = {
      hostname: os.hostname(),
      pid: process.pid,
      // `require` does not exist in the ES module build.
      main_file:
        typeof require !== 'undefined' ? require.main?.filename : undefined,
      environment: process.env.NODE_ENV,
      runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    };
  }
  return cachedSystemInfo;
}

function patchConsole(): void {
  if (state.consolePatched) return;
  console.log = (...args: unknown[]) => emit('info', args);
  console.info = (...args: unknown[]) => emit('info', args);
  console.warn = (...args: unknown[]) => emit('warn', args);
  console.error = (...args: unknown[]) => emit('error', args);
  console.debug = (...args: unknown[]) => emit('debug', args);
  state.consolePatched = true;
}

function restoreConsole(): void {
  Object.assign(console, originalConsole);
  state.consolePatched = false;
}

/**
 * Level-gated logger. Use this in new code; console.* still works once
 * `Clog.init()` has patched it.
 */
export const logger = {
  /** A failure. */
  error: (...args: unknown[]) => emit('error', args),
  /** Survivable, but someone should know. */
  warn: (...args: unknown[]) => emit('warn', args),
  /** Lifecycle and one line per completed piece of work. */
  info: (...args: unknown[]) => emit('info', args),
  /** Per-event tracing. Off unless LOG_LEVEL=debug. */
  debug: (...args: unknown[]) => emit('debug', args),
};

export class Clog {
  /** The console as it was before clog patched it. */
  static console = originalConsole;

  /**
   * Starts clog. Every argument is optional:
   *
   * - `sourceToken` falls back to LOGTAIL_TOKEN. Without one, nothing is
   *   shipped and logs only go to stdout/stderr.
   * - `logtailOptions.endpoint` falls back to LOGTAIL_ENDPOINT, then the
   *   legacy Better Stack host.
   */
  static init(
    sourceToken?: string,
    options: ClogOptions = {},
    logtailOptions: LogtailOptions = {}
  ): void {
    state.service = options.service;
    state.level = options.level;
    state.format = options.format;
    state.ignoreFiles = options.ignoreFiles || [];

    const token = sourceToken || process.env.LOGTAIL_TOKEN;
    if (token) {
      let endpoint =
        logtailOptions.endpoint || process.env.LOGTAIL_ENDPOINT || LEGACY_ENDPOINT;
      // Better Stack shows the ingesting host without a scheme.
      if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
      state.logtail = new Logtail(token, {
        ...logtailOptions,
        endpoint,
        captureStackContext: false,
      });
    } else {
      state.logtail = null;
    }

    if (options.patchConsole === false) {
      restoreConsole();
    } else {
      patchConsole();
    }
  }

  /**
   * Sends whatever is still batched. Call it before `process.exit()`;
   * a process that ends on its own is flushed automatically.
   */
  static async flush(): Promise<void> {
    if (state.logtail) await state.logtail.flush();
  }

  static log = logger.info;
  static info = logger.info;
  static warn = logger.warn;
  static error = logger.error;
  static debug = logger.debug;
}

// A process that runs out of work exits without waiting for Logtail's batch
// timer, so the last second of logs, often the interesting ones, would be lost.
process.once('beforeExit', () => {
  void Clog.flush();
});

/**
 * What a message was, without what it said: `"42 chars"`.
 * Message text answers nothing the database cannot, and puts a customer's
 * words in a log that is shipped, searched and kept.
 */
export function textSummary(text: unknown): string {
  if (typeof text !== 'string') return text == null ? 'none' : typeof text;
  return `${text.length} chars`;
}

/** Enough of a number to match it against a record, not enough to dial: `"***3210"`. */
export function maskPhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return 'none';
  return `***${digits.slice(-4)}`;
}
