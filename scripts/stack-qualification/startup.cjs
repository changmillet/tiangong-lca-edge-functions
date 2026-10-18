'use strict';
const { createHash } = require('node:crypto');
const digest = (value) => createHash('sha256').update(value).digest('hex');
function failure(code) {
  return Object.assign(new Error(`Owned native startup proof failed: ${code}`), {
    code,
    startupProof: true,
  });
}
function requireFact(condition, code) {
  if (!condition) throw failure(code);
}
function buffers(streams) {
  requireFact(
    typeof streams?.stdout === 'string' && typeof streams?.stderr === 'string',
    'gateway_log_missing',
  );
  const result = Object.fromEntries(
    Object.entries(streams).map(([key, value]) => [key, Buffer.from(value)]),
  );
  requireFact(result.stdout.length + result.stderr.length <= 1024 * 1024, 'gateway_log_limit');
  requireFact(
    Object.values(result).every((value) => value.length === 0 || value.at(-1) === 10),
    'gateway_log_incomplete',
  );
  return result;
}
function cursors(streams) {
  return Object.fromEntries(
    Object.entries(streams).map(([stream, value]) => [
      stream,
      { bytes: value.length, sha256: digest(value) },
    ]),
  );
}
// Exact Kong 2.8.1 / OpenResty 1.19.9.1 producer grammar:
// Kong .requirements, kong/init.lua:426 and the release bundle's ngx_process*.c.
function records(streams) {
  const result = [];
  for (const [stream, raw] of Object.entries(streams)) {
    let offset = 0;
    for (const line of raw.toString('utf8').split('\n')) {
      const match =
        /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(?:notice|alert)\] ([1-9]\d*)#\d+: (.*)$/u.exec(
          line,
        );
      if (match) {
        const [, pid, message] = match;
        const record = { stream, offset, pid };
        let detail;
        if (message.startsWith('openresty/')) {
          requireFact(message === 'openresty/1.19.9.1', 'gateway_version_unexpected');
          result.push({ ...record, type: 'banner' });
        } else if (message === 'start worker processes') result.push({ ...record, type: 'batch' });
        else if ((detail = /^start worker process ([1-9]\d*)$/u.exec(message)))
          result.push({ ...record, type: 'start', worker: detail[1] });
        else if (
          /^\*\d+ \[kong\] init\.lua:426 declarative config loaded from \/home\/kong\/kong\.yml, context: init_worker_by_lua\*$/u.test(
            message,
          )
        )
          result.push({ ...record, type: 'loaded' });
        else if (/^signal 1 \(SIGHUP\) received from [1-9]\d*, reconfiguring$/u.test(message))
          result.push({ ...record, type: 'hup' });
        else if (message === 'reconfiguring') result.push({ ...record, type: 'reconfigure' });
        else if ((detail = /^worker process ([1-9]\d*) exited with code (\d+)$/u.exec(message)))
          result.push({ ...record, type: 'exit', worker: detail[1], code: Number(detail[2]) });
        else if (/^worker process [1-9]\d* exited on signal /u.test(message))
          throw failure('gateway_worker_signalled');
      }
      offset += Buffer.byteLength(line) + 1;
    }
  }
  return result;
}
function kongIdentity(info, expected) {
  requireFact(
    info?.Id === expected.id &&
      info?.Name === '/' + expected.name &&
      info?.Image === expected.image &&
      info?.State?.Running === true &&
      info?.Config?.Labels?.['com.supabase.cli.project'] === expected.project,
    'gateway_identity_changed',
  );
  requireFact(
    info.RestartCount === 0 &&
      typeof info.State.StartedAt === 'string' &&
      info.State.StartedAt.length > 0,
    'gateway_restarted',
  );
  requireFact(
    info.Config.Env.filter((value) => value.startsWith('KONG_NGINX_WORKER_PROCESSES=')).length ===
      1 && info.Config.Env.includes('KONG_NGINX_WORKER_PROCESSES=1'),
    'gateway_worker_count_unexpected',
  );
  const networks = info.NetworkSettings?.Networks;
  requireFact(
    networks && Object.keys(networks).length === 1 && networks[expected.network],
    'gateway_network_changed',
  );
  return {
    id: info.Id,
    image: info.Image,
    startedAt: info.State.StartedAt,
    restartCount: info.RestartCount,
    networkId: networks[expected.network].NetworkID,
    ip: networks[expected.network].IPAddress,
  };
}
function captureGatewayBaseline(info, streams, expected) {
  const identity = kongIdentity(info, expected);
  const prefix = buffers(streams);
  const events = records(prefix);
  const banners = events.filter((event) => event.type === 'banner');
  const starts = events.filter((event) => event.type === 'start');
  requireFact(
    banners.length === 1 &&
      starts.length === 1 &&
      events.filter((event) => event.type === 'batch').length === 1 &&
      !events.some((event) => ['hup', 'reconfigure', 'exit'].includes(event.type)),
    'gateway_baseline_generation_missing',
  );
  const master = banners[0].pid;
  const worker = starts[0].worker;
  requireFact(
    starts[0].pid === master &&
      events.some((event) => event.type === 'loaded' && event.pid === worker) &&
      events.every((event) => event.pid === (event.type === 'loaded' ? worker : master)) &&
      events.every((event) => event.stream === banners[0].stream),
    'gateway_baseline_not_loaded',
  );
  return {
    expected,
    identity,
    prefix,
    master,
    worker,
    stream: banners[0].stream,
    receipt: { identity, master, oldWorker: worker, cursors: cursors(prefix), events },
  };
}
function gatewayGeneration(baseline, info, streams, serveLog) {
  requireFact(
    JSON.stringify(kongIdentity(info, baseline.expected)) === JSON.stringify(baseline.identity),
    'gateway_identity_changed',
  );
  requireFact(typeof serveLog === 'string', 'serve_log_missing');
  requireFact(!/^Warning: failed to reload Kong:/mu.test(serveLog), 'gateway_reload_failed');
  const current = buffers(streams);
  const suffix = {};
  for (const stream of ['stdout', 'stderr']) {
    const prefix = baseline.prefix[stream];
    requireFact(
      current[stream].subarray(0, prefix.length).equals(prefix),
      'gateway_log_history_lost',
    );
    suffix[stream] = current[stream].subarray(prefix.length);
  }
  const events = records(suffix);
  requireFact(
    events.every((event) => event.stream === baseline.stream),
    'gateway_log_stream_changed',
  );
  requireFact(!events.some((event) => event.type === 'banner'), 'gateway_extra_generation');
  const hups = events.filter((event) => event.type === 'hup');
  const batches = events.filter((event) => event.type === 'batch');
  const starts = events.filter((event) => event.type === 'start');
  requireFact(
    hups.length <= 1 &&
      batches.length <= 1 &&
      starts.length <= 1 &&
      events.filter((event) => event.type === 'reconfigure').length <= 1,
    'gateway_extra_generation',
  );
  requireFact(hups.length || events.length === 0, 'gateway_event_order_unexpected');
  requireFact(
    events
      .filter((event) => event.type !== 'loaded')
      .every((event) => event.pid === baseline.master),
    'gateway_master_changed',
  );
  for (const event of events.filter((event) => event.type === 'exit')) {
    requireFact(
      event.worker === baseline.worker && event.code === 0,
      'gateway_worker_exit_unexpected',
    );
  }
  const worker = starts[0]?.worker;
  requireFact(!worker || worker !== baseline.worker, 'gateway_worker_reused');
  requireFact(
    !worker ||
      events.filter((event) => event.type === 'loaded').every((event) => event.pid === worker),
    'gateway_extra_generation',
  );
  const loaded = worker && events.some((event) => event.type === 'loaded' && event.pid === worker);
  const reaped = events.some((event) => event.type === 'exit' && event.worker === baseline.worker);
  requireFact(
    !hups.length || events.every((event) => event.offset >= hups[0].offset),
    'gateway_event_order_unexpected',
  );
  const ready =
    hups.length === 1 &&
    batches.length === 1 &&
    events.some((event) => event.type === 'reconfigure') &&
    Boolean(loaded) &&
    reaped;
  return {
    ready,
    reason: ready ? 'gateway_generation_complete' : 'gateway_generation_pending',
    master: baseline.master,
    oldWorker: baseline.worker,
    newWorker: worker ?? null,
    newWorkerLoaded: Boolean(loaded),
    oldWorkerReaped: reaped,
    cursors: cursors(current),
    events,
  };
}
async function waitForNativeStartup({
  baseline,
  runtime,
  probe,
  alive,
  record,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
}) {
  for (let attempt = 1; attempt <= 150; attempt++) {
    requireFact(alive(), 'serve_exited_during_startup');
    const deadline = now() + 1000;
    const remaining = () => {
      const value = Math.ceil(deadline - now());
      if (value <= 0) throw failure('native_startup_probe_timeout');
      return value;
    };
    try {
      const frame = await probe(remaining);
      remaining();
      requireFact(alive(), 'serve_exited_during_startup');
      const gateway = gatewayGeneration(baseline, frame.kong, frame.logs, frame.serveLog);
      const replacement = frame.runtime;
      if (replacement)
        requireFact(
          replacement.Name === '/' + runtime.name &&
            /^[a-f0-9]{64}$/u.test(replacement.Id) &&
            replacement.Id !== runtime.beforeId &&
            replacement.Image === runtime.image &&
            replacement.Config?.Labels?.['com.supabase.cli.project'] === baseline.expected.project,
          'runtime_identity_unexpected',
        );
      const runtimeReady =
        replacement?.State?.Running === true &&
        replacement.Config.Env.some((value) =>
          value.startsWith('PORTAL_SUPABASE_PUBLISHABLE_KEY='),
        );
      const observation = {
        attempt,
        ready: Boolean(runtimeReady && gateway.ready),
        runtimeId: replacement?.Id ?? null,
        runtimeReady: Boolean(runtimeReady),
        gateway,
      };
      record(observation);
      if (observation.ready) return observation;
    } catch (error) {
      const timeout =
        error.code === 'native_startup_probe_timeout' || error.cause?.code === 'ETIMEDOUT';
      record({
        attempt,
        ready: false,
        reason: timeout
          ? 'native_startup_probe_timeout'
          : error.startupProof === true
            ? error.code
            : 'native_startup_probe_failed',
      });
      if (!timeout) throw error;
    }
    if (attempt < 150) await pause(200);
  }
  throw failure('native_startup_timeout');
}
module.exports = { captureGatewayBaseline, gatewayGeneration, waitForNativeStartup };
