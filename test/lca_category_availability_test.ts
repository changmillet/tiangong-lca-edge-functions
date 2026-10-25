import { assertEquals } from 'jsr:@std/assert';
import {
  LCIA_APPLICABILITY_POLICY_VERSION,
  parseLciaAvailability,
  parseSnapshotLciaAvailability,
} from '../supabase/functions/_shared/lca_category_availability.ts';

import { availabilityFixture } from './lca_category_availability_fixture.ts';

Deno.test(
  'category availability binds the ordered complete method/version axis and truthful completeness',
  () => {
    const receipt = availabilityFixture();
    const axis = receipt.categories.map((row) => ({
      impact_index: row.impact_index,
      impact_id: row.method_id,
      impact_version: row.method_version,
    }));
    assertEquals(parseLciaAvailability(receipt, axis), receipt);
    for (const changed of [
      { ...receipt, completeness: 'complete' },
      { ...receipt, policy_version: 'lcia.applicability.source-bound.v1' },
      { ...receipt, categories: receipt.categories.slice(0, 1) },
      { ...receipt, categories: [...receipt.categories].reverse() },
      {
        ...receipt,
        categories: [
          receipt.categories[0],
          { ...receipt.categories[1], method_version: '01.00.000' },
        ],
      },
      {
        ...receipt,
        categories: [receipt.categories[0], { ...receipt.categories[1], reasons: [] }],
      },
      {
        ...receipt,
        categories: [
          { ...receipt.categories[0], reasons: ['inconsistent'] },
          receipt.categories[1],
        ],
      },
      {
        ...receipt,
        categories: [receipt.categories[0], { ...receipt.categories[1], reasons: ['a', 'a'] }],
      },
      { ...receipt, additional_authority: true },
    ])
      assertEquals(parseLciaAvailability(changed, axis), null);
    assertEquals(
      parseSnapshotLciaAvailability(
        {
          schema_version: 'lcia.applicability.evidence.v2',
          policy_version: LCIA_APPLICABILITY_POLICY_VERSION,
          availability: receipt,
        },
        axis,
      ),
      receipt,
    );
    assertEquals(
      parseSnapshotLciaAvailability({ policy_version: 'old', availability: receipt }, axis),
      null,
    );
  },
);

Deno.test(
  'category availability rejects noncanonical identity and unbounded or noncanonical reasons',
  () => {
    const receipt = availabilityFixture();
    for (const patch of [
      { method_id: 'not-a-uuid' },
      { method_id: receipt.categories[1].method_id.toUpperCase() },
      { method_version: 'v2' },
      { impact_index: Number.MAX_SAFE_INTEGER + 1 },
      { reasons: ['b', 'a'] },
      { reasons: ['not a code'] },
      { reasons: ['UPPER'] },
      { reasons: ['a'.repeat(161)] },
      { reasons: Array.from({ length: 33 }, (_, i) => `reason_${String(i).padStart(2, '0')}`) },
    ])
      assertEquals(
        parseLciaAvailability({
          ...receipt,
          categories: [receipt.categories[0], { ...receipt.categories[1], ...patch }],
        }),
        null,
      );
    assertEquals(
      parseSnapshotLciaAvailability(
        { policy_version: receipt.policy_version, availability: receipt },
        [],
      ),
      null,
    );
  },
);
