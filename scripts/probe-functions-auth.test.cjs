const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseArgs, resolveBaseUrl } = require('./probe-functions-auth.cjs');

const scriptPath = path.join(__dirname, 'probe-functions-auth.cjs');
const examplePath = path.join(__dirname, '..', '.env.example');
const local = 'http://127.0.0.1:54321/functions/v1';
const remote = 'https://remote.example.invalid/functions/v1';

function cli(t, args = [], env = {}, envFile = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-auth-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts');
  const functions = path.join(root, 'supabase', 'functions', 'probe_fixture');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(functions, { recursive: true });
  fs.copyFileSync(scriptPath, path.join(scripts, 'probe-functions-auth.cjs'));
  fs.writeFileSync(path.join(root, '.env'), envFile);
  fs.writeFileSync(path.join(functions, 'index.ts'), '// allowedMethods: [AuthMethod.JWT]\n');
  const capture = path.join(root, 'requests.jsonl');
  const preload = path.join(root, 'fetch-fixture.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
     globalThis.fetch = async (url, options) => {
       fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({url: String(url), redirect: options.redirect}) + '\\n');
       if (process.env.REDIRECT_FIXTURE_TARGET) {
         if (options.redirect !== 'manual') {
           fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({url: process.env.REDIRECT_FIXTURE_TARGET}) + '\\n');
           return new Response('{"ok":true}', {status: 200});
         }
         return new Response(null, {status: 302, headers: {location: process.env.REDIRECT_FIXTURE_TARGET}});
       }
       return new Response('{"ok":true}', {status: 200});
     };`,
  );
  const result = spawnSync(
    process.execPath,
    ['--require', preload, path.join(scripts, 'probe-functions-auth.cjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    },
  );
  const requests = fs.existsSync(capture)
    ? fs
        .readFileSync(capture, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { ...result, requests };
}

function assertNoDispatch(result, message) {
  assert.equal(result.status, 1);
  assert.deepEqual(result.requests, []);
  assert.match(result.stderr, message);
}

test('copied generic example makes an unqualified real probe local', (t) => {
  const example = fs.readFileSync(examplePath, 'utf8');
  assert.doesNotMatch(example, /qgzvkongdjqiiamzbbts|submidrhbtknjxfympna/);
  const result = cli(t, [], {}, example);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.requests.length > 0);
  assert.ok(result.requests.every(({ url }) => url === `${local}/probe_fixture`));
});

test('an existing example with remote and local URLs still defaults to loopback', (t) => {
  const result = cli(t, [], {}, `REMOTE_ENDPOINT=${remote}\nLOCAL_ENDPOINT=${local}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.requests.every(({ url }) => url === `${local}/probe_fixture`));
});

test('explicit local target works without displaying credential values', (t) => {
  const credential = 'synthetic-user-credential-never-log';
  const result = cli(t, ['--local'], {
    LOCAL_ENDPOINT: local,
    REMOTE_ENDPOINT: remote,
    USER_JWT: credential,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests.every(({ url }) => url === `${local}/probe_fixture`));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential));
});

test('explicit configured remote and explicit base URL work with mocked fetch', (t) => {
  for (const [args, env] of [
    [['--remote'], { REMOTE_ENDPOINT: remote, LOCAL_ENDPOINT: local }],
    [['--base-url', 'https://remote.example.invalid/'], { LOCAL_ENDPOINT: local }],
  ]) {
    const result = cli(t, args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.requests.length > 0);
    assert.ok(result.requests.every(({ url }) => url === `${remote}/probe_fixture`));
  }
});

test('a selected missing endpoint never falls through to another target', (t) => {
  assertNoDispatch(cli(t, ['--remote'], { LOCAL_ENDPOINT: local }), /--remote requires/);
  assertNoDispatch(
    cli(t, ['--remote'], { REMOTE_ENDPOINT: '  ', LOCAL_ENDPOINT: local }),
    /--remote requires/,
  );
  assertNoDispatch(cli(t, ['--local'], { REMOTE_ENDPOINT: remote }), /--local requires/);
  assertNoDispatch(cli(t, [], { REMOTE_ENDPOINT: remote }), /Missing local base URL/);
});

test('implicit non-loopback aliases and remote-valued local selection fail closed', (t) => {
  for (const env of [{ EDGE_BASE_URL: remote }, { BASE_URL: remote }, { LOCAL_ENDPOINT: remote }]) {
    assertNoDispatch(cli(t, [], env), /loopback URL/);
  }
  assertNoDispatch(cli(t, ['--local'], { LOCAL_ENDPOINT: remote }), /loopback URL/);
});

test('conflicting, duplicate and missing target flags fail before fetch', (t) => {
  for (const args of [
    ['--remote', '--local'],
    ['--remote', '--base-url', remote],
    ['--local', '--base-url', local],
    ['--remote', '--remote'],
    ['--base-url', local, '--base-url', remote],
  ]) {
    assertNoDispatch(cli(t, args), /Choose only one target/);
  }
  for (const args of [['--base-url'], ['--base-url', '--remote'], ['--base-url', '  ']]) {
    assertNoDispatch(cli(t, args), /requires a non-empty URL/);
  }
});

test('invalid or credential-bearing explicit URLs fail without logging their contents', (t) => {
  for (const url of [
    'not-a-url',
    'file:///tmp/private-target',
    'https://user:synthetic-private-value@remote.example.invalid',
    `${remote}?token=synthetic-private-value`,
    `${remote}#synthetic-private-value`,
  ]) {
    const result = cli(t, ['--base-url', url]);
    assertNoDispatch(result, /Probe base URL/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-private-value'));
  }
});

test('resolver accepts only loopback for automatic legacy aliases', () => {
  for (const url of ['http://localhost:54321/', 'http://127.0.0.2:54321/', 'http://[::1]:54321/']) {
    const result = resolveBaseUrl(parseArgs([]), { EDGE_BASE_URL: url });
    assert.ok(result.endsWith('/functions/v1'));
  }
  for (const url of ['http://localhost.example.invalid/', 'http://127.0.0.1.example.invalid/']) {
    assert.throws(() => resolveBaseUrl(parseArgs([]), { LOCAL_ENDPOINT: url }), /loopback URL/);
  }
});

test('targetless dry-run remains an offline inventory operation', (t) => {
  const result = cli(t, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests, []);
  assert.match(result.stdout, /dry-run only/);
});

test('probe observes a redirect without following an unselected remote destination', (t) => {
  const result = cli(t, ['--local'], {
    LOCAL_ENDPOINT: local,
    REDIRECT_FIXTURE_TARGET: remote,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, `${local}/probe_fixture`);
  assert.equal(result.requests[0].redirect, 'manual');
  assert.match(result.stdout, /302\/reachable_other_client_error/);
});

test('unknown and malformed numeric arguments do not echo private values', (t) => {
  const privateValue = 'synthetic-private-argument';
  for (const args of [
    [`--base-url=https://user:${privateValue}@remote.example.invalid`],
    [privateValue],
    ['--timeout-ms', privateValue],
    ['--concurrency', privateValue],
  ]) {
    const result = cli(t, args);
    assert.equal(result.status, 1);
    assert.deepEqual(result.requests, []);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue));
  }
});
