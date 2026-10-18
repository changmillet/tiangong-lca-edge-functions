'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectFailureDiagnostics } = require('./stack-qualification/diagnostics.cjs');
const owner = 'edge496-' + 'a'.repeat(24);
const project = owner.replaceAll('-', '');
function info(name) {
  return {
    Id: 'b'.repeat(64),
    Name: '/' + name,
    Image: 'owned-image',
    State: {
      Running: false,
      ExitCode: 1,
      Error: 'synthetic-secret',
      Health: {
        Status: 'unhealthy',
        Log: Array(10).fill({ ExitCode: 1, Output: 'synthetic-secret'.repeat(1000) }),
      },
    },
    Config: {
      Labels: name.startsWith('supabase_')
        ? { 'com.supabase.cli.project': project }
        : { 'edge496.owner': owner },
      Env: ['SECRET=never-copy'],
    },
    NetworkSettings: { Networks: {}, Ports: {} },
    HostConfig: { PortBindings: {} },
  };
}
test('failure diagnostics bind full owned IDs, retain crashed state, sanitize and bound logs', () => {
  const calls = [];
  const writes = {};
  const result = collectFailureDiagnostics({
    owner,
    project,
    sanitize: (value) => value.replaceAll('synthetic-secret', '[redacted]'),
    write: (name, value) => {
      writes[name] = value;
    },
    execute: (args) => {
      calls.push(args);
      return args[0] === 'container'
        ? { status: 0, stdout: JSON.stringify([info(args[2])]) }
        : { status: 0, stdout: 'synthetic-secret'.repeat(10000), stderr: 'synthetic-secret' };
    },
  });
  assert.ok(result.every((x) => x.present));
  assert.deepEqual(
    calls.filter((x) => x[0] === 'logs'),
    Array(4).fill(['logs', '--tail', '100', 'b'.repeat(64)]),
  );
  assert.equal(writes['failure-native-runtime-state.json'].state.ExitCode, 1);
  assert.equal(writes['failure-native-runtime-state.json'].state.Health.Log.length, 5);
  assert.ok(
    writes['failure-native-runtime-state.json'].state.Health.Log.every(
      (x) => x.Output.length <= 4096,
    ),
  );
  assert.ok(writes['failure-native-runtime-logs.json'].stdout.length <= 65536);
  assert.doesNotMatch(JSON.stringify(writes), /synthetic-secret|never-copy/u);
});
test('foreign labels, mismatched names and malformed IDs never permit reading container logs', () => {
  for (const mutate of [
    (x) => {
      for (const key of Object.keys(x.Config.Labels)) x.Config.Labels[key] = 'foreign';
    },
    (x) => {
      x.Name = '/foreign';
    },
    (x) => {
      x.Id = 'short';
    },
  ]) {
    let logs = 0;
    const result = collectFailureDiagnostics({
      owner,
      project,
      sanitize: (x) => x,
      write: () => {},
      execute: (args) => {
        if (args[0] === 'logs') {
          logs++;
          throw new Error('must not read');
        }
        const data = info(args[2]);
        mutate(data);
        return { status: 0, stdout: JSON.stringify([data]) };
      },
    });
    assert.equal(logs, 0);
    assert.ok(result.every((x) => x.error));
  }
});
test('diagnostic absence and collection errors remain evidence rather than hiding primary cleanup', () => {
  const writes = {};
  const result = collectFailureDiagnostics({
    owner,
    project,
    sanitize: (x) => x,
    write: (n, v) => {
      writes[n] = v;
    },
    execute: (args) => {
      if (args[2].includes('edge_runtime')) return { status: 1, stderr: 'not present' };
      throw new Error('bounded inspection failed');
    },
  });
  assert.equal(result[0].present, false);
  assert.match(result[1].error, /bounded inspection failed/u);
  assert.deepEqual(writes['failure-diagnostics.json'], result);
});
