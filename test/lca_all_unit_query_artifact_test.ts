import { assert, assertEquals } from 'jsr:@std/assert';

import {
  ALL_UNIT_QUERY_V1_FORMAT,
  ALL_UNIT_QUERY_V2_FORMAT,
  parseAllUnitQueryArtifact,
  readImpactColumn,
  readProcessImpactRow,
  type AllUnitImpactEntry,
} from '../supabase/functions/_shared/lca_all_unit_query_artifact.ts';

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CALCULATION_ID = '33333333-3333-4333-8333-333333333333';
const METHOD_A = '44444444-4444-4444-8444-444444444444';
const METHOD_B = '55555555-5555-4555-8555-555555555555';

const impacts: AllUnitImpactEntry[] = [
  { impact_id: METHOD_A, impact_index: 0, impact_version: '01.00.000' },
  { impact_id: METHOD_B, impact_index: 1, impact_version: '02.00.000' },
];

Deno.test('all-unit query v2 reads verified LCIA rows and columns', async () => {
  const records = [
    record(0, METHOD_A, '01.00.000', 1.25),
    record(0, METHOD_B, '02.00.000', -2.5),
    record(1, METHOD_A, '01.00.000', 3.75),
    record(1, METHOD_B, '02.00.000', 4.5),
  ];
  const bytes = await gzip(`${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  const document = v2Document(bytes, await sha256Hex(bytes));
  const parsed = parseAllUnitQueryArtifact(document, {
    expectedFormat: ALL_UNIT_QUERY_V2_FORMAT,
    snapshotId: SNAPSHOT_ID,
    processCount: 2,
    impacts,
  });
  assert(parsed.ok);

  const requestedUrls: string[] = [];
  const fetchBytes = (artifactUrl: string) => {
    requestedUrls.push(artifactUrl);
    return Promise.resolve({ ok: true as const, data: bytes });
  };
  const row = await readProcessImpactRow(parsed.data, impacts, 1, fetchBytes);
  assert(row.ok);
  assertEquals(row.data, [3.75, 4.5]);

  const column = await readImpactColumn(parsed.data, impacts, 0, [0, 1], fetchBytes);
  assert(column.ok);
  assertEquals(
    [...column.data.entries()],
    [
      [0, 1.25],
      [1, 3.75],
    ],
  );
  assertEquals(requestedUrls, [
    'https://example.supabase.co/storage/v1/s3/private/calculation-bundles/bundle/results/lcia-000000.ndjson.gz',
    'https://example.supabase.co/storage/v1/s3/private/calculation-bundles/bundle/results/lcia-000000.ndjson.gz',
  ]);
});

Deno.test('all-unit query v2 rejects integrity drift before returning values', async () => {
  const records = [
    record(0, METHOD_A, '01.00.000', 1),
    record(0, METHOD_B, '02.00.000', 2),
    record(1, METHOD_A, '01.00.000', 3),
    record(1, METHOD_B, '02.00.000', 4),
  ];
  const bytes = await gzip(`${records.map((value) => JSON.stringify(value)).join('\n')}\n`);
  const document = v2Document(bytes, 'a'.repeat(64));
  const parsed = parseAllUnitQueryArtifact(document, {
    expectedFormat: ALL_UNIT_QUERY_V2_FORMAT,
    snapshotId: SNAPSHOT_ID,
    processCount: 2,
    impacts,
  });
  assert(parsed.ok);

  const row = await readProcessImpactRow(parsed.data, impacts, 0, () =>
    Promise.resolve({ ok: true, data: bytes }),
  );
  assertEquals(row.ok, false);
  if (!row.ok) {
    assertEquals(row.error, 'query_artifact_chunk_integrity_invalid');
  }
});

Deno.test('all-unit query v2 rejects bundle path traversal', async () => {
  const bytes = new Uint8Array([1]);
  const document = v2Document(bytes, 'a'.repeat(64));
  document.lciaChunks[0].path = '../outside.ndjson.gz';
  const parsed = parseAllUnitQueryArtifact(document, {
    expectedFormat: ALL_UNIT_QUERY_V2_FORMAT,
    snapshotId: SNAPSHOT_ID,
    processCount: 2,
    impacts,
  });
  assertEquals(parsed.ok, false);
  if (!parsed.ok) {
    assertEquals(parsed.error, 'query_artifact_shape_invalid');
  }
});

Deno.test('all-unit query v1 remains readable without method versions', async () => {
  const parsed = parseAllUnitQueryArtifact(
    {
      version: 1,
      format: ALL_UNIT_QUERY_V1_FORMAT,
      snapshot_id: SNAPSHOT_ID,
      job_id: JOB_ID,
      process_count: 2,
      impact_count: 2,
      h_matrix: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      expectedFormat: ALL_UNIT_QUERY_V1_FORMAT,
      snapshotId: SNAPSHOT_ID,
      processCount: 2,
      impacts: impacts.map(({ impact_version: _version, ...impact }) => impact),
    },
  );
  assert(parsed.ok);
  const column = await readImpactColumn(parsed.data, impacts, 1, null, () =>
    Promise.reject(new Error('v1 must not fetch chunk bytes')),
  );
  assert(column.ok);
  assertEquals(
    [...column.data.entries()],
    [
      [0, 2],
      [1, 4],
    ],
  );
});

Deno.test(
  'all-unit query reads opaque IDs and preserves snapshot and method identity',
  async () => {
    const opaqueImpacts = [{ impact_id: 'climate-change', impact_version: 'v1', impact_index: 0 }];
    const bytes = await gzip(`${JSON.stringify(record(0, 'climate-change', 'v1', 0))}\n`);
    for (const jobId of ['9e353806-c44c-49c5-d9d6-7c0b6f334c1c', 'task:opaque']) {
      const document = {
        ...v2Document(bytes, await sha256Hex(bytes)),
        snapshotId: 'snapshot:opaque',
        jobId,
        processCount: 1,
        impactCount: 1,
      };
      document.calculationBundle.calculationId = 'calculation:opaque';
      Object.assign(document.lciaChunks[0], { recordCount: 1, lastProcessIndex: 0 });
      const options = {
        expectedFormat: ALL_UNIT_QUERY_V2_FORMAT,
        snapshotId: 'snapshot:opaque',
        processCount: 1,
        impacts: opaqueImpacts,
      };
      const parsed = parseAllUnitQueryArtifact(document, options);
      assert(parsed.ok);
      const column = await readImpactColumn(parsed.data, opaqueImpacts, 0, [0], () =>
        Promise.resolve({ ok: true, data: bytes }),
      );
      assert(column.ok);
      assertEquals(column.data.get(0), 0);
      assertEquals(
        parseAllUnitQueryArtifact(document, { ...options, snapshotId: 'another-snapshot' }),
        { ok: false, error: 'query_artifact_snapshot_mismatch' },
      );
      const wrongMethod = await readImpactColumn(
        parsed.data,
        [{ ...opaqueImpacts[0], impact_id: 'another-method' }],
        0,
        [0],
        () => Promise.resolve({ ok: true, data: bytes }),
      );
      assertEquals(wrongMethod.ok, false);
      for (const invalidId of ['', '   ', null, 123]) {
        assertEquals(
          parseAllUnitQueryArtifact({ ...document, jobId: invalidId }, options).ok,
          false,
        );
        assertEquals(
          parseAllUnitQueryArtifact(
            {
              ...document,
              calculationBundle: { ...document.calculationBundle, calculationId: invalidId },
            },
            options,
          ).ok,
          false,
        );
      }
    }
  },
);

function record(processIndex: number, id: string, version: string, meanAmount: number) {
  return { processIndex, method: { id, version }, meanAmount };
}

function v2Document(bytes: Uint8Array, sha256: string) {
  return {
    version: 2,
    format: ALL_UNIT_QUERY_V2_FORMAT,
    snapshotId: SNAPSHOT_ID,
    jobId: JOB_ID,
    processCount: 2,
    impactCount: 2,
    calculationBundle: {
      schemaVersion: 'tiangong.calculation-bundle.v2',
      calculationId: CALCULATION_ID,
      bundleContentHash: 'b'.repeat(64),
      manifestUrl:
        'https://example.supabase.co/storage/v1/s3/private/calculation-bundles/bundle/calculation-bundle.json',
      manifestSha256: 'c'.repeat(64),
      manifestByteSize: 1024,
      artifactCount: 1,
    },
    lciaChunks: [
      {
        path: 'results/lcia-000000.ndjson.gz',
        schemaVersion: 'tiangong.calculation-bundle.lcia.v1',
        compression: 'gzip',
        sha256,
        byteSize: bytes.byteLength,
        recordCount: 4,
        firstProcessIndex: 0,
        lastProcessIndex: 1,
      },
    ],
  };
}

async function gzip(body: string): Promise<Uint8Array> {
  const compressed = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

Deno.test(
  'all-unit query v3 preserves unavailable categories as null and never ranks unknown zeros',
  async () => {
    const { document, bytes } = await partialDocument();
    const parsed = parseAllUnitQueryArtifact(document, {
      expectedFormat: 'all-unit-query:v3',
      snapshotId: SNAPSHOT_ID,
      processCount: 2,
      impacts,
    });
    assert(parsed.ok);
    let reads = 0;
    const fetcher = () => {
      reads += 1;
      return Promise.resolve({ ok: true as const, data: bytes });
    };
    const row = await readProcessImpactRow(parsed.data, impacts, 0, fetcher);
    assertEquals(row, { ok: true, data: [0, null] });
    const available = await readImpactColumn(parsed.data, impacts, 0, [0, 1], fetcher);
    assert(available.ok);
    assertEquals([...available.data.values()], [0, -3]);
    const unavailable = await readImpactColumn(parsed.data, impacts, 1, null, fetcher);
    assertEquals(unavailable, {
      ok: false,
      error: 'lcia_category_unavailable',
      detail: 'lcia_factor_location_semantics_unresolved',
    });
    assertEquals(reads, 2);
  },
);

Deno.test(
  'all-unit query v3 rejects malformed availability and exact source version drift',
  async () => {
    const { document } = await partialDocument();
    for (const patch of [
      { lciaAvailability: null },
      { lciaAvailability: { ...document.lciaAvailability, completeness: 'complete' } },
      {
        lciaAvailability: {
          ...document.lciaAvailability,
          categories: document.lciaAvailability.categories.map((row) => ({
            ...row,
            method_version: '99.00.000',
          })),
        },
      },
      {
        lciaChunks: document.lciaChunks.map((chunk) => ({
          ...chunk,
          schemaVersion: 'tiangong.calculation-bundle.lcia.v1',
        })),
      },
    ]) {
      const parsed = parseAllUnitQueryArtifact(
        { ...document, ...patch },
        { expectedFormat: 'all-unit-query:v3', snapshotId: SNAPSHOT_ID, processCount: 2, impacts },
      );
      assertEquals(parsed.ok, false);
    }
  },
);

Deno.test(
  'all-unit query v3 binds every null/status/reason to the immutable availability',
  async () => {
    for (const changes of [
      { meanAmount: 0 },
      { status: 'available' },
      { reasons: [] },
      { reasons: ['a different reason'] },
    ]) {
      const { document, bytes } = await partialDocument(changes);
      const parsed = parseAllUnitQueryArtifact(document, {
        expectedFormat: 'all-unit-query:v3',
        snapshotId: SNAPSHOT_ID,
        processCount: 2,
        impacts,
      });
      assert(parsed.ok);
      const row = await readProcessImpactRow(parsed.data, impacts, 0, () =>
        Promise.resolve({ ok: true, data: bytes }),
      );
      assertEquals(row.ok, false);
    }
  },
);

async function partialDocument(changes: Record<string, unknown> = {}) {
  const lciaAvailability = {
    schema_version: 'lcia.category-availability.v1',
    policy_version: 'lcia.applicability.source-bound.v3',
    completeness: 'partial',
    categories: impacts.map((impact, index) => ({
      impact_index: index,
      method_id: impact.impact_id,
      method_version: impact.impact_version,
      status: index === 0 ? 'available' : 'unavailable',
      reasons: index === 0 ? [] : ['lcia_factor_location_semantics_unresolved'],
    })),
  };
  const records = [0, 1].flatMap((processIndex) =>
    impacts.map((impact, index) => ({
      processIndex,
      method: { id: impact.impact_id, version: impact.impact_version },
      meanAmount: index === 0 ? -3 * processIndex : null,
      status: index === 0 ? 'available' : 'unavailable',
      reasons: index === 0 ? [] : ['lcia_factor_location_semantics_unresolved'],
      ...(index === 1 ? changes : {}),
    })),
  );
  const bytes = await gzip(records.map((value) => JSON.stringify(value)).join('\n') + '\n');
  const original = v2Document(bytes, await sha256Hex(bytes));
  const document = {
    ...original,
    version: 3,
    format: 'all-unit-query:v3',
    lciaAvailability,
    calculationBundle: {
      ...original.calculationBundle,
      schemaVersion: 'tiangong.calculation-bundle.v3',
    },
    lciaChunks: original.lciaChunks.map((chunk) => ({
      ...chunk,
      schemaVersion: 'tiangong.calculation-bundle.lcia.v2',
    })),
  };
  return { document, bytes };
}

Deno.test(
  'current complete query v3 binds availability while retaining numeric v2 bundle compatibility',
  async () => {
    const records = [
      record(0, METHOD_A, '01.00.000', 0),
      record(0, METHOD_B, '02.00.000', -2),
      record(1, METHOD_A, '01.00.000', 3),
      record(1, METHOD_B, '02.00.000', 4),
    ];
    const bytes = await gzip(records.map((value) => JSON.stringify(value)).join('\n') + '\n');
    const document = {
      ...v2Document(bytes, await sha256Hex(bytes)),
      version: 3,
      format: 'all-unit-query:v3',
      lciaAvailability: {
        schema_version: 'lcia.category-availability.v1',
        policy_version: 'lcia.applicability.source-bound.v3',
        completeness: 'complete',
        categories: impacts.map((impact) => ({
          impact_index: impact.impact_index,
          method_id: impact.impact_id,
          method_version: impact.impact_version,
          status: 'available',
          reasons: [],
        })),
      },
    };
    const parsed = parseAllUnitQueryArtifact(document, {
      expectedFormat: document.format,
      snapshotId: SNAPSHOT_ID,
      processCount: 2,
      impacts,
    });
    assert(parsed.ok);
    assertEquals(
      await readProcessImpactRow(parsed.data, impacts, 0, () =>
        Promise.resolve({ ok: true, data: bytes }),
      ),
      { ok: true, data: [0, -2] },
    );
  },
);
