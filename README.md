# Clog

Captures console.log and send to logtail

#### Usage

```js
import { Clog } from '../src';

Clog.init('YOUR_LOGTAIL_TOKEN');

console.log('Hello World'); // this will log in console as well streamed to logtail
```
