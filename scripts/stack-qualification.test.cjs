'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  requireHostedLinux,
  assertOwner,
  ownedEnvironment,
  signedHeaders,
  hash,
  functionsRoute,
  runtimeWorkingDirectory,
} = require('./stack-qualification/contracts.cjs');
test('qualification refuses local daemon use and malformed resource ownership', () => {
  assert.throws(() => requireHostedLinux({ GITHUB_ACTIONS: 'true' }, 'darwin'));
  assert.throws(() => requireHostedLinux({}, 'linux'));
  requireHostedLinux({ GITHUB_ACTIONS: 'true' }, 'linux');
  for (const owner of ['', 'shared', 'edge496-../data', 'edge496-' + 'g'.repeat(24)])
    assert.throws(() => assertOwner(owner));
  assertOwner('edge496-' + 'a'.repeat(24));
});
test('owned environment preserves HOME and excludes inherited project/provider credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge496-env-'));
  try {
    const env = ownedEnvironment(root, {
      HOME: '/synthetic/home',
      PATH: '/synthetic/bin',
      SUPABASE_ACCESS_TOKEN: 'forbidden',
      OPENAI_API_KEY: 'forbidden',
      SUPABASE_EXPERIMENTAL_STACK: '1',
    });
    assert.equal(env.HOME, '/synthetic/home');
    assert.equal(env.SUPABASE_EXPERIMENTAL_STACK, '0');
    assert.equal(env.SUPABASE_ACCESS_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.DOCKER_CONFIG, path.join(root, 'docker'));
    assert.equal(env.npm_config_userconfig, path.join(root, 'npmrc'));
    assert.equal(fs.readFileSync(env.npm_config_userconfig, 'utf8'), '');
    assert.equal(env.SUPABASE_HOME, path.join(root, 'supabase-home'));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('request producer signs the canonical public path and exact raw bytes', () => {
  const bytes = Buffer.from('{ "steel": "钢" }\n');
  const headers = signedHeaders(bytes);
  const canonical = [
    'portal-hmac-v1',
    'fixture',
    headers['x-portal-timestamp'],
    headers['x-portal-nonce'],
    'POST',
    '/functions/v1/portal',
    headers['x-portal-body-sha256'],
  ].join('\n');
  assert.equal(
    headers['x-portal-signature'],
    crypto.createHmac('sha256', Buffer.alloc(32, 7)).update(canonical).digest('base64url'),
  );
  assert.notEqual(headers['x-portal-body-sha256'], hash(Buffer.concat([bytes, Buffer.from(' ')])));
});
test('actual rendered Functions extraction retains nested routes and excludes unrelated services', () => {
  const input =
    '_format_version: "2.1"\nservices:\n  - name: functions-v1\n    routes:\n      - name: functions-v1-all\n        strip_path: true\n    plugins:\n      - name: request-transformer\n        config:\n          add:\n            headers:\n              - "sb-api-key: synthetic"\n  - name: unrelated-auth\n    url: http://auth:9999\n';
  const output = functionsRoute(input);
  assert.match(output, /functions-v1-all/u);
  assert.match(output, /strip_path: true/u);
  assert.doesNotMatch(output, /unrelated-auth/u);
});

test('offline runtime preserves the actual CLI project cwd for relative entrypoints', () => {
  const fixture = '/owned/fixture';
  assert.equal(runtimeWorkingDirectory({ Config: { WorkingDir: fixture } }, fixture), fixture);
  assert.throws(() => runtimeWorkingDirectory({ Config: { WorkingDir: '/' } }, fixture));
  assert.throws(() =>
    runtimeWorkingDirectory({ Config: { WorkingDir: '/other-project' } }, fixture),
  );
});

const { terminateOwnedGroup } = require('./stack-qualification/process.cjs');
test('recovery waits and escalates when the owned supervisor ignores SIGINT', async () => {
  let alive = true;
  const signals = [];
  const proof = await terminateOwnedGroup(
    { root: '/owned', servePid: 1234 },
    {
      members: () => (alive ? [{ pid: 1234, cwd: '/owned/fixture' }] : []),
      signal: (name) => {
        signals.push(name);
        if (name === 'SIGTERM') alive = false;
      },
      pause: () => Promise.resolve(),
      attempts: 2,
    },
  );
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);
  assert.equal(proof.complete, true);
});
test('recovery refuses a foreign process identity and never certifies a surviving group', async () => {
  await assert.rejects(
    () =>
      terminateOwnedGroup(
        { root: '/owned', servePid: 1234 },
        {
          members: () => [{ pid: 1234, cwd: '/foreign' }],
          signal: () => {
            throw new Error('must not signal');
          },
          pause: () => Promise.resolve(),
          attempts: 1,
        },
      ),
    /identity differs/u,
  );
  await assert.rejects(
    () =>
      terminateOwnedGroup(
        { root: '/owned', servePid: 1234 },
        {
          members: () => [{ pid: 1234, cwd: '/owned/fixture' }],
          signal: () => {},
          pause: () => Promise.resolve(),
          attempts: 1,
        },
      ),
    /remains alive/u,
  );
});

const { signingFixture, asymmetricJwt } = require('./stack-qualification/contracts.cjs');
test('synthetic gateway tokens verify only against their own public RS256 JWK', () => {
  const keys = signingFixture();
  const token = asymmetricJwt(keys, { sub: 'fixture', exp: 1800000000 });
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, keys.kid);
  const publicKey = crypto.createPublicKey({ key: keys.publicKey, format: 'jwk' });
  assert.equal(
    crypto.verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  assert.equal(
    crypto.verify(
      'sha256',
      Buffer.from(`${header}.${payload}changed`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
    false,
  );
  assert.equal(keys.publicKey.d, undefined);
});

// Both selected CLI versions ignore signing_keys_path when auth is disabled.
// Render the actual producer template so a public-key assertion cannot be
// accidentally disconnected from its input while Auth stays excluded.
test('fixture loads its configured signing key while excluding the Auth service', () => {
  const source = fs.readFileSync(path.join(__dirname, 'qualify-local-stack.cjs'), 'utf8');
  const template = source.match(/const config = (`[^`]+`);/u)?.[1];
  assert.ok(template, 'Actual CLI fixture config template is missing');
  const config = require('node:vm').runInNewContext(
    template,
    {
      project: 'ownedfixture',
      apiPort: 54321,
      dbPort: 54322,
      shadowPort: 54320,
      synthetic: {
        secret: 'synthetic-secret',
        publishable: 'synthetic-public',
        service: 'synthetic-service',
      },
      anon: 'synthetic-anon',
      serviceRole: 'synthetic-role',
    },
    { timeout: 1000 },
  );
  const auth = config.match(/\[auth\]\n([\s\S]*?)(?=\n\[|$)/u)?.[1];
  assert.ok(auth);
  assert.match(
    auth,
    /^enabled = true$/mu,
    'The real CLI must read the configured RSA signing file',
  );
  assert.match(auth, /^signing_keys_path = "\.\/signing-keys\.json"$/mu);
  const excludes = source.match(/const excludes =\s*'([^']+)';/u)?.[1].split(',');
  assert.ok(excludes?.includes('gotrue'), 'Auth configuration must not start the Auth service');
  assert.match(
    source,
    /cli\(\['start', '--debug', '--exclude', excludes, '--network-id', network\]\)/u,
  );
});
