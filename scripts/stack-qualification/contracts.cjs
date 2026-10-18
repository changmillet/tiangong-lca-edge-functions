'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ownerPattern = /^edge496-[a-f0-9]{24}$/u;
function assertOwner(owner) {
  assert.match(owner, ownerPattern);
  return owner;
}
function ownedEnvironment(root, inherited = process.env) {
  const result = {
    HOME: inherited.HOME,
    PATH: inherited.PATH,
    CI: 'true',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    DOCKER_CONFIG: path.join(root, 'docker'),
    npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_globalconfig: path.join(root, 'npm-globalrc'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    SUPABASE_HOME: path.join(root, 'supabase-home'),
    SUPABASE_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    SUPABASE_EXPERIMENTAL_STACK: '0',
    TMPDIR: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    COREPACK_HOME: path.join(root, 'corepack'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_store_dir: path.join(root, 'pnpm-store'),
    NO_PROXY: '127.0.0.1,localhost',
  };
  for (const value of Object.values(result)) assert.equal(typeof value, 'string');
  for (const key of [
    'DOCKER_CONFIG',
    'SUPABASE_HOME',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'COREPACK_HOME',
    'npm_config_cache',
    'npm_config_store_dir',
  ])
    fs.mkdirSync(result[key], { recursive: true });
  fs.writeFileSync(result.npm_config_userconfig, '');
  fs.writeFileSync(result.npm_config_globalconfig, '');
  return result;
}
function requireHostedLinux(env = process.env, platform = process.platform) {
  assert.equal(platform, 'linux', 'No local daemon use: qualification requires hosted Linux');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Qualification requires the owned hosted job');
}
function jwt(secret, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const wire = `${header}.${body}`;
  return `${wire}.${crypto.createHmac('sha256', secret).update(wire).digest('base64url')}`;
}
function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomUUID();
  return {
    privateKey,
    kid,
    signingKey: { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
    publicKey: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}
function asymmetricJwt(fixture, payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fixture.kid }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const wire = `${header}.${body}`;
  return `${wire}.${crypto.sign('sha256', Buffer.from(wire), fixture.privateKey).toString('base64url')}`;
}
function signedHeaders(body, overrides = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(body).digest('base64url');
  const canonical = [
    'portal-hmac-v1',
    'fixture',
    timestamp,
    nonce,
    'POST',
    '/functions/v1/portal',
    bodyHash,
  ].join('\n');
  return {
    'content-type': 'application/json',
    'x-portal-key-id': 'fixture',
    'x-portal-timestamp': timestamp,
    'x-portal-nonce': nonce,
    'x-portal-body-sha256': bodyHash,
    'x-portal-signature': crypto
      .createHmac('sha256', Buffer.alloc(32, 7))
      .update(canonical)
      .digest('base64url'),
    ...overrides,
  };
}
function functionsRoute(config) {
  const start = config.indexOf('  - name: functions-v1\n');
  assert.ok(start >= 0, 'Actual rendered Kong config has no Functions route');
  const end = config.indexOf('\n  - name:', start + 5);
  const block = config.slice(start, end < 0 ? undefined : end);
  assert.match(block, /sb-api-key/u);
  assert.doesNotMatch(block, /- "?Authorization:/u);
  return `_format_version: "2.1"\n_transform: true\nservices:\n${block}`;
}
function runtimeWorkingDirectory(runtime, fixture) {
  assert.equal(
    runtime.Config.WorkingDir,
    fixture,
    'Actual CLI runtime must select the owned project working directory',
  );
  return runtime.Config.WorkingDir;
}
function runtimeBinaryIdentity(output, fixture) {
  const match =
    /^edge-runtime ([0-9]+\.[0-9]+\.[0-9]+)\ndeno ([0-9]+\.[0-9]+\.[0-9]+) \(([^,()\n]+), ([^()\n]+)\)\n$/u.exec(
      output,
    );
  assert.ok(match, 'Unexpected Edge Runtime version output');
  assert.equal(match[0], output, 'Unexpected trailing Edge Runtime version output');
  const [, crateVersion, denoVersion, profile, target] = match;
  const expected = fixture.edgeRuntime.binary;
  assert.equal(crateVersion, expected.version, 'Edge Runtime crate version differs');
  assert.equal(denoVersion, fixture.edgeRuntime.denoVersion, 'Embedded Deno version differs');
  assert.equal(profile, expected.profile, 'Edge Runtime build profile differs');
  assert.equal(target, expected.target, 'Edge Runtime binary target differs');
  return { crateVersion, denoVersion, profile, target };
}
function workerVersionIdentity(actual, fixture) {
  assert.deepEqual(
    actual,
    fixture.edgeRuntime.worker.reportedVersion,
    'Worker version metadata differs',
  );
  return actual;
}
function serveExitIdentity(code, signal) {
  assert.ok(
    ((code === 0 || code === 130) && signal === null) || (code === null && signal === 'SIGINT'),
    'Unexpected native serve termination',
  );
  return { code, signal };
}
function assertNativeStopped(inventory) {
  assert.deepEqual(inventory.containers, [], 'Native stop left project containers');
  assert.deepEqual(inventory.volumes, [], 'Native stop --no-backup left project volumes');
}
async function chunkedPost(url, body, headers) {
  const request = http.request(url, { method: 'POST', headers });
  const result = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
  request.write(body.subarray(0, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  request.end(body.subarray(5));
  return await result;
}
async function freePort() {
  const server = require('node:net').createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
module.exports = {
  assertOwner,
  ownedEnvironment,
  requireHostedLinux,
  hash,
  jwt,
  signedHeaders,
  functionsRoute,
  chunkedPost,
  freePort,
  runtimeWorkingDirectory,
  runtimeBinaryIdentity,
  workerVersionIdentity,
  serveExitIdentity,
  assertNativeStopped,
  signingFixture,
  asymmetricJwt,
};
