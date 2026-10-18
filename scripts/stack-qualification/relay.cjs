'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const { assertOwner } = require('./contracts.cjs');

// Docker's internal bridge has no host port publishing. Only the host-side
// qualification client may reach these exact owned endpoints through a relay.
function ownedRelayTarget(container, network, expected) {
  assertOwner(expected.owner);
  assert.equal(expected.project, expected.owner.replaceAll('-', ''));
  assert.ok(['cli', 'pair'].includes(expected.kind));
  assert.equal(network.Name, `${expected.owner}-${expected.kind}`);
  assert.equal(network.Internal, true);
  assert.equal(network.Driver, 'bridge');
  assert.equal(network.Labels['edge496.owner'], expected.owner);
  assert.equal(container.Name, '/' + expected.name);
  assert.match(container.Id, /^[a-f0-9]{64}$/u);
  assert.equal(container.State.Running, true);
  const label = expected.kind === 'cli' ? 'com.supabase.cli.project' : 'edge496.owner';
  const value = expected.kind === 'cli' ? expected.project : expected.owner;
  assert.equal(container.Config.Labels[label], value);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [network.Name]);
  const endpoint = container.NetworkSettings.Networks[network.Name];
  assert.equal(endpoint.NetworkID, network.Id);
  assert.equal(net.isIP(endpoint.IPAddress), 4);
  assert.equal(network.Containers[container.Id].IPv4Address.split('/')[0], endpoint.IPAddress);
  assert.ok(Number.isInteger(expected.port) && expected.port > 0 && expected.port <= 65535);
  return {
    containerId: container.Id,
    name: expected.name,
    label,
    labelValue: value,
    networkId: network.Id,
    networkName: network.Name,
    ip: endpoint.IPAddress,
    port: expected.port,
  };
}

async function createOwnedRelay({ port = 0, resolveTarget, idleMs = 120000, lifetimeMs = 180000 }) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  assert.ok(idleMs > 0 && lifetimeMs > 0);
  const sockets = new Set();
  const proof = {
    host: '127.0.0.1',
    port: null,
    target: null,
    connections: 0,
    clientBytesRead: 0,
    clientBytesWritten: 0,
    upstreamBytesRead: 0,
    upstreamBytesWritten: 0,
    failures: [],
    closed: false,
  };
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    proof.connections++;
    client.pause();
    let upstream;
    let terminal = false;
    const fail = (phase, error) => {
      if (!terminal) proof.failures.push({ phase, code: error.code ?? error.name });
      terminal = true;
      client.destroy();
      upstream?.destroy();
    };
    const deadline = setTimeout(
      () => fail('lifetime', new Error('Relay lifetime expired')),
      lifetimeMs,
    );
    const track = (socket, side) => {
      sockets.add(socket);
      socket.setTimeout(idleMs, () => fail('idle', new Error('Relay idle timeout')));
      socket.on('error', (error) => fail(side, error));
      socket.once('close', (hadError) => {
        sockets.delete(socket);
        proof[side + 'BytesRead'] += socket.bytesRead;
        proof[side + 'BytesWritten'] += socket.bytesWritten;
        // A normal FIN retains the other half until its own FIN. An abort or
        // reset terminates both sides; pipe supplies backpressure and EOF.
        if (hadError || !socket.readableEnded) {
          if (side === 'client') upstream?.destroy();
          else client.destroy();
        }
        if (client.destroyed && (!upstream || upstream.destroyed)) clearTimeout(deadline);
      });
    };
    track(client, 'client');
    Promise.resolve()
      .then(resolveTarget)
      .then((target) => {
        if (client.destroyed || proof.closed) return;
        assert.match(target.containerId, /^[a-f0-9]{64}$/u);
        assert.equal(net.isIP(target.ip), 4);
        assert.ok(Number.isInteger(target.port) && target.port > 0 && target.port <= 65535);
        if (proof.target) assert.deepEqual(target, proof.target, 'Owned relay endpoint changed');
        else proof.target = Object.freeze({ ...target });
        upstream = net.createConnection({
          host: target.ip,
          port: target.port,
          allowHalfOpen: true,
        });
        track(upstream, 'upstream');
        upstream.once('connect', () => {
          if (client.destroyed || proof.closed) {
            upstream.destroy();
            return;
          }
          client.pipe(upstream);
          upstream.pipe(client);
        });
      })
      .catch((error) => fail('identity', error));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  proof.port = server.address().port;
  return {
    snapshot: () => ({ ...proof, activeSockets: sockets.size }),
    async close() {
      if (proof.closed) return;
      proof.closed = true;
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const socketClosures = [...sockets].map(
        (socket) => new Promise((resolve) => socket.once('close', resolve)),
      );
      for (const socket of sockets) socket.destroy();
      let timer;
      try {
        await Promise.race([
          Promise.all([closed, ...socketClosures]),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Owned relay did not close')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(sockets.size, 0, 'Owned relay sockets remain');
    },
  };
}

async function assertLoopbackReleased(ports) {
  for (const port of ports) {
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  return { complete: true, host: '127.0.0.1', ports };
}

module.exports = { ownedRelayTarget, createOwnedRelay, assertLoopbackReleased };
