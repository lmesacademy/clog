// Run with `bun test`. Each fixture is started as a child process under both
// Node and Bun, since services run clog on both and the stack trace formats
// (and source map handling) differ between them.
const { beforeAll, describe, expect, test } = require('bun:test');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');

/** Runs a script and returns every JSON line it printed, stdout and stderr together. */
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: fixtures,
      env: { ...process.env, LOG_FORMAT: 'json', LOG_LEVEL: '', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out:\n${output}`));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      resolve({ code, lines, output });
    });
  });
}

function byMessage(lines, text) {
  const line = lines.find((entry) => entry.msg.includes(text));
  if (!line) throw new Error(`no line containing "${text}"`);
  return line;
}

/**
 * A local stand-in for Better Stack. @logtail/node sends msgpack over gzip;
 * the decoder comes with it, so it is resolved from there.
 */
async function startSink() {
  const msgpackPath = require.resolve('@msgpack/msgpack', {
    paths: [path.dirname(require.resolve('@logtail/node'))],
  });
  const { decode } = require(msgpackPath);

  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(...decode(zlib.gunzipSync(Buffer.concat(chunks))));
      res.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

beforeAll(() => {
  execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['-p', path.join(fixtures, 'tsconfig.json')],
    { stdio: 'inherit' }
  );
});

describe('caller line', () => {
  test('node with source maps reports the TypeScript line', async () => {
    const { lines } = await run('node', ['--enable-source-maps', 'dist/app.js']);

    expect(byMessage(lines, 'handled job').caller).toBe('src/app.ts:11');
    expect(byMessage(lines, 'plain console').caller).toBe('src/app.ts:15');
    expect(byMessage(lines, 'boom').caller).toBe('src/app.ts:16');
    // The wrapper file is ignored, so the line is where the wrapper was called.
    expect(byMessage(lines, 'through wrapper').caller).toBe('src/app.ts:18');
    expect(byMessage(lines, 'circular field').caller).toBe('src/app.ts:22');
  });

  test('node without source maps points at the right call, in the compiled file', async () => {
    const { lines } = await run('node', ['dist/app.js']);
    expect(byMessage(lines, 'handled job').caller).toMatch(/^dist\/app\.js:\d+$/);
  });

  test('bun reports the TypeScript line without any flag', async () => {
    const { lines } = await run('bun', ['src/app.ts']);

    expect(byMessage(lines, 'handled job').caller).toBe('src/app.ts:11');
    expect(byMessage(lines, 'plain console').caller).toBe('src/app.ts:15');
    expect(byMessage(lines, 'boom').caller).toBe('src/app.ts:16');
    expect(byMessage(lines, 'through wrapper').caller).toBe('src/app.ts:18');
    expect(byMessage(lines, 'circular field').caller).toBe('src/app.ts:22');
  });
});

describe.each([
  ['node', ['--enable-source-maps', 'dist/app.js']],
  ['bun', ['src/app.ts']],
])('output under %s', (command, args) => {
  test('fields, errors and service land in the JSON line', async () => {
    const { lines } = await run(command, args);

    const handled = byMessage(lines, 'handled job');
    expect(handled.level).toBe('info');
    expect(handled.service).toBe('fixture');
    expect(handled.jobId).toBe(7);
    expect(handled.msg).toBe('handled job');

    const boom = byMessage(lines, 'boom');
    expect(boom.level).toBe('error');
    expect(boom.msg).toBe('Error: boom');
    expect(boom.err.message).toBe('boom');
    expect(boom.err.stack).toMatch(/app\.ts:16/);

    const circular = byMessage(lines, 'circular field');
    expect(circular.circular.self).toBe('[Circular]');
    expect(circular.big).toBe('9');
  });

  test('LOG_LEVEL gates what is printed', async () => {
    const quiet = await run(command, args);
    expect(quiet.lines.some((line) => line.level === 'debug')).toBe(false);

    const verbose = await run(command, args, { LOG_LEVEL: 'debug' });
    expect(verbose.lines.some((line) => line.level === 'debug')).toBe(true);

    const warnOnly = await run(command, args, { LOG_LEVEL: 'warn' });
    expect([...new Set(warnOnly.lines.map((line) => line.level))].sort()).toEqual([
      'error',
      'warn',
    ]);
  });
});

describe.each([['node'], ['bun']])('Better Stack under %s', (command) => {
  test(
    'ships with the real caller and flushes on exit',
    async () => {
      const sink = await startSink();
      try {
        const { code } = await run(command, ['ship.js'], {
          LOGTAIL_ENDPOINT: sink.endpoint,
        });
        expect(code).toBe(0);
      } finally {
        await sink.close();
      }

      const info = sink.received.find((log) => log.message === 'shipped info');
      expect(info).toBeDefined();
      expect(info.level).toBe('info');
      expect(info.service).toBe('ship');
      expect(info.orderId).toBe(12);
      expect(info.caller).toBe('ship.js:8');
      expect(info.context.runtime.file).toBe('ship.js');
      expect(info.context.runtime.line).toBe(8);

      const error = sink.received.find(
        (log) => log.message === 'Error: shipped error'
      );
      expect(error).toBeDefined();
      expect(error.context.runtime.line).toBe(9);
      expect(error.err.message).toBe('shipped error');
    },
    20000
  );

  test(
    'an unreachable endpoint does not loop or keep the process alive',
    async () => {
      const { code, output } = await run(command, ['ship.js'], {
        // Nothing listens on port 9, so every send fails.
        LOGTAIL_ENDPOINT: 'http://127.0.0.1:9',
      });
      expect(code).toBe(0);
      expect(output.length).toBeLessThan(20000);
      expect(output).toContain('[clog] Better Stack send failed');
    },
    20000
  );
});
