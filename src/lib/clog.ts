import { Logtail } from '@logtail/node';
import { ILogtailOptions } from '@logtail/types';
import pino from 'pino';

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
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      singleLine: true,
    },
  },
});

function log(...args: any) {
  logger.info(args);
  logtail.info(args);
}

function info(...args: any) {
  logger.info(args);
  if (logtail.isInitialized) logtail.info(args);
}

function warn(...args: any) {
  logger.warn(args);
  if (logtail.isInitialized) logtail.warn(args);
}

function debug(...args: any) {
  logger.debug(args);
  if (logtail.isInitialized) logtail.debug(args);
}

function error(...args: any) {
  logger.error(args);
  if (logtail.isInitialized) logtail.error(args);
}

console.log = log;
console.info = info;
console.warn = warn;
console.error = error;
console.debug = debug;

export class Clog {
  // Access original console
  static console = originalConsole;

  static init(sourceToken?: string, options?: Partial<ILogtailOptions>) {
    if (sourceToken) {
      logtail = new Logtail(sourceToken, options);
      logtail.isInitialized = true;
    }
  }

  static log = log;
  static info = info;
  static warn = warn;
  static error = error;
  static debug = debug;
}
