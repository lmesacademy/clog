// Every log call below has a `// line N` marker that the tests check against
// the reported caller, so keep the line numbers stable when editing.
import { Clog, logger } from '../../../build/main';
import { wrappedLog } from './wrapper';

Clog.init(undefined, { service: 'fixture', ignoreFiles: ['wrapper'] });

type Job = { id: number };

function handle(job: Job): void {
  logger.info('handled job', { jobId: job.id }); // line 11
}

handle({ id: 7 });
console.log('plain console', 42); // line 15
console.error(new Error('boom')); // line 16
logger.debug('hidden unless LOG_LEVEL=debug'); // line 17
wrappedLog('through wrapper'); // line 18

const circular: Record<string, unknown> = { name: 'loop' };
circular.self = circular;
logger.warn('circular field', { circular, big: BigInt(9) }); // line 22
