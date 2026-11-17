# Clog

A bridge from `console.*` to Better Stack (Logtail) for Node and Bun services.
Each log is shipped with the file and line **of the code that logged**, not of
the logger. In development the console prints exactly what it would print
without clog.

```ts
import { Clog, logger } from '@lmes/clog';

Clog.init(); // reads LOGTAIL_TOKEN and LOGTAIL_ENDPOINT

logger.info('order paid', { orderId: 42 }); // fields stay searchable
logger.error('refund failed', err);         // the error's stack is kept
console.log('still works');                 // console.* is routed through clog
```

## What gets printed

**At a terminal (`console` mode, the dev default)** clog is only a bridge: the
real `console.log` prints its arguments untouched. No timestamp, level, caller,
colours or reformatting are added, and `LOG_LEVEL` does not hide `console.*`
calls. The only thing clog does is forward the log to Better Stack.

**In a container (`json` mode, when stdout is not a TTY)** each log is one JSON
line, so a log collector can read the level, caller and fields:

```json
{"orderId":42,"time":"2026-11-17T06:17:27.089Z","level":"info","service":"payment-service","caller":"src/razorpay/refund.ts:88","msg":"order paid"}
```

Set `LOG_FORMAT=console` to keep the plain console output in a container too.

## Configuration

| Setting | Option | Environment | Default |
|---|---|---|---|
| Better Stack token | `Clog.init(token)` | `LOGTAIL_TOKEN` | none: nothing is shipped |
| Better Stack ingesting host | `Clog.init(token, {}, { endpoint })` | `LOGTAIL_ENDPOINT` | `in.logs.betterstack.com` (older sources only) |
| Lowest level shipped (and printed by `logger.*` and in `json` mode) | `{ level: 'warn' }` | `LOG_LEVEL` | `info` |
| Output | `{ format: 'console' \| 'json' }` | `LOG_FORMAT` | `console` on a TTY, else `json` |
| Service name | `{ service: 'chat-service' }` | `SERVICE_NAME` | `npm_package_name` |
| Patch console | `{ patchConsole: false }` | | `true` |
| Wrapper files to skip | `{ ignoreFiles: ['src/logger.ts'] }` | | none |

Levels, most to least important: `error`, `warn`, `info`, `debug`.
`console.log` and `console.info` log at `info`.

## Getting exact line numbers

Clog finds the caller from the stack trace and skips its own frames, so the
line is the line that called `logger.info()` or `console.log()`.

- **Bun, ts-node, tsx, `node file.ts`**: TypeScript lines with no setup.
- **`tsc` to `dist/` and `node dist/index.js`**: enable source maps, or the
  line points at the compiled JavaScript.
  - `tsconfig.json`: `"sourceMap": true`
  - start command: `node --enable-source-maps dist/index.js`
    (or `NODE_OPTIONS=--enable-source-maps`)
- **A service's own wrapper around console** (a `logger.ts` that calls
  `console.log`): pass it in `ignoreFiles`, or every line points at the wrapper.

## Not logging personal data

Never log message text or full phone numbers. Two helpers:

```ts
import { maskPhone, textSummary } from '@lmes/clog';

logger.info('message sent', { to: maskPhone(phone), body: textSummary(text) });
// { to: '***3210', body: '42 chars' }
```

## Shutdown

Logs are sent in batches about once a second, so up to a second of logs is
still in memory at any moment. A process that ends on its own (a script that
runs out of work) is flushed automatically. Every other way out needs a flush:

**Before `process.exit()`:**

```ts
await Clog.flush();
process.exit(0);
```

**When the container stops.** Docker, CapRover and Dokploy stop a container
with `SIGTERM`. Without a handler, Node and Bun exit immediately and the last
batch is lost, which is usually the shutdown error you most want to see. clog
does not install a handler itself, because that would change how every service
exits. Add the flush to the service's own shutdown:

```ts
async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  await worker.close(); // stop taking work first: BullMQ workers, HTTP server, pools
  await Clog.flush(); // last, so the lines logged while closing are sent too
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

If the service already has a shutdown handler, add `await Clog.flush()` as its
last step before `process.exit()`. Keep the whole handler under the platform's
stop timeout (10 seconds by default in Docker), or the process is killed before
the flush finishes.

If Better Stack cannot be reached, logging carries on and the failures are
reported on stderr: one `[clog] Better Stack send failed: ...` line per failed
batch in `json` mode, or Logtail's own error in `console` mode. clog never
ships its own failure reports, so a network outage cannot loop.

## Upgrading from 0.0.x

`^0.0.x` ranges never pick up 0.1, so nothing changes until a service bumps
the version itself.

- **pino and pino-pretty are gone.** The `singleLine`, `colorize`, and other
  pino-pretty options are still accepted by `Clog.init` and ignored.
- **Console is patched by `Clog.init()`, not on import.** Logs before `init`
  go straight to the console, instead of waiting in a queue (0.0.x queued them
  forever if `init` was never called).
- **`console.log` is `info` and `LOG_LEVEL` applies.** `console.debug` lines
  disappear unless `LOG_LEVEL=debug`.
- **Output is JSON in containers.** Set `LOG_FORMAT=console` to keep plain console output.
- **`Clog.init()` with no token reads `LOGTAIL_TOKEN`.**
- **New Better Stack sources need their ingesting host** in `LOGTAIL_ENDPOINT`;
  0.0.x silently sent them to the legacy host.

## Development

Tooling is Bun; the published package is plain JavaScript (CommonJS, an ES
module build, and type definitions from `tsc`), so it runs on Node 18+ and Bun.

```sh
bun install
bun run test      # builds with tsc, then `bun test`: every fixture runs under Node and Bun
bun run release   # tests, bumps the version and changelog, then `bun publish`
```

Node must be installed to run the tests, since half of them start Node.
