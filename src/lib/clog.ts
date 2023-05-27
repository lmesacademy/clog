import { Logtail } from '@logtail/node';
import { ILogtailOptions } from '@logtail/types';
import pino, { Logger, LoggerOptions } from 'pino';

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
          crlf: options?.crlf,
          errorLikeObjectKeys: options?.errorLikeObjectKeys,
          errorProps: options?.errorProps,
          levelFirst: options?.levelFirst,
          messageKey: options?.messageKey,
          levelKey: options?.levelKey,
          messageFormat: options?.messageFormat,
          timestampKey: options?.timestampKey,
          include: options?.include,
          hideObject: options?.hideObject,
          config: options?.config,
          customColors: options?.customColors,
          customLevels: options?.customLevels,
          levelLabel: options?.levelLabel,
          minimumLevel: options?.minimumLevel,
          useOnlyCustomProps: options?.useOnlyCustomProps,
          sync: options?.sync,
          append: options?.append,
          mkdir: options?.mkdir,
          customPrettifiers: options?.customPrettifiers,
        },
      },
    });

    logger.info(options);

    isLoggerInitialized = true;
  }

  static log = log;
  static info = info;
  static warn = warn;
  static error = error;
  static debug = debug;
}

function log(...args: any) {
  logger.info(args);
  logtail.info(args);
}

function info(...args: any) {
  if (isLoggerInitialized) logger.info(args);
  if (logtail.isInitialized) logtail.info(args);
}

function warn(...args: any) {
  if (isLoggerInitialized) logger.warn(args);
  if (logtail.isInitialized) logtail.warn(args);
}

function debug(...args: any) {
  if (isLoggerInitialized) logger.debug(args);
  if (logtail.isInitialized) logtail.debug(args);
}

function error(...args: any) {
  if (isLoggerInitialized) logger.error(args);
  if (logtail.isInitialized) logtail.error(args);
}

console.log = log;
console.info = info;
console.warn = warn;
console.error = error;
console.debug = debug;
