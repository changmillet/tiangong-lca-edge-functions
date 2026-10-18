'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  captureGatewayBaseline,
  gatewayGeneration,
  waitForNativeStartup,
} = require('./stack-qualification/startup.cjs');
const { waitForFixture } = require('./stack-qualification/http.cjs');
const line = (pid, message, level = 'notice') =>
  `2026/10/18 18:41:51 [${level}] ${pid}#0: ${message}\n`;
const loaded = (pid) =>
  line(
    pid,
    '*43 [kong] init.lua:426 declarative config loaded from /home/kong/kong.yml, context: init_worker_by_lua*',
  );
const expected = {
  id: 'a'.repeat(64),
  name: 'supabase_kong_owned',
  image: 'sha256:' + 'b'.repeat(64),
  project: 'owned',
  network: 'owned-cli',
};
const container = () => ({
  Id: expected.id,
  Name: '/' + expected.name,
  Image: expected.image,
  RestartCount: 0,
  State: { Running: true, StartedAt: '2026-10-18T18:41:40.000000000Z' },
  Config: {
    Labels: { 'com.supabase.cli.project': expected.project },
    Env: ['KONG_NGINX_WORKER_PROCESSES=1'],
  },
  NetworkSettings: {
    Networks: { [expected.network]: { NetworkID: 'c'.repeat(64), IPAddress: '172.18.0.3' } },
  },
});
const initial = {
  stdout: 'old health 钢\n',
  stderr:
    line(1, 'openresty/1.19.9.1') +
    line(1, 'start worker processes') +
    line(1, 'start worker process 10') +
    loaded(10),
};
const hup =
  line(1, 'signal 1 (SIGHUP) received from 30, reconfiguring') +
  line(1, 'reconfiguring') +
  line(1, 'start worker processes');
const started = hup + line(1, 'start worker process 20');
const configured = started + loaded(20);
const complete =
  configured +
  line(10, 'gracefully shutting down') +
  line(1, 'worker process 10 exited with code 0');
const streams = (suffix = '') => ({ stdout: initial.stdout, stderr: initial.stderr + suffix });
const baseline = () => captureGatewayBaseline(container(), initial, expected);
const runtime = {
  beforeId: 'd'.repeat(64),
  name: 'supabase_edge_runtime_owned',
  image: 'sha256:' + 'e'.repeat(64),
};
const replacement = () => ({
  Id: 'f'.repeat(64),
  Name: '/' + runtime.name,
  Image: runtime.image,
  State: { Running: true },
  Config: {
    Labels: { 'com.supabase.cli.project': 'owned' },
    Env: ['PORTAL_SUPABASE_PUBLISHABLE_KEY=synthetic'],
  },
});
const frame = (suffix = '') => ({
  kong: container(),
  logs: streams(suffix),
  runtime: replacement(),
  serveLog: '',
});

test('baseline needs the exact configured single-worker Kong container and complete prelaunch history', () => {
  const captured = baseline();
  assert.equal(captured.worker, '10');
  assert.equal(captured.master, '1');
  assert.equal(captured.receipt.cursors.stdout.bytes, Buffer.byteLength(initial.stdout));
  assert.ok(captured.receipt.cursors.stdout.bytes > initial.stdout.length);
  for (const bad of [
    { stdout: '', stderr: '' },
    { ...initial, stderr: initial.stderr.slice(0, -1) },
    { ...initial, stderr: initial.stderr.replace(loaded(10), '') },
    { ...initial, stderr: initial.stderr.replace('openresty/1.19.9.1', 'openresty/1.21.4.1') },
    streams(complete),
  ])
    assert.throws(() => captureGatewayBaseline(container(), bad, expected));
  for (const change of [
    (value) => {
      value.Id = '9'.repeat(64);
    },
    (value) => {
      value.Image = 'wrong';
    },
    (value) => {
      value.Config.Labels['com.supabase.cli.project'] = 'foreign';
    },
    (value) => {
      value.Config.Env = ['KONG_NGINX_WORKER_PROCESSES=2'];
    },
    (value) => {
      value.RestartCount = 1;
    },
  ]) {
    const value = container();
    change(value);
    assert.throws(() => captureGatewayBaseline(value, initial, expected));
  }
});

test('same-second HTTP-capable old or partly-reloaded worker cannot satisfy the generation barrier', () => {
  const base = baseline();
  for (const suffix of ['', hup, started, configured]) {
    const proof = gatewayGeneration(base, container(), streams(suffix), '');
    assert.equal(proof.ready, false);
  }
  const actual = gatewayGeneration(base, container(), streams(complete), '');
  assert.equal(actual.ready, true);
  assert.equal(actual.oldWorker, '10');
  assert.equal(actual.newWorker, '20');
  assert.equal(actual.newWorkerLoaded, true);
  assert.equal(actual.oldWorkerReaped, true);
});

test('byte cursor rejects missing, rewritten, truncated or cross-stream history and extra generations', () => {
  const base = baseline();
  for (const value of [
    { stdout: '', stderr: complete },
    { stdout: initial.stdout.replace('钢', '铁'), stderr: initial.stderr + complete },
    { stdout: initial.stdout, stderr: (initial.stderr + complete).slice(0, -1) },
    { stdout: initial.stdout + complete, stderr: initial.stderr },
    streams(complete + hup),
    streams(complete + line(1, 'start worker process 21')),
    streams(complete + line(1, 'openresty/1.19.9.1')),
    streams(complete + loaded(99)),
    streams(line(1, 'start worker process 20')),
    streams(complete.replace('1#0: signal 1', '2#0: signal 1')),
    streams(complete + line(1, 'worker process 10 exited with code 0')),
    streams(complete + loaded(20)),
    streams(
      complete
        .replace('start worker process 20', 'start worker process 1')
        .replace(loaded(20), loaded(1)),
    ),
    streams(
      hup +
        line(1, 'worker process 10 exited with code 0') +
        line(1, 'start worker process 20') +
        loaded(20),
    ),
    streams(
      hup.replace(line(1, 'reconfiguring'), '') +
        line(1, 'start worker process 20') +
        loaded(20) +
        line(1, 'worker process 10 exited with code 0'),
    ),
  ])
    assert.throws(() => gatewayGeneration(base, container(), value, ''));
  assert.equal(
    gatewayGeneration(base, container(), initial, '').ready,
    false,
    'preread events are not a new launch',
  );
  assert.equal(
    gatewayGeneration(
      base,
      container(),
      streams('plain SIGHUP reconfiguring worker process 10 exited with code 0\n'),
      '',
    ).ready,
    false,
  );
});

test('worker failures, reload warnings and replaced/restarted gateway identities fail closed', () => {
  const base = baseline();
  for (const suffix of [
    complete.replace('exited with code 0', 'exited with code 1'),
    configured + line(1, 'worker process 20 exited with code 0'),
    configured + line(1, 'worker process 10 exited on signal 11', 'alert'),
  ])
    assert.throws(() => gatewayGeneration(base, container(), streams(suffix), ''));
  assert.throws(
    () =>
      gatewayGeneration(
        base,
        container(),
        streams(complete),
        'Warning: failed to reload Kong: synthetic detail\n',
      ),
    { code: 'gateway_reload_failed' },
  );
  for (const change of [
    (value) => {
      value.Id = '9'.repeat(64);
    },
    (value) => {
      value.RestartCount = 1;
    },
    (value) => {
      value.State.StartedAt = '2026-10-18T18:41:51.000000000Z';
    },
    (value) => {
      value.State.Running = false;
    },
    (value) => {
      value.NetworkSettings.Networks[expected.network].NetworkID = '9'.repeat(64);
    },
  ]) {
    const value = container();
    change(value);
    assert.throws(() => gatewayGeneration(base, value, streams(complete), ''));
  }
});

test('delayed reload gates exact HTTP readiness until newworker loaded and oldworker reaped', async () => {
  const seen = [];
  let probes = 0;
  let httpCalls = 0;
  let pauses = 0;
  await waitForNativeStartup({
    baseline: baseline(),
    runtime,
    alive: () => true,
    probe(remaining) {
      assert.ok(remaining() > 0 && remaining() <= 1000);
      return frame(['', configured, complete][probes++]);
    },
    pause: async (ms) => {
      assert.equal(ms, 200);
      pauses++;
    },
    record: (value) => seen.push(value),
  });
  assert.equal(probes, 3);
  assert.equal(pauses, 2);
  assert.deepEqual(
    seen.map((value) => value.ready),
    [false, false, true],
  );
  await waitForFixture('http://127.0.0.1/fixture', {
    fetchImpl: async () => {
      httpCalls++;
      assert.equal(probes, 3, 'even an exact400 must follow the current gateway generation');
      return Response.json({ ok: false, code: 'portal_hmac_method_invalid' }, { status: 400 });
    },
  });
  assert.equal(httpCalls, 1);
});

test('no reload stays unready for exactly150 startup attempts with unchanged200ms pauses', async () => {
  let probes = 0;
  let pauses = 0;
  const seen = [];
  await assert.rejects(
    () =>
      waitForNativeStartup({
        baseline: baseline(),
        runtime,
        alive: () => true,
        probe: async () => {
          probes++;
          return frame();
        },
        record: (value) => seen.push(value),
        pause: async (ms) => {
          assert.equal(ms, 200);
          pauses++;
        },
      }),
    { code: 'native_startup_timeout' },
  );
  assert.equal(probes, 150);
  assert.equal(pauses, 149);
  assert.equal(seen.length, 150);
  assert.ok(seen.every((value) => !value.ready));
});

test('all observation operations share a1000ms budget and never accept an overdue proof', async () => {
  let time = 0;
  let probes = 0;
  let pauses = 0;
  const seen = [];
  await assert.rejects(
    () =>
      waitForNativeStartup({
        baseline: baseline(),
        runtime,
        alive: () => true,
        now: () => time,
        probe(remaining) {
          probes++;
          assert.equal(remaining(), 1000);
          time += 600;
          assert.equal(remaining(), 400);
          time += 401;
          return frame(complete);
        },
        record: (value) => seen.push(value),
        pause: async (ms) => {
          assert.equal(ms, 200);
          pauses++;
        },
      }),
    { code: 'native_startup_timeout' },
  );
  assert.equal(probes, 150);
  assert.equal(pauses, 149);
  assert.ok(seen.every((value) => value.reason === 'native_startup_probe_timeout' && !value.ready));
});

test('unknown probe errors, dead serve and wrong replacement runtime cannot become readiness', async () => {
  const denied = new Error('synthetic inspection denied');
  await assert.rejects(
    () =>
      waitForNativeStartup({
        baseline: baseline(),
        runtime,
        alive: () => true,
        probe: async () => {
          throw denied;
        },
        record: () => {},
        pause: () => assert.fail('unknown error must fail immediately'),
      }),
    (error) => error === denied,
  );
  let aliveCalls = 0;
  await assert.rejects(
    () =>
      waitForNativeStartup({
        baseline: baseline(),
        runtime,
        alive: () => ++aliveCalls === 1,
        probe: async () => frame(complete),
        record: () => {},
      }),
    { code: 'serve_exited_during_startup' },
  );
  const bad = frame(complete);
  bad.runtime.Image = 'foreign';
  await assert.rejects(
    () =>
      waitForNativeStartup({
        baseline: baseline(),
        runtime,
        alive: () => true,
        probe: async () => bad,
        record: () => {},
      }),
    { code: 'runtime_identity_unexpected' },
  );
});

test('gateway generation alone cannot bypass absent, stopped or unconfigured replacement runtime', async () => {
  let probes = 0;
  const values = [null, replacement(), replacement(), replacement()];
  values[1].State.Running = false;
  values[2].Config.Env = [];
  const observations = [];
  await waitForNativeStartup({
    baseline: baseline(),
    runtime,
    alive: () => true,
    probe: async () => ({ ...frame(complete), runtime: values[probes++] }),
    record: (value) => observations.push(value),
    pause: async () => {},
  });
  assert.equal(probes, 4);
  assert.deepEqual(
    observations.map((value) => value.ready),
    [false, false, false, true],
  );
});

test('a bounded Docker timeout stays unready and requires a fresh complete observation', async () => {
  let probes = 0;
  let pauses = 0;
  const observations = [];
  await waitForNativeStartup({
    baseline: baseline(),
    runtime,
    alive: () => true,
    probe: async () => {
      if (++probes === 1) throw new Error('synthetic timeout', { cause: { code: 'ETIMEDOUT' } });
      return frame(complete);
    },
    record: (value) => observations.push(value),
    pause: async (ms) => {
      assert.equal(ms, 200);
      pauses++;
    },
  });
  assert.equal(probes, 2);
  assert.equal(pauses, 1);
  assert.deepEqual(
    observations.map((value) => value.ready),
    [false, true],
  );
  assert.equal(observations[0].reason, 'native_startup_probe_timeout');
});

test('driver snapshots before this serve launch and awaits the bounded barrier before HTTP and functional cases', () => {
  const source = fs.readFileSync(path.join(__dirname, 'qualify-local-stack.cjs'), 'utf8');
  const snapshot = source.indexOf('const gatewayBaseline = captureGatewayBaseline(');
  const launch = source.indexOf('serve = spawn(', snapshot);
  const barrier = source.indexOf('await waitForNativeStartup(', launch);
  const http = source.indexOf("await ready(portalUrl, 'native')", barrier);
  const functional = source.indexOf(
    "await portalCases(portalUrl, 'actual-cli-serve', false)",
    http,
  );
  assert.ok(
    snapshot >= 0 && launch > snapshot && barrier > launch && http > barrier && functional > http,
  );
});
