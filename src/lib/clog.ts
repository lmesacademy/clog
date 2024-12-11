import { Logtail } from '@logtail/node';
import { ILogtailOptions } from '@logtail/types';
import pino, { Logger, LoggerOptions } from 'pino';
import * as os from 'os';

const originalConsole = console; // Take a copy of the original console

let logtail: any = {
  isInitialized: false,
  info: () => {
    return;
  },
  error: () => {
    return;
  },
  warn: () => {
    return;
  },
  debug: () => {
    return;
  },
};

let isLoggerInitialized = false;

type ClogOptions = {
  singleLine?: boolean;
  colorize?: boolean;
  colorizeObjects?: boolean;
  crlf?: boolean;
  errorLikeObjectKeys?: string[];
  errorProps?: string;
  levelFirst?: boolean;
  messageKey?: string;
  levelKey?: string;
  messageFormat?: boolean;
  timestampKey?: string;
  translateTime?: boolean | string;
  ignore?: string;
  include?: string;
  hideObject?: boolean;
  config?: string;
  customColors?: string;
  customLevels?: string;
  levelLabel?: string;
  minimumLevel?: string;
  useOnlyCustomProps?: boolean;
  sync?: boolean;
  append?: boolean;
  mkdir?: boolean;
  customPrettifiers?: Record<string, unknown>;
};

let logger: Logger<LoggerOptions>;

export class Clog {
  // Access original console
  static console = originalConsole;
  static logsQueue: any[] = [];

  static init(
    sourceToken?: string,
    options?: ClogOptions,
    logtailOptions?: Partial<ILogtailOptions>
  ) {
    if (sourceToken) {
      logtail = new Logtail(sourceToken, logtailOptions);
      logtail.isInitialized = true;
    }

    logger = pino({
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: options?.colorize !== undefined ? options.colorize : true,
          singleLine:
            options?.singleLine !== undefined ? options.singleLine : true,
          colorizeObjects:
            options?.colorizeObjects !== undefined
              ? options.colorizeObjects
              : true,
          translateTime:
            options?.translateTime !== undefined
              ? options.translateTime
              : 'hh:MM:ss TT',
          ignore:
            options?.ignore !== undefined ? options.ignore : 'pid,hostname',
          crlf: options?.crlf !== undefined ? options.crlf : false,
          errorLikeObjectKeys: options?.errorLikeObjectKeys || ['err', 'error'],
          errorProps: options?.errorProps || '',
          levelFirst:
            options?.levelFirst !== undefined ? options.levelFirst : false,
          messageKey: options?.messageKey || 'msg',
          levelKey: options?.levelKey || 'level',
          messageFormat:
            options?.messageFormat !== undefined
              ? options.messageFormat
              : false,
          timestampKey: options?.timestampKey || 'time',
          include: options?.include,
          hideObject:
            options?.hideObject !== undefined ? options.hideObject : false,
          config: options?.config,
          customColors: options?.customColors,
          customLevels: options?.customLevels,
          levelLabel: options?.levelLabel,
          minimumLevel: options?.minimumLevel,
          useOnlyCustomProps: options?.useOnlyCustomProps,
          sync: options?.sync,
          append: options?.append,
          mkdir: options?.mkdir,
        },
      },
    });

    isLoggerInitialized = true;

    // log all remaining logs in the queue based on their type
    for (let i = 0; i < Clog.logsQueue.length; i++) {
      const log = Clog.logsQueue[i];
      switch (log.type) {
        case 'info':
          this.info(log.args);
          break;
        case 'warn':
          this.warn(log.args);
          break;
        case 'error':
          this.error(log.args);
          break;
        case 'debug':
          this.debug(log.args);
          break;
        default:
          this.log(log.args);
          break;
      }
    }

    this.logsQueue = [];
  }

  static log = log;
  static info = info;
  static warn = warn;
  static error = error;
  static debug = debug;
}

function getRuntimeInfo(stack: string | undefined) {
  if (!stack) return {};
  const stackLines = stack.split('\n');
  if (stackLines.length < 3) return {};
  const callerLine = stackLines[2];
  const match = callerLine.match(/\((.*):(\d+):(\d+)\)/);
  if (!match) return {};
  return {
    file: match[1],
    line: parseInt(match[2], 10),
    column: parseInt(match[3], 10),
    type: 'console',
    function: 'log',
    method: 'log',
  };
}

function getSystemInfo(): any {
  return {
    main_file: require.main?.filename,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    hostname: os.hostname(),
    uptime: os.uptime(),
    freemem: os.freemem(),
    totalmem: os.totalmem(),
    ip: os.networkInterfaces().lo0?.[0]?.address,
    environment: process.env.NODE_ENV,
  };
}

function getContext(runtime: any) {
  return {
    runtime,
    system: getSystemInfo(),
  };
}

function log(...args: any) {
  const stack = new Error().stack;
  const runtime = getRuntimeInfo(stack);

  if (isLoggerInitialized) {
    logger.info(args);
  } else {
    Clog.logsQueue.push({ type: 'log', args });
  }
  if (logtail.isInitialized)
    logtail.info(args, { context: getContext(runtime) });
}

function info(...args: any) {
  const stack = new Error().stack;
  const runtime = getRuntimeInfo(stack);

  if (isLoggerInitialized) {
    logger.info(args);
  } else {
    Clog.logsQueue.push({ type: 'info', args });
  }
  if (logtail.isInitialized)
    logtail.info(args, { context: getContext(runtime) });
}

function warn(...args: any) {
  const stack = new Error().stack;
  const runtime = getRuntimeInfo(stack);

  if (isLoggerInitialized) {
    logger.warn(args);
  } else {
    Clog.logsQueue.push({ type: 'warn', args });
  }
  if (logtail.isInitialized)
    logtail.warn(args, { context: getContext(runtime) });
}

function debug(...args: any) {
  const stack = new Error().stack;
  const runtime = getRuntimeInfo(stack);

  if (isLoggerInitialized) {
    logger.debug(args);
  } else {
    Clog.logsQueue.push({ type: 'debug', args });
  }
  if (logtail.isInitialized)
    logtail.debug(args, { stack, context: getContext(runtime) });
}

function error(...args: any) {
  const stack = new Error().stack;
  const runtime = getRuntimeInfo(stack);
  if (isLoggerInitialized) {
    logger.error(args);
  } else {
    Clog.logsQueue.push({ type: 'error', args });
  }
  if (logtail.isInitialized)
    logtail.error(args, { stack, context: getContext(runtime) });
}

console.log = log;
console.info = info;
console.warn = warn;
console.error = error;
console.debug = debug;
