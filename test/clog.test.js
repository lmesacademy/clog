const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
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
  assert.ok(line, `no line containing "${text}"`);
  return line;
}

test.before(() => {
  execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['-p', path.join(fixtures, 'tsconfig.json')],
    { stdio: 'inherit' }
  );
});

test('node with source maps reports the TypeScript line', async () => {
  const { lines } = await run('node', ['--enable-source-maps', 'dist/app.js']);

  assert.equal(byMessage(lines, 'handled job').caller, 'src/app.ts:11');
  assert.equal(byMessage(lines, 'plain console').caller, 'src/app.ts:15');
  assert.equal(byMessage(lines, 'boom').caller, 'src/app.ts:16');
  // The wrapper file is ignored, so the line is where the wrapper was called.
  assert.equal(byMessage(lines, 'through wrapper').caller, 'src/app.ts:18');
  assert.equal(byMessage(lines, 'circular field').caller, 'src/app.ts:22');
});

test('node without source maps still points at the right call, in the compiled file', async () => {
  const { lines } = await run('node', ['dist/app.js']);
  const caller = byMessage(lines, 'handled job').caller;
  assert.match(caller, /^dist\/app\.js:\d+$/);
});

test('bun reports the TypeScript line without any flag', async (t) => {
  try {
    execFileSync('bun', ['--version']);
  } catch {
    t.skip('bun is not installed');
    return;
  }
  const { lines } = await run('bun', ['src/app.ts']);
  assert.equal(byMessage(lines, 'handled job').caller, 'src/app.ts:11');
  assert.equal(byMessage(lines, 'plain console').caller, 'src/app.ts:15');
  assert.equal(byMessage(lines, 'through wrapper').caller, 'src/app.ts:18');
});

test('fields, errors and service land in the JSON line', async () => {
  const { lines } = await run('node', ['--enable-source-maps', 'dist/app.js']);

  const handled = byMessage(lines, 'handled job');
  assert.equal(handled.level, 'info');
  assert.equal(handled.service, 'fixture');
  assert.equal(handled.jobId, 7);
  assert.equal(handled.msg, 'handled job');

  const boom = byMessage(lines, 'boom');
  assert.equal(boom.level, 'error');
  assert.equal(boom.msg, 'Error: boom');
  assert.equal(boom.err.message, 'boom');
  assert.match(boom.err.stack, /app\.ts:16/);

  const circular = byMessage(lines, 'circular field');
  assert.equal(circular.circular.self, '[Circular]');
  assert.equal(circular.big, '9');
});

test('LOG_LEVEL gates what is printed', async () => {
  const quiet = await run('node', ['dist/app.js']);
  assert.ok(!quiet.lines.some((line) => line.level === 'debug'));

  const verbose = await run('node', ['dist/app.js'], { LOG_LEVEL: 'debug' });
  assert.ok(verbose.lines.some((line) => line.level === 'debug'));

  const warnOnly = await run('node', ['dist/app.js'], { LOG_LEVEL: 'warn' });
  assert.deepEqual(
    [...new Set(warnOnly.lines.map((line) => line.level))].sort(),
    ['error', 'warn']
  );
});

test('ships to Better Stack with the real caller and flushes on exit', async () => {
  // @msgpack/msgpack comes with @logtail/node, which sends msgpack over gzip.
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
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const { code } = await run('node', ['ship.js'], {
      LOGTAIL_ENDPOINT: `http://127.0.0.1:${port}`,
    });
    assert.equal(code, 0);
  } finally {
    server.close();
  }

  const info = received.find((log) => log.message === 'shipped info');
  assert.ok(info, 'info line was not shipped');
  assert.equal(info.level, 'info');
  assert.equal(info.service, 'ship');
  assert.equal(info.orderId, 12);
  assert.equal(info.caller, 'ship.js:8');
  assert.equal(info.context.runtime.file, 'ship.js');
  assert.equal(info.context.runtime.line, 8);

  const error = received.find((log) => log.message === 'Error: shipped error');
  assert.ok(error, 'error line was not shipped');
  assert.equal(error.context.runtime.line, 9);
  assert.equal(error.err.message, 'shipped error');
});

test('an unreachable endpoint does not loop or crash the service', async () => {
  const { code, output } = await run('node', ['ship.js'], {
    // Nothing listens on port 9, so every send fails.
    LOGTAIL_ENDPOINT: 'http://127.0.0.1:9',
  });
  assert.equal(code, 0);
  assert.ok(output.length < 20000, `output grew to ${output.length} chars`);
});
