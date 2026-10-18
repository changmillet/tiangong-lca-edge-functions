'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { cancellationEvidence } = require('./stack-qualification/cancellation.cjs');
const { signedHeaders, hash } = require('./stack-qualification/contracts.cjs');
const nonce = 'C3NVlBMrCwN0KN7NTwY_ZQ';
const event = (name, value = nonce) => JSON.stringify({ event: `stack.${name}`, nonce: value });
const abortEvent = event('request.abort');
const cancelEvent = event('response.cancel');
const driver = fs.readFileSync(path.join(__dirname, 'qualify-local-stack.cjs'), 'utf8');

test('cancellation requires both structured events from stdout, stderr or split streams', () => {
  for (const streams of [
    { stdout: `${abortEvent}\n${cancelEvent}\n`, stderr: '' },
    { stdout: '', stderr: `[Info] ${cancelEvent}\n\n[Info] ${abortEvent}\n` },
    { stdout: `${abortEvent}\n`, stderr: `[Info] ${cancelEvent}\r\n` },
  ]) {
    const actual = cancellationEvidence(streams, nonce);
    assert.equal(actual.nonce, nonce);
    assert.equal(actual.requestAbort, true);
    assert.equal(actual.responseCancel, true);
    assert.equal(actual.events.length, 2);
    assert.ok(actual.events.every((record) => record.nonce === nonce));
  }
});

test('missing, foreign-nonce and non-structural cancellation strings cannot prove cancellation', () => {
  for (const streams of [
    { stdout: abortEvent, stderr: '' },
    { stdout: '', stderr: cancelEvent },
    { stdout: abortEvent, stderr: event('response.cancel', 'a'.repeat(22)) },
    { stdout: event('request.abort', 'a'.repeat(22)), stderr: cancelEvent },
    { stdout: 'stack.request.abort stack.response.cancel', stderr: '' },
    { stdout: JSON.stringify(`${abortEvent}\n${cancelEvent}`), stderr: '' },
    { stdout: JSON.stringify({ message: `${abortEvent} ${cancelEvent}` }), stderr: '' },
    { stdout: `${abortEvent} trailing\n${cancelEvent}`, stderr: '' },
    { stdout: JSON.stringify({ ...JSON.parse(abortEvent), extra: true }), stderr: cancelEvent },
    { stdout: `[Error] ${abortEvent}`, stderr: `[Info] ${cancelEvent}` },
    { stdout: JSON.stringify([JSON.parse(abortEvent), JSON.parse(cancelEvent)]), stderr: '' },
    { stdout: 'null\nfalse\n{not json}', stderr: '' },
  ]) {
    const actual = cancellationEvidence(streams, nonce);
    assert.equal(actual.requestAbort && actual.responseCancel, false);
  }
  for (const invalid of ['', 'wrong', null, nonce + 'extra'])
    assert.throws(() => cancellationEvidence({ stdout: abortEvent, stderr: cancelEvent }, invalid));
});

test('actual command wrapper retains both streams on opt-in and still rejects failed commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge496-command-streams-'));
  const ledger = { commands: [] };
  const start = driver.indexOf('  function run(command, args, options = {}) {');
  const end = driver.indexOf('  const docker = ', start);
  assert.ok(start >= 0 && end > start);
  const run = new Function(
    'fs',
    'path',
    'spawnSync',
    'root',
    'env',
    'redact',
    'ledger',
    'persist',
    'evidence',
    'hash',
    `${driver.slice(start, end)}\nreturn run;`,
  )(
    fs,
    path,
    spawnSync,
    root,
    {},
    (value) => value,
    ledger,
    () => {},
    root,
    hash,
  );
  const args = ['-e', 'process.stdout.write("out");process.stderr.write("err")'];
  try {
    assert.equal(run(process.execPath, args), 'out');
    assert.deepEqual(run(process.execPath, args, { returnStreams: true }), {
      stdout: 'out',
      stderr: 'err',
    });
    assert.equal(fs.readFileSync(path.join(root, 'command-1.log'), 'utf8'), 'out');
    assert.equal(fs.readFileSync(path.join(root, 'command-1.stderr.log'), 'utf8'), 'err');
    assert.throws(
      () => run(process.execPath, ['-e', 'process.exit(3)'], { returnStreams: true }),
      /failed/u,
    );
    assert.deepEqual(
      ledger.commands.map(({ exit }) => exit),
      [0, 0, 3],
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

async function runCancellationBlock(mode) {
  const start = driver.indexOf('    const cancelBody = ');
  const end = driver.indexOf('    for (const name of [pairKong, pairRuntime])', start);
  assert.ok(start >= 0 && end > start);
  const receipts = [];
  const calls = { fetch: 0, abort: 0, cancel: 0, polls: 0, pauses: 0 };
  let currentNonce;
  const ledger = { commands: [], outcomes: [] };
  const context = {
    assert,
    Buffer,
    AbortController,
    cancellationEvidence,
    signedHeaders,
    hash,
    ledger,
    pairUrl: 'http://127.0.0.1/fixture',
    pairRuntime: 'exact-owned-runtime',
    synthetic: { publishable: 'sb_publishable_synthetic_test_only' },
    write: (name, value) => receipts.push({ name, value: structuredClone(value) }),
    fetch: async (_url, options) => {
      calls.fetch++;
      currentNonce = options.headers['x-portal-nonce'];
      options.signal.addEventListener('abort', () => calls.abort++, { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            if (mode === 'empty') controller.close();
            else controller.enqueue(Buffer.from('ready\n'));
          },
          cancel() {
            calls.cancel++;
          },
        }),
        { status: mode === 'bad-status' ? 400 : 200 },
      );
    },
    docker: (args, options) => {
      assert.deepEqual(args, ['logs', 'exact-owned-runtime']);
      assert.deepEqual(options, { returnStreams: true });
      calls.polls++;
      ledger.commands.push({ command: 'docker', args });
      const abort = event('request.abort', currentNonce);
      const cancel = event(
        'response.cancel',
        mode === 'wrong-nonce' ? 'a'.repeat(22) : currentNonce,
      );
      return mode === 'stdout'
        ? { stdout: `${abort}\n${cancel}\n`, stderr: '' }
        : mode === 'split'
          ? { stdout: `${abort}\n`, stderr: `[Info] ${cancel}\n` }
          : {
              stdout: '',
              stderr: `[Info] ${abort}\n${mode === 'missing' ? '' : `[Info] ${cancel}\n`}`,
            };
    },
    delay: async (milliseconds) => {
      assert.equal(milliseconds, 100);
      calls.pauses++;
    },
  };
  const execute = new Function(
    ...Object.keys(context),
    `return (async () => {${driver.slice(start, end)}})();`,
  );
  let error;
  try {
    await execute(...Object.values(context));
  } catch (caught) {
    error = caught;
  }
  return { calls, receipts, ledger, error, currentNonce };
}

test(
  'actual driver binds both events to current signed nonce and preserves one read/abort receipt',
  { timeout: 2000 },
  async () => {
    for (const mode of ['stdout', 'stderr', 'split']) {
      const { calls, receipts, ledger, error, currentNonce } = await runCancellationBlock(mode);
      assert.equal(error, undefined);
      assert.deepEqual(calls, { fetch: 1, abort: 1, cancel: 1, polls: 1, pauses: 0 });
      assert.equal(receipts[0].value.fetchStarted, false);
      assert.equal(receipts[1].value.fetchStarted, true);
      const state = receipts
        .filter(({ name }) => name === 'cancellation-request.json')
        .at(-1).value;
      assert.deepEqual(state, {
        nonce: currentNonce,
        fetchStarted: true,
        responseStatus: 200,
        readCompleted: true,
        firstReadDone: false,
        firstReadBytes: 6,
        abortCalled: true,
        signalAborted: true,
        readerCancelSettled: true,
        readerCancelRejected: false,
      });
      assert.doesNotMatch(
        JSON.stringify(receipts),
        /x-portal-signature|apikey|sb_publishable_|authorization/iu,
      );
      assert.deepEqual(ledger.outcomes, [
        { case: 'worker-cancellation', requestAbort: true, responseCancel: true },
      ]);
      const evidence = receipts.find(({ name }) => name === 'cancellation-events.json').value;
      assert.equal(evidence.nonce, currentNonce);
      assert.equal(evidence.commandIndex, 0);
      assert.ok(evidence.requestAbort && evidence.responseCancel);
    }
  },
);

test(
  'actual driver retains 50 polls and 100ms pauses and fails missing or foreign cancellation events',
  { timeout: 2000 },
  async () => {
    for (const mode of ['missing', 'wrong-nonce']) {
      const { calls, ledger, error } = await runCancellationBlock(mode);
      assert.match(error.message, /Actual worker cancellation evidence missing/u);
      assert.deepEqual(calls, { fetch: 1, abort: 1, cancel: 1, polls: 50, pauses: 50 });
      assert.deepEqual(ledger.outcomes, []);
    }
  },
);

test(
  'actual driver still rejects non-200 responses and missing first data before abort or log proof',
  { timeout: 2000 },
  async () => {
    for (const mode of ['bad-status', 'empty']) {
      const { calls, ledger, error, receipts } = await runCancellationBlock(mode);
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.deepEqual(calls, { fetch: 1, abort: 0, cancel: 0, polls: 0, pauses: 0 });
      assert.deepEqual(ledger.outcomes, []);
      const state = receipts.at(-1).value;
      assert.equal(state.responseStatus, mode === 'bad-status' ? 400 : 200);
      assert.equal(state.readCompleted, mode === 'empty');
      assert.equal(state.abortCalled, false);
    }
  },
);
