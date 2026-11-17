import { Clog, logger, maskPhone } from '../src';

Clog.init(process.env.LOGTAIL_TOKEN, { service: 'clog-example' });

logger.info('order paid', { orderId: 42, to: maskPhone('+91 98765 43210') });
logger.debug('only with LOG_LEVEL=debug');
console.warn('console.warn goes through clog too');
logger.error('refund failed', new Error('gateway timeout'));
