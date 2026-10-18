import { verifyPortalHmacRequest } from '../../../supabase/functions/_shared/portal_hmac.ts';
import {
  readPortalLegacyAnonCredential,
  readPortalPublishableCredential,
  validatePortalInboundTransport,
} from '../../../supabase/functions/_shared/portal_public_transport.ts';

export async function handleStackPortal(request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  try {
    const verified = await verifyPortalHmacRequest({
      request,
      rawBody: body,
      expectedFunctionPath: '/functions/v1/portal',
      allowedRequestPaths: ['/functions/v1/portal', '/portal'],
      keyring: { current: { keyId: 'fixture', secret: new Uint8Array(32).fill(7) } },
    });
    const trustedPublishableKey = readPortalPublishableCredential();
    validatePortalInboundTransport({
      request,
      trustedPublishableKey,
      trustedLegacyAnonKey: readPortalLegacyAnonCredential(),
    });
    if (request.headers.get('x-fixture-stream') === 'true') {
      let timer: ReturnType<typeof setInterval> | undefined;
      const report = (event: string) => {
        if (timer !== undefined) clearInterval(timer);
        console.log(JSON.stringify({ event, nonce: verified.nonce }));
      };
      request.signal.addEventListener('abort', () => report('stack.request.abort'), { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ready\n'));
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode('chunk\n')), 100);
          },
          cancel() {
            report('stack.response.cancel');
          },
        }),
      );
    }
    return Response.json({
      ok: true,
      bodyHash: verified.bodyHash,
      bodyBytes: body.byteLength,
      pathname: new URL(request.url).pathname,
      authorizationPresent: request.headers.has('authorization'),
      compatibilityHeaderPresent: request.headers.has('sb-api-key'),
      deno: Deno.version,
    });
  } catch (error) {
    return Response.json(
      { ok: false, code: error instanceof Error ? error.message : 'invalid' },
      { status: 400 },
    );
  }
}

if (import.meta.main) Deno.serve(handleStackPortal);
