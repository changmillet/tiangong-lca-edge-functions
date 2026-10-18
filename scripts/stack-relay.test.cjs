'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const {
  ownedRelayTarget,
  createOwnedRelay,
  assertLoopbackReleased,
} = require('./stack-qualification/relay.cjs');
const owner = 'edge496-' + 'a'.repeat(24);
const project = owner.replaceAll('-', '');
const containerId = 'b'.repeat(64);
function fixture() {
  const network = {
    Id: 'owned-network',
    Name: owner + '-cli',
    Internal: true,
    Driver: 'bridge',
    Labels: { 'edge496.owner': owner },
    Containers: { [containerId]: { IPv4Address: '172.20.0.2/16' } },
  };
  const container = {
    Id: containerId,
    Name: '/supabase_db_' + project,
    State: { Running: true },
    Config: { Labels: { 'com.supabase.cli.project': project } },
    NetworkSettings: {
      Networks: { [network.Name]: { NetworkID: network.Id, IPAddress: '172.20.0.2' } },
    },
  };
  const expected = { owner, project, kind: 'cli', name: container.Name.slice(1), port: 5432 };
  return { container, network, expected };
}
test('relay targets require the exact owned container label and sole internal endpoint', () => {
  const f = fixture();
  assert.equal(ownedRelayTarget(f.container, f.network, f.expected).containerId, containerId);
  const pair = fixture();
  const endpoint = pair.container.NetworkSettings.Networks[pair.network.Name];
  pair.network.Name = owner + '-pair';
  pair.container.NetworkSettings.Networks = { [pair.network.Name]: endpoint };
  pair.container.Config.Labels = { 'edge496.owner': owner };
  pair.expected.kind = 'pair';
  assert.equal(ownedRelayTarget(pair.container, pair.network, pair.expected).labelValue, owner);
  for (const mutate of [
    (x) => (x.container.Config.Labels['com.supabase.cli.project'] = 'foreign'),
    (x) => (x.container.Id = 'c'.repeat(64)),
    (x) => (x.container.State.Running = false),
    (x) => (x.network.Internal = false),
    (x) => (x.network.Labels['edge496.owner'] = 'foreign'),
    (x) => (x.container.NetworkSettings.Networks.other = {}),
    (x) => (x.container.NetworkSettings.Networks[x.network.Name].IPAddress = '172.20.0.3'),
    (x) => (x.container.NetworkSettings.Networks[x.network.Name].NetworkID = 'foreign'),
  ]) {
    const changed = fixture();
    mutate(changed);
    assert.throws(() => ownedRelayTarget(changed.container, changed.network, changed.expected));
  }
});

test(
  'active byte traffic cannot outlive the absolute relay lifetime',
  { timeout: 5000 },
  async () => {
    let peer;
    const server = net.createServer((socket) => {
      peer = socket;
      socket.on('error', () => {});
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const port = await listen(server);
    const relay = await createOwnedRelay({
      resolveTarget: () => target(port),
      idleMs: 1000,
      lifetimeMs: 80,
    });
    const client = net.createConnection({ host: '127.0.0.1', port: relay.snapshot().port });
    client.on('error', () => {});
    client.on('data', () => {});
    let heartbeat;
    try {
      await once(client, 'connect');
      heartbeat = setInterval(() => client.write('still-active'), 10);
      await once(client, 'close');
      assert.ok(relay.snapshot().failures.some((failure) => failure.phase === 'lifetime'));
      assert.equal(
        relay.snapshot().failures.some((failure) => failure.phase === 'idle'),
        false,
      );
    } finally {
      clearInterval(heartbeat);
      client.destroy();
      peer?.destroy();
      await relay.close();
      await closeServer(server);
    }
    await assertLoopbackReleased([relay.snapshot().port]);
  },
);
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function target(port) {
  return { containerId, ip: '127.0.0.1', port };
}
test(
  'opaque relay preserves backpressure, arbitrary bytes and request half-close with a late response',
  { timeout: 10000 },
  async () => {
    const request = crypto.randomBytes(4 * 1024 * 1024);
    const response = crypto.randomBytes(2 * 1024 * 1024);
    let received;
    let peer;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      peer = socket;
      const chunks = [];
      socket.pause();
      setTimeout(() => socket.resume(), 30);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        received = Buffer.concat(chunks);
        setTimeout(() => socket.end(response), 10);
      });
    });
    const port = await listen(server);
    const relay = await createOwnedRelay({ resolveTarget: () => target(port) });
    const client = net.createConnection({
      host: '127.0.0.1',
      port: relay.snapshot().port,
      allowHalfOpen: true,
    });
    const chunks = [];
    client.on('data', (chunk) => chunks.push(chunk));
    try {
      await once(client, 'connect');
      assert.equal(
        client.write(request),
        false,
        'large request must encounter writable backpressure',
      );
      client.end();
      await once(client, 'close');
      assert.deepEqual(received, request);
      assert.deepEqual(Buffer.concat(chunks), response);
    } finally {
      client.destroy();
      peer?.destroy();
      await relay.close();
      await closeServer(server);
    }
    const proof = relay.snapshot();
    assert.equal(proof.host, '127.0.0.1');
    assert.equal(proof.clientBytesRead, request.length);
    assert.equal(proof.upstreamBytesWritten, request.length);
    assert.equal(proof.upstreamBytesRead, response.length);
    assert.equal(proof.clientBytesWritten, response.length);
    assert.deepEqual(proof.failures, []);
    assert.equal(proof.activeSockets, 0);
    await assertLoopbackReleased([proof.port]);
  },
);
test(
  'client abort and upstream reset terminate the opposite socket without leaving a listener',
  { timeout: 5000 },
  async () => {
    for (const abortClient of [true, false]) {
      let peer;
      let peerClosed;
      const server = net.createServer((socket) => {
        peer = socket;
        peerClosed = new Promise((resolve) => socket.once('close', resolve));
        socket.on('error', () => {});
        socket.on('data', () => {
          if (abortClient) socket.write('ready');
          else socket.resetAndDestroy();
        });
      });
      const port = await listen(server);
      const relay = await createOwnedRelay({ resolveTarget: () => target(port) });
      const client = net.createConnection({ host: '127.0.0.1', port: relay.snapshot().port });
      client.on('error', () => {});
      try {
        await once(client, 'connect');
        const closed = new Promise((resolve) => client.once('close', resolve));
        client.write('owned-request');
        if (abortClient) {
          await once(client, 'data');
          client.resetAndDestroy();
        }
        await closed;
        await peerClosed;
      } finally {
        client.destroy();
        peer?.destroy();
        await relay.close();
        await closeServer(server);
      }
      await assertLoopbackReleased([relay.snapshot().port]);
    }
  },
);
test(
  'endpoint replacement and stalled sockets fail closed and cleanup closes active connections',
  { timeout: 5000 },
  async () => {
    const peers = new Set();
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.on('close', () => peers.delete(socket));
      socket.on('data', () => socket.write('ready'));
    });
    const port = await listen(server);
    let identity = target(port);
    const relay = await createOwnedRelay({
      resolveTarget: () => identity,
      idleMs: 100,
      lifetimeMs: 1000,
    });
    const clients = [];
    try {
      const first = net.createConnection({ host: '127.0.0.1', port: relay.snapshot().port });
      clients.push(first);
      const firstClosed = new Promise((resolve) => first.once('close', resolve));
      first.on('error', () => {});
      await once(first, 'connect');
      first.write('one');
      await once(first, 'data');
      identity = { ...identity, containerId: 'c'.repeat(64) };
      const replaced = net.createConnection({ host: '127.0.0.1', port: relay.snapshot().port });
      clients.push(replaced);
      replaced.on('error', () => {});
      await once(replaced, 'close');
      await firstClosed;
      assert.ok(relay.snapshot().failures.some((x) => x.phase === 'identity'));
      assert.ok(relay.snapshot().failures.some((x) => x.phase === 'idle'));
      identity = target(port);
      const active = net.createConnection({ host: '127.0.0.1', port: relay.snapshot().port });
      clients.push(active);
      active.on('error', () => {});
      await once(active, 'connect');
      active.write('active');
      await once(active, 'data');
      await assert.rejects(() => assertLoopbackReleased([relay.snapshot().port]), {
        code: 'EADDRINUSE',
      });
      await relay.close();
      assert.equal(relay.snapshot().activeSockets, 0);
    } finally {
      for (const client of clients) client.destroy();
      for (const peer of peers) peer.destroy();
      await relay.close();
      await closeServer(server);
    }
    await assertLoopbackReleased([relay.snapshot().port]);
  },
);
