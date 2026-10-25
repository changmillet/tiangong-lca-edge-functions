import { assert, assertEquals } from 'jsr:@std/assert';
import {
  parseAllUnitQueryArtifact,
  readImpactColumn,
  readProcessImpactRow,
} from '../supabase/functions/_shared/lca_all_unit_query_artifact.ts';
import { parseSnapshotLciaAvailability } from '../supabase/functions/_shared/lca_category_availability.ts';
import query from './fixtures/worker_partial_lcia_v3/query.json' with { type: 'json' };
import index from './fixtures/worker_partial_lcia_v3/snapshot-index.json' with { type: 'json' };

Deno.test(
  'native Worker partial bundle is readable without converting unknown impacts to zero',
  async () => {
    const availability = parseSnapshotLciaAvailability(index.lcia_applicability, index.impact_map);
    assert(availability);
    const parsed = parseAllUnitQueryArtifact(query, {
      expectedFormat: 'all-unit-query:v3',
      snapshotId: index.snapshot_id,
      processCount: index.process_count,
      impacts: index.impact_map,
    });
    assert(parsed.ok, JSON.stringify(parsed));
    const fetchBytes = async (url: string) => {
      const remote = new URL(url);
      assertEquals(remote.origin, 'https://worker-contract.invalid');
      const local = new URL(`./fixtures/worker_partial_lcia_v3${remote.pathname}`, import.meta.url);
      return { ok: true as const, data: await Deno.readFile(local) };
    };
    const row = await readProcessImpactRow(parsed.data, index.impact_map, 0, fetchBytes);
    assert(row.ok, JSON.stringify(row));
    assertEquals(row.data, [0, null]);
    const known = await readImpactColumn(parsed.data, index.impact_map, 0, null, fetchBytes);
    assert(known.ok, JSON.stringify(known));
    assertEquals(known.data.get(0), 0);
    const unavailable = await readImpactColumn(parsed.data, index.impact_map, 1, null, fetchBytes);
    assertEquals(unavailable.ok, false);
    if (!unavailable.ok) assertEquals(unavailable.error, 'lcia_category_unavailable');
  },
);
