// Gateway JWT verification happens in the actual CLI bootstrap before this worker.
if (import.meta.main)
  Deno.serve(async (request) => {
    await request.arrayBuffer();
    return Response.json({
      ok: true,
      bearerPresent: request.headers.has('authorization'),
      deno: Deno.version,
    });
  });
