import { Clog } from '../src';

Clog.init(process.env.LOGTAIL_TOKEN, { singleLine: true });

console.log('Hello World');

console.info(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);

console.error('warning', { a: 1, b: 2, c: 3 });
