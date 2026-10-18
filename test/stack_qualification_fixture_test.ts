import { assertEquals } from 'jsr:@std/assert';
import { handleStackPortal } from './fixtures/stack-qualification/portal.ts';
import {
  buildPortalHmacCanonical,
  encodeBase64Url,
} from '../supabase/functions/_shared/portal_hmac.ts';
Deno.test(
  'stack fixture executes real Portal HMAC and transport checks with raw bytes',
  async () => {
    const previousGet = Deno.env.get;
    const key = 'sb_publishable_stack_fixture';
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://fixture.invalid',
      PORTAL_SUPABASE_PUBLISHABLE_KEY: key,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: key }),
    };
    Deno.env.get = (name: string) => values[name];
    try {
      const bytes = new TextEncoder().encode('{ "steel": "钢" }\n');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const bodyHash = encodeBase64Url(digest);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = encodeBase64Url(new Uint8Array(16).fill(8));
      const canonical = buildPortalHmacCanonical({
        keyId: 'fixture',
        timestamp,
        nonce,
        method: 'POST',
        functionPath: '/functions/v1/portal',
        bodyHash,
      });
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32).fill(7),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(canonical)),
        ),
      );
      const headers = {
        apikey: key,
        'x-portal-key-id': 'fixture',
        'x-portal-timestamp': timestamp,
        'x-portal-nonce': nonce,
        'x-portal-body-sha256': bodyHash,
        'x-portal-signature': signature,
      };
      const response = await handleStackPortal(
        new Request('https://fixture.invalid/portal', { method: 'POST', headers, body: bytes }),
      );
      assertEquals(response.status, 200);
      const output = await response.json();
      assertEquals(output.bodyHash, bodyHash);
      assertEquals(output.authorizationPresent, false);
      const denied = await handleStackPortal(
        new Request('https://fixture.invalid/portal', {
          method: 'POST',
          headers: { ...headers, authorization: 'Bearer foreign' },
          body: bytes,
        }),
      );
      assertEquals(denied.status, 400);
      const changed = await handleStackPortal(
        new Request('https://fixture.invalid/portal', { method: 'POST', headers, body: 'changed' }),
      );
      assertEquals(changed.status, 400);
    } finally {
      Deno.env.get = previousGet;
    }
  },
);
