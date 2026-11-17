// Prints the same things with or without clog. Run with `--clog` to init it;
// in console mode the output must be byte-for-byte the same either way.
if (process.argv.includes('--clog')) {
  require('../../build/main').Clog.init(undefined, { service: 'identity' });
}

const circular = { name: 'loop', nested: { list: [1, 2, 3] } };
circular.self = circular;

console.log('Hello World');
console.log('%s has %d items costing %o', 'cart', 3, { total: 99.5 });
console.info(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
console.warn('warning', { a: 1, b: 2, c: 3 });
console.error(new Error('boom'));
console.debug('debug line');
console.log(circular, [null, undefined, true], new Map([['k', 'v']]));
console.log('multi\nline\ttext   with spaces');
console.log();
