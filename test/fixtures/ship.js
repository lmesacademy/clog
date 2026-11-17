// Sends a few lines to the Better Stack endpoint given in LOGTAIL_ENDPOINT
// (a local server in the tests) and then exits on its own, so the
// beforeExit flush is what gets them out.
const { Clog, logger } = require('../../build/main');

Clog.init('test-token', { service: 'ship' });

logger.info('shipped info', { orderId: 12 }); // line 8
console.error(new Error('shipped error')); // line 9
