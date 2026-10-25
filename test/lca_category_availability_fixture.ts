import { LCIA_APPLICABILITY_POLICY_VERSION } from '../supabase/functions/_shared/lca_category_availability.ts';
export function availabilityFixture() {
  return {
    schema_version: 'lcia.category-availability.v1',
    policy_version: LCIA_APPLICABILITY_POLICY_VERSION,
    completeness: 'partial',
    categories: [
      {
        impact_index: 0,
        method_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        method_version: '01.00.000',
        status: 'available',
        reasons: [],
      },
      {
        impact_index: 1,
        method_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        method_version: '02.00.000',
        status: 'unavailable',
        reasons: ['lcia_factor_location_semantics_unresolved'],
      },
    ],
  };
}
