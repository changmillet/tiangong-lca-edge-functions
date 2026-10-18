import { assert, assertEquals } from 'jsr:@std/assert';

import {
  dataProductCommandRequestSchema,
  parseDataProductCommand,
} from '../supabase/functions/_shared/commands/data_product/command.ts';
import type { DataProductTaskFeedRequest } from '../supabase/functions/_shared/commands/data_product/types.ts';
import { assignReviewersRequestSchema } from '../supabase/functions/_shared/commands/review/validation.ts';
import { portalHybridQuerySchema } from '../supabase/functions/_shared/portal_hybrid_contract.ts';

const ID = '11111111-1111-4111-8111-111111111111';

Deno.test('actual command and Portal schemas retain code-point bounds and parsed trimming', () => {
  const name = '😀'.repeat(200);
  const parsed = parseDataProductCommand({ action: 'create_build', name: `  ${name}  ` });
  assert(parsed.ok);
  assertEquals(parsed.value, {
    action: 'create_build',
    name,
    coverageMode: 'global_eligible',
    lciaMethodSet: [],
  });
  assertEquals(
    dataProductCommandRequestSchema.safeParse({ action: 'create_build', name: `${name}😀` })
      .success,
    false,
  );
  assertEquals(portalHybridQuerySchema.parse('😀'.repeat(512)), '😀'.repeat(512));
  assertEquals(portalHybridQuerySchema.safeParse('😀'.repeat(513)).success, false);
  // Combining marks are separate code points, not grapheme clusters.
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'create_build',
      name: 'e\u0301'.repeat(101),
    }).success,
    false,
  );
});

Deno.test(
  'actual native datetimes require seconds while review Date.parse behavior stays distinct',
  () => {
    for (const stamp of ['2026-10-18T01:02:03Z', '2026-10-18T01:02:03.123456+08:00']) {
      const input: DataProductTaskFeedRequest = {
        action: 'list_task_feed',
        updatedSince: stamp,
        cursor: { updatedAt: stamp, jobId: ID },
      };
      const parsed = parseDataProductCommand(input);
      assert(parsed.ok);
      assertEquals(parsed.value, input);
    }
    for (const stamp of ['2026-10-18T01:02Z', '2026-02-29T01:02:03Z']) {
      assertEquals(
        dataProductCommandRequestSchema.safeParse({ action: 'list_task_feed', updatedSince: stamp })
          .success,
        false,
      );
    }
    assertEquals(
      assignReviewersRequestSchema.parse({
        reviewId: ID,
        reviewerIds: [ID],
        deadline: '2026-10-18T01:02Z',
      }).deadline,
      '2026-10-18T01:02Z',
    );
  },
);

Deno.test('actual command parser preserves combined field and strict-object diagnostics', () => {
  assertEquals(
    parseDataProductCommand({
      action: 'list_task_feed',
      updatedSince: 'bad-date',
      limit: 0,
      unknown: true,
    }),
    {
      ok: false,
      message: 'Invalid data product command payload',
      details: {
        formErrors: ['Unrecognized key: "unknown"'],
        fieldErrors: {
          updatedSince: ['Invalid ISO datetime'],
          limit: ['Too small: expected number to be >=1'],
        },
      },
    },
  );
});
