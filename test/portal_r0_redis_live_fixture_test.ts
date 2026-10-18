import { assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert';

import {
  admitPortalR0Request,
  createPortalR0RedisAdapter,
  readPortalR0RedisConfig,
  registerPortalR0Nonce,
  releasePortalR0Lease,
} from '../supabase/functions/_shared/portal_r0_redis.ts';

import {
  createPortalRedisAdapter,
  PortalRedisError,
} from '../supabase/functions/_shared/redis_client.ts';

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

function baseEnvironment() {
  return {
    PORTAL_R0_RUNTIME_TARGET: 'test',
    PORTAL_R0_REDIS_NAMESPACE: 'portal:r0:transport-fixture:v1',
    PORTAL_R0_REDIS_TIMEOUT_MS: '500',
    PORTAL_R0_MINUTE_BUDGET: '4',
    PORTAL_R0_DAILY_BUDGET: '20',
    PORTAL_R0_MAX_CONCURRENCY: '2',
    PORTAL_R0_LEASE_TTL_SECONDS: '20',
  };
}

type RespCommand = string[];

function parseRespCommand(buffer: string): { command: RespCommand; consumed: number } | null {
  const firstLineEnd = buffer.indexOf('\r\n');
  if (firstLineEnd < 0 || !buffer.startsWith('*')) return null;
  const count = Number(buffer.slice(1, firstLineEnd));
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid fixture RESP array');
  let offset = firstLineEnd + 2;
  const command: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lengthLineEnd = buffer.indexOf('\r\n', offset);
    if (lengthLineEnd < 0) return null;
    if (buffer[offset] !== '$') throw new Error('invalid fixture RESP bulk string');
    const length = Number(buffer.slice(offset + 1, lengthLineEnd));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid fixture RESP length');
    const valueStart = lengthLineEnd + 2;
    const valueEnd = valueStart + length;
    if (buffer.length < valueEnd + 2) return null;
    if (buffer.slice(valueEnd, valueEnd + 2) !== '\r\n') {
      throw new Error('invalid fixture RESP terminator');
    }
    command.push(buffer.slice(valueStart, valueEnd));
    offset = valueEnd + 2;
  }
  return { command, consumed: offset };
}

function integerArrayResponse(values: number[]): string {
  return `*${values.length}\r\n${values.map((value) => `:${value}\r\n`).join('')}`;
}

async function startStandardRedisFixture(options: { password?: string; holdKey?: string } = {}) {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const commands: RespCommand[] = [];
  const connections = new Set<Deno.TcpConn>();
  const handlers: Promise<void>[] = [];
  let replayRegistered = false;
  function closeConnection(connection: Deno.TcpConn) {
    try {
      connection.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  }
  const task = (async () => {
    try {
      for await (const connection of listener) {
        connections.add(connection);
        handlers.push(
          (async () => {
            let buffer = '';
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();
            const bytes = new Uint8Array(32 * 1024);
            try {
              while (true) {
                const count = await connection.read(bytes);
                if (count === null) break;
                buffer += decoder.decode(bytes.subarray(0, count), { stream: true });
                while (true) {
                  const parsed = parseRespCommand(buffer);
                  if (!parsed) break;
                  buffer = buffer.slice(parsed.consumed);
                  commands.push(parsed.command);
                  const operation = parsed.command[0]?.toUpperCase();
                  let response: string;
                  if (operation === 'AUTH') {
                    assertEquals(parsed.command, ['AUTH', options.password]);
                    response = '+OK\r\n';
                  } else if (operation === 'GET') {
                    if (parsed.command[1] === options.holdKey) continue;
                    const value = '{"value":0}';
                    response =
                      parsed.command[1] === 'fixture:missing'
                        ? '$-1\r\n'
                        : `$${value.length}\r\n${value}\r\n`;
                  } else if (operation === 'SET') {
                    response =
                      parsed.command.includes('NX') && replayRegistered ? '$-1\r\n' : '+OK\r\n';
                    if (parsed.command.includes('NX')) replayRegistered = true;
                  } else if (operation === 'EVAL' && parsed.command[1] === 'fixture-error') {
                    response = '-ERR synthetic fixture failure\r\n';
                  } else if (operation === 'EVAL' && parsed.command[1]?.includes("'ZREM'")) {
                    response = ':1\r\n';
                  } else if (operation === 'EVAL') {
                    response = integerArrayResponse([0, 3, 19, 1, 0]);
                  } else {
                    response = '-ERR unsupported fixture command\r\n';
                  }
                  await connection.write(encoder.encode(response));
                }
              }
            } catch (error) {
              if (
                !(error instanceof Deno.errors.BadResource) &&
                !(error instanceof Deno.errors.Interrupted)
              )
                throw error;
            } finally {
              connections.delete(connection);
              closeConnection(connection);
            }
          })(),
        );
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  if (listener.addr.transport !== 'tcp') throw new Error('fixture requires TCP');
  return {
    port: listener.addr.port,
    commands,
    async close() {
      listener.close();
      for (const connection of connections) closeConnection(connection);
      await task;
      await Promise.all(handlers);
    },
  };
}

async function startUpstashRedisFixture(token: string) {
  const commands: string[][] = [];
  let replayRegistered = false;
  const controller = new AbortController();
  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      signal: controller.signal,
      onListen() {},
    },
    async (request) => {
      assertEquals(request.headers.get('authorization'), `Bearer ${token}`);
      const payload = (await request.json()) as string[] | string[][];
      const pipelined = Array.isArray(payload[0]);
      const requestCommands = (pipelined ? payload : [payload]) as string[][];
      const results = requestCommands.map((command) => {
        commands.push(command);
        const operation = command[0]?.toUpperCase();
        if (operation === 'SET') {
          const result = replayRegistered ? null : 'OK';
          replayRegistered = true;
          return { result };
        }
        if (operation === 'EVAL' && command[1]?.includes("'ZREM'")) {
          return { result: 1 };
        }
        if (operation === 'EVAL') return { result: [0, 3, 19, 1, 0] };
        return { error: 'unsupported fixture command' };
      });
      return Response.json(pipelined ? results : results[0]);
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    commands,
    async close() {
      controller.abort();
      await server.finished;
    },
  };
}

async function exerciseFixture(values: Record<string, string>) {
  const env = environment(values);
  const config = readPortalR0RedisConfig(env);
  const adapter = await createPortalR0RedisAdapter(env);
  try {
    const nonce = 'AQIDBAUGBwgJCgsMDQ4PEA';
    assertEquals(await registerPortalR0Nonce({ keyId: 'r0-current', nonce }, adapter), true);
    assertEquals(await registerPortalR0Nonce({ keyId: 'r0-current', nonce }, adapter), false);
    const admission = await admitPortalR0Request(config, adapter, 1_800_000_000_000);
    assertEquals(admission.status, 'admitted');
    if (admission.status !== 'admitted') throw new Error('fixture admission failed');
    await releasePortalR0Lease(admission.leaseId, adapter);
  } finally {
    await adapter.close();
  }
}

Deno.test(
  'R0 Standard Redis loopback fixture proves SET NX EX and Lua admission transport',
  async () => {
    const fixture = await startStandardRedisFixture();
    try {
      await exerciseFixture({
        ...baseEnvironment(),
        PORTAL_R0_REDIS_CLIENT_TYPE: 'standard',
        PORTAL_R0_REDIS_URL: `redis://127.0.0.1:${fixture.port}`,
      });
      assertEquals(
        fixture.commands.map((command) => command[0]?.toUpperCase()),
        ['SET', 'SET', 'EVAL', 'EVAL'],
      );
      assertEquals(fixture.commands[0].slice(-3), ['EX', '120', 'NX']);
      assertStringIncludes(fixture.commands[2][1], "redis.call('INCRBY'");
      assertStringIncludes(fixture.commands[3][1], "redis.call('ZREM'");
    } finally {
      await fixture.close();
    }
  },
);

Deno.test(
  'R0 isolated Upstash-compatible loopback fixture proves authenticated REST transport',
  async () => {
    const token = 'r0-one-time-fixture-token';
    const fixture = await startUpstashRedisFixture(token);
    try {
      await exerciseFixture({
        ...baseEnvironment(),
        PORTAL_R0_REDIS_CLIENT_TYPE: 'upstash',
        PORTAL_R0_UPSTASH_REDIS_URL: `http://127.0.0.1:${fixture.port}`,
        PORTAL_R0_UPSTASH_REDIS_TOKEN: token,
      });
      assertEquals(
        fixture.commands.map((command) => command[0]?.toUpperCase()),
        ['SET', 'SET', 'EVAL', 'EVAL'],
      );
      assertStringIncludes(fixture.commands[2][1], "redis.call('INCRBY'");
      assertStringIncludes(fixture.commands[3][1], "redis.call('ZREM'");
    } finally {
      await fixture.close();
    }
  },
);

Deno.test(
  'Standard Redis installed client authenticates and preserves bulk cache values and EX',
  async () => {
    const password = 'synthetic-redis-password';
    const fixture = await startStandardRedisFixture({ password });
    const adapter = await createPortalRedisAdapter({
      provider: 'standard',
      namespace: 'portal:wire-cache:v1',
      timeoutMs: 500,
      redisUrl: `redis://127.0.0.1:${fixture.port}`,
      redisPassword: password,
    });
    try {
      assertEquals(await adapter.get('fixture:cache'), '{"value":0}');
      assertEquals(await adapter.get('fixture:missing'), null);
      await adapter.setEx('fixture:cache', '{"value":0}', 30);
      assertEquals(fixture.commands, [
        ['AUTH', password],
        ['GET', 'fixture:cache'],
        ['GET', 'fixture:missing'],
        ['SET', 'fixture:cache', '{"value":0}', 'EX', '30'],
      ]);
      const error = await assertRejects(
        () => adapter.eval('fixture-error', [], []),
        PortalRedisError,
      );
      assertEquals(error.message, 'guard_unavailable');
      assertEquals(error.code, 'guard_unavailable');
    } finally {
      await adapter.close();
      await fixture.close();
    }
  },
);

Deno.test(
  'Standard Redis installed client timeout rejects a held reply and closes cleanly',
  async () => {
    const fixture = await startStandardRedisFixture({ holdKey: 'fixture:held' });
    const adapter = await createPortalRedisAdapter({
      provider: 'standard',
      namespace: 'portal:wire-timeout:v1',
      timeoutMs: 50,
      redisUrl: `redis://127.0.0.1:${fixture.port}`,
    });
    try {
      await assertRejects(() => adapter.get('fixture:held'), PortalRedisError, 'guard_unavailable');
      assertEquals(fixture.commands, [['GET', 'fixture:held']]);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  },
);
