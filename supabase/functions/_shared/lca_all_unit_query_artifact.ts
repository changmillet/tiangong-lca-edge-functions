import { parseLciaAvailability, type LciaAvailability } from './lca_category_availability.ts';

const SHA256_RE = /^[0-9a-f]{64}$/i;

export const ALL_UNIT_QUERY_V1_FORMAT = 'all-unit-query:v1';
export const ALL_UNIT_QUERY_V2_FORMAT = 'all-unit-query:v2';
export const ALL_UNIT_QUERY_V3_FORMAT = 'all-unit-query:v3';

const CALCULATION_BUNDLE_SCHEMA_VERSION = 'tiangong.calculation-bundle.v2';
const LCIA_CHUNK_SCHEMA_VERSION = 'tiangong.calculation-bundle.lcia.v1';
const PARTIAL_LCIA_CHUNK_SCHEMA_VERSION = 'tiangong.calculation-bundle.lcia.v2';

export type AllUnitImpactEntry = {
  impact_id: string;
  impact_index: number;
  impact_version?: string;
};

type AllUnitQueryV1 = {
  kind: 'v1';
  version: 1;
  format: typeof ALL_UNIT_QUERY_V1_FORMAT;
  snapshotId: string;
  processCount: number;
  impactCount: number;
  hMatrix: number[][];
};

type AllUnitQueryV2Chunk = {
  path: string;
  schemaVersion: typeof LCIA_CHUNK_SCHEMA_VERSION | typeof PARTIAL_LCIA_CHUNK_SCHEMA_VERSION;
  compression: 'gzip';
  sha256: string;
  byteSize: number;
  recordCount: number;
  firstProcessIndex: number;
  lastProcessIndex: number;
  artifactUrl: string;
};

type AllUnitQueryV2 = {
  kind: 'v2' | 'v3';
  version: 2 | 3;
  format: typeof ALL_UNIT_QUERY_V2_FORMAT | typeof ALL_UNIT_QUERY_V3_FORMAT;
  lciaAvailability: LciaAvailability | null;
  snapshotId: string;
  processCount: number;
  impactCount: number;
  calculationBundleManifestUrl: string;
  chunks: AllUnitQueryV2Chunk[];
};

export type ParsedAllUnitQueryArtifact = AllUnitQueryV1 | AllUnitQueryV2;

export type AllUnitQueryResult<T> =
  { ok: true; data: T } | { ok: false; error: string; detail?: string };

export type ArtifactBytesFetcher = (artifactUrl: string) => Promise<AllUnitQueryResult<Uint8Array>>;

type ParseOptions = {
  expectedFormat: string;
  snapshotId: string;
  processCount: number;
  impacts: AllUnitImpactEntry[];
};

type CalculationBundleRef = {
  schemaVersion: string;
  calculationId: string;
  bundleContentHash: string;
  manifestUrl: string;
  manifestSha256: string;
  manifestByteSize: number;
  artifactCount: number;
};

type RawV2Chunk = {
  path: string;
  schemaVersion: string;
  compression: string;
  sha256: string;
  byteSize: number;
  recordCount: number;
  firstProcessIndex: number;
  lastProcessIndex: number;
};

export function parseAllUnitQueryArtifact(
  raw: unknown,
  options: ParseOptions,
): AllUnitQueryResult<ParsedAllUnitQueryArtifact> {
  const document = asRecord(raw);
  if (!document) {
    return invalid('query artifact must be a JSON object');
  }

  const format = stringField(document, 'format');
  if (format !== options.expectedFormat) {
    return {
      ok: false,
      error: 'query_artifact_format_mismatch',
      detail: `expected=${options.expectedFormat} actual=${format || 'missing'}`,
    };
  }
  if (
    format !== ALL_UNIT_QUERY_V1_FORMAT &&
    format !== ALL_UNIT_QUERY_V2_FORMAT &&
    format !== ALL_UNIT_QUERY_V3_FORMAT
  ) {
    return { ok: false, error: 'unsupported_query_artifact_format' };
  }

  const snapshotId = stringField(document, 'snapshot_id') || stringField(document, 'snapshotId');
  if (!snapshotId || !options.snapshotId || snapshotId !== options.snapshotId) {
    return { ok: false, error: 'query_artifact_snapshot_mismatch' };
  }

  const expectedImpactCount = options.impacts.length;
  if (!isNonNegativeSafeInteger(options.processCount) || expectedImpactCount === 0) {
    return invalid('snapshot axis is invalid');
  }
  const impactAxis = validateImpactAxis(options.impacts, format !== ALL_UNIT_QUERY_V1_FORMAT);
  if (!impactAxis.ok) {
    return impactAxis;
  }

  if (format === ALL_UNIT_QUERY_V1_FORMAT) {
    if (document.version !== 1) {
      return invalid('v1 artifact version must be 1');
    }
    const processCount = numberField(document, 'process_count');
    const impactCount = numberField(document, 'impact_count');
    if (processCount !== options.processCount || impactCount !== expectedImpactCount) {
      return invalid('v1 artifact axis count mismatch');
    }
    const rawMatrix = document.h_matrix;
    if (!Array.isArray(rawMatrix) || rawMatrix.length !== processCount) {
      return invalid('v1 h_matrix process axis mismatch');
    }
    const hMatrix: number[][] = [];
    for (let processIndex = 0; processIndex < rawMatrix.length; processIndex += 1) {
      const rawRow = rawMatrix[processIndex];
      if (!Array.isArray(rawRow) || rawRow.length !== impactCount) {
        return invalid(`v1 h_matrix row ${processIndex} has an invalid impact axis`);
      }
      const row = rawRow.map(Number);
      if (row.some((value) => !Number.isFinite(value))) {
        return invalid(`v1 h_matrix row ${processIndex} contains a non-finite value`);
      }
      hMatrix.push(row);
    }
    return {
      ok: true,
      data: {
        kind: 'v1',
        version: 1,
        format,
        snapshotId,
        processCount,
        impactCount,
        hMatrix,
      },
    };
  }

  const isV3 = format === ALL_UNIT_QUERY_V3_FORMAT;
  if (document.version !== (isV3 ? 3 : 2))
    return invalid('query artifact version differs from format');
  const availability = isV3
    ? parseLciaAvailability(document.lciaAvailability, options.impacts)
    : null;
  if (isV3 && !availability) return invalid('v3 category availability is missing or invalid');
  const jobId = stringField(document, 'jobId');
  const processCount = numberField(document, 'processCount');
  const impactCount = numberField(document, 'impactCount');
  // IDs are opaque references. Trust comes from the caller-verified artifact digest
  // and snapshot/method binding, not UUID version or variant bits.
  if (!jobId) {
    return invalid('v2 jobId is missing');
  }
  if (processCount !== options.processCount || impactCount !== expectedImpactCount) {
    return invalid('v2 artifact axis count mismatch');
  }

  const partial = availability !== null && availability.completeness !== 'complete';
  const bundle = parseCalculationBundleRef(document.calculationBundle, partial);
  const chunkSchema = partial ? PARTIAL_LCIA_CHUNK_SCHEMA_VERSION : LCIA_CHUNK_SCHEMA_VERSION;
  if (!bundle.ok) {
    return bundle;
  }
  const rawChunks = document.lciaChunks;
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    return invalid('v2 lciaChunks must be non-empty');
  }

  const chunks: AllUnitQueryV2Chunk[] = [];
  let expectedFirstProcessIndex = 0;
  for (let index = 0; index < rawChunks.length; index += 1) {
    const parsedChunk = parseV2Chunk(rawChunks[index], chunkSchema);
    if (!parsedChunk.ok) {
      return parsedChunk;
    }
    const chunk = parsedChunk.data;
    if (chunk.firstProcessIndex !== expectedFirstProcessIndex) {
      return invalid(`v2 chunk ${index} does not continue the process axis`);
    }
    if (chunk.lastProcessIndex >= processCount) {
      return invalid(`v2 chunk ${index} exceeds the process axis`);
    }
    const processSpan = chunk.lastProcessIndex - chunk.firstProcessIndex + 1;
    if (chunk.recordCount !== processSpan * impactCount) {
      return invalid(`v2 chunk ${index} recordCount does not cover its full LCIA axis`);
    }
    const artifactUrl = resolveBundleChildUrl(bundle.data.manifestUrl, chunk.path);
    if (!artifactUrl.ok) {
      return artifactUrl;
    }
    chunks.push({
      ...chunk,
      schemaVersion: chunkSchema,
      compression: 'gzip',
      artifactUrl: artifactUrl.data,
    });
    expectedFirstProcessIndex = chunk.lastProcessIndex + 1;
  }
  if (expectedFirstProcessIndex !== processCount) {
    return invalid('v2 chunks do not cover the complete process axis');
  }

  return {
    ok: true,
    data: {
      kind: isV3 ? 'v3' : 'v2',
      version: isV3 ? 3 : 2,
      lciaAvailability: availability,
      format,
      snapshotId,
      processCount,
      impactCount,
      calculationBundleManifestUrl: bundle.data.manifestUrl,
      chunks,
    },
  };
}

export async function readProcessImpactRow(
  artifact: ParsedAllUnitQueryArtifact,
  impacts: AllUnitImpactEntry[],
  processIndex: number,
  fetchBytes: ArtifactBytesFetcher,
): Promise<AllUnitQueryResult<Array<number | null>>> {
  if (!isNonNegativeSafeInteger(processIndex) || processIndex >= artifact.processCount) {
    return invalid('process index is outside the query artifact axis');
  }
  if (artifact.kind === 'v1') {
    return { ok: true, data: [...artifact.hMatrix[processIndex]] };
  }

  const chunk = artifact.chunks.find(
    (candidate) =>
      candidate.firstProcessIndex <= processIndex && candidate.lastProcessIndex >= processIndex,
  );
  if (!chunk) {
    return invalid('no v2 chunk covers the requested process index');
  }
  const decoded = await decodeV2Chunk(chunk, impacts, fetchBytes, artifact.lciaAvailability);
  if (!decoded.ok) {
    return decoded;
  }
  const row = decoded.data.get(processIndex);
  return row ? { ok: true, data: row } : invalid('requested process row is missing from v2 chunk');
}

export async function readImpactColumn(
  artifact: ParsedAllUnitQueryArtifact,
  impacts: AllUnitImpactEntry[],
  impactIndex: number,
  processIndices: number[] | null,
  fetchBytes: ArtifactBytesFetcher,
): Promise<AllUnitQueryResult<Map<number, number>>> {
  if (!isNonNegativeSafeInteger(impactIndex) || impactIndex >= artifact.impactCount) {
    return invalid('impact index is outside the query artifact axis');
  }
  const category =
    artifact.kind === 'v1' ? null : artifact.lciaAvailability?.categories[impactIndex];
  if (category?.status === 'unavailable')
    return { ok: false, error: 'lcia_category_unavailable', detail: category.reasons.join(',') };
  const requested = processIndices === null ? null : new Set(processIndices);
  if (requested?.size) {
    for (const processIndex of requested) {
      if (!isNonNegativeSafeInteger(processIndex) || processIndex >= artifact.processCount) {
        return invalid('process index is outside the query artifact axis');
      }
    }
  }

  if (artifact.kind === 'v1') {
    const values = new Map<number, number>();
    const indices = requested ?? new Set(artifact.hMatrix.map((_row, index) => index));
    for (const processIndex of indices) {
      values.set(processIndex, artifact.hMatrix[processIndex][impactIndex]);
    }
    return { ok: true, data: values };
  }

  const values = new Map<number, number>();
  for (const chunk of artifact.chunks) {
    if (
      requested &&
      ![...requested].some(
        (processIndex) =>
          processIndex >= chunk.firstProcessIndex && processIndex <= chunk.lastProcessIndex,
      )
    ) {
      continue;
    }
    const decoded = await decodeV2Chunk(chunk, impacts, fetchBytes, artifact.lciaAvailability);
    if (!decoded.ok) {
      return decoded;
    }
    for (const [processIndex, row] of decoded.data) {
      if (!requested || requested.has(processIndex)) {
        const value = row[impactIndex];
        if (value === null || !Number.isFinite(value))
          return invalid('requested category contains an unavailable or invalid numeric value');
        values.set(processIndex, value);
      }
    }
  }
  const expectedCount = requested?.size ?? artifact.processCount;
  if (values.size !== expectedCount) {
    return invalid('v2 chunks did not return every requested process value');
  }
  return { ok: true, data: values };
}

async function decodeV2Chunk(
  chunk: AllUnitQueryV2Chunk,
  impacts: AllUnitImpactEntry[],
  fetchBytes: ArtifactBytesFetcher,
  availability: LciaAvailability | null,
): Promise<AllUnitQueryResult<Map<number, Array<number | null>>>> {
  const fetched = await fetchBytes(chunk.artifactUrl);
  if (!fetched.ok) {
    return fetched;
  }
  if (fetched.data.byteLength !== chunk.byteSize) {
    return {
      ok: false,
      error: 'query_artifact_chunk_integrity_invalid',
      detail: `path=${chunk.path} expected_bytes=${chunk.byteSize} actual_bytes=${fetched.data.byteLength}`,
    };
  }
  const actualSha256 = await sha256Hex(fetched.data);
  if (actualSha256 !== chunk.sha256.toLowerCase()) {
    return {
      ok: false,
      error: 'query_artifact_chunk_integrity_invalid',
      detail: `path=${chunk.path} sha256_mismatch`,
    };
  }

  let body: string;
  try {
    const decompressed = new Blob([new Uint8Array(fetched.data)])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    body = await new Response(decompressed).text();
  } catch (error) {
    return {
      ok: false,
      error: 'query_artifact_chunk_decode_failed',
      detail: error instanceof Error ? error.message : 'gzip_decode_failed',
    };
  }

  const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n');
  if (lines.length !== chunk.recordCount || lines.some((line) => line.length === 0)) {
    return invalid(`v2 chunk ${chunk.path} record count does not match its index`);
  }

  const impactByIdentity = new Map<string, number>();
  for (const impact of impacts) {
    impactByIdentity.set(
      impactIdentity(impact.impact_id, String(impact.impact_version ?? '')),
      impact.impact_index,
    );
  }
  const rows = new Map<number, Array<number | null>>();
  for (let recordIndex = 0; recordIndex < lines.length; recordIndex += 1) {
    let rawRecord: unknown;
    try {
      rawRecord = JSON.parse(lines[recordIndex]);
    } catch (error) {
      return {
        ok: false,
        error: 'query_artifact_chunk_decode_failed',
        detail: error instanceof Error ? error.message : 'ndjson_parse_failed',
      };
    }
    const record = asRecord(rawRecord);
    const method = asRecord(record?.method);
    const processIndex = record?.processIndex;
    const meanAmount = record?.meanAmount;
    if (!record || !method || !isNonNegativeSafeInteger(processIndex)) {
      return invalid(`v2 chunk ${chunk.path} contains an invalid LCIA record`);
    }
    const methodId = stringField(method, 'id');
    const methodVersion = stringField(method, 'version');
    const impactIndex = impactByIdentity.get(impactIdentity(methodId, methodVersion));
    if (impactIndex === undefined) {
      return invalid(`v2 chunk ${chunk.path} contains an unknown LCIA method identity`);
    }

    const category = availability?.categories[impactIndex];
    if (chunk.schemaVersion === PARTIAL_LCIA_CHUNK_SCHEMA_VERSION) {
      if (
        !category ||
        record.status !== category.status ||
        !Array.isArray(record.reasons) ||
        JSON.stringify(record.reasons) !== JSON.stringify(category.reasons) ||
        (category.status === 'unavailable'
          ? meanAmount !== null
          : typeof meanAmount !== 'number' || !Number.isFinite(meanAmount))
      ) {
        return invalid('LCIA record status/value/reasons differ from category availability');
      }
    } else if (
      typeof meanAmount !== 'number' ||
      !Number.isFinite(meanAmount) ||
      category?.status === 'unavailable'
    ) {
      return invalid('LCIA numeric record is invalid');
    }

    const expectedProcessIndex = chunk.firstProcessIndex + Math.floor(recordIndex / impacts.length);
    const expectedImpactIndex = recordIndex % impacts.length;
    if (processIndex !== expectedProcessIndex || impactIndex !== expectedImpactIndex) {
      return invalid(`v2 chunk ${chunk.path} LCIA records are incomplete or out of order`);
    }
    let row = rows.get(processIndex);
    if (!row) {
      row = Array.from({ length: impacts.length });
      rows.set(processIndex, row);
    }
    if (row[impactIndex] !== undefined) {
      return invalid(`v2 chunk ${chunk.path} contains a duplicate LCIA record`);
    }
    row[impactIndex] = meanAmount as number | null;
  }

  for (
    let processIndex = chunk.firstProcessIndex;
    processIndex <= chunk.lastProcessIndex;
    processIndex += 1
  ) {
    const row = rows.get(processIndex);
    if (
      !row ||
      row.length !== impacts.length ||
      row.some((value) => value !== null && !Number.isFinite(value))
    ) {
      return invalid(`v2 chunk ${chunk.path} has an incomplete process row`);
    }
  }
  return { ok: true, data: rows };
}

function parseCalculationBundleRef(
  raw: unknown,
  partial: boolean,
): AllUnitQueryResult<CalculationBundleRef> {
  const value = asRecord(raw);
  if (!value) {
    return invalid('v2 calculationBundle is missing');
  }
  const parsed: CalculationBundleRef = {
    schemaVersion: stringField(value, 'schemaVersion'),
    calculationId: stringField(value, 'calculationId'),
    bundleContentHash: stringField(value, 'bundleContentHash'),
    manifestUrl: stringField(value, 'manifestUrl'),
    manifestSha256: stringField(value, 'manifestSha256'),
    manifestByteSize: numberField(value, 'manifestByteSize'),
    artifactCount: numberField(value, 'artifactCount'),
  };
  if (
    parsed.schemaVersion !==
      (partial ? 'tiangong.calculation-bundle.v3' : CALCULATION_BUNDLE_SCHEMA_VERSION) ||
    !parsed.calculationId ||
    !SHA256_RE.test(parsed.bundleContentHash) ||
    !parsed.manifestUrl ||
    !SHA256_RE.test(parsed.manifestSha256) ||
    !isPositiveSafeInteger(parsed.manifestByteSize) ||
    !isPositiveSafeInteger(parsed.artifactCount)
  ) {
    return invalid('v2 calculationBundle reference is invalid');
  }
  return { ok: true, data: parsed };
}

function parseV2Chunk(raw: unknown, schemaVersion: string): AllUnitQueryResult<RawV2Chunk> {
  const value = asRecord(raw);
  if (!value) {
    return invalid('v2 chunk must be an object');
  }
  const parsed: RawV2Chunk = {
    path: stringField(value, 'path'),
    schemaVersion: stringField(value, 'schemaVersion'),
    compression: stringField(value, 'compression'),
    sha256: stringField(value, 'sha256').toLowerCase(),
    byteSize: numberField(value, 'byteSize'),
    recordCount: numberField(value, 'recordCount'),
    firstProcessIndex: numberField(value, 'firstProcessIndex'),
    lastProcessIndex: numberField(value, 'lastProcessIndex'),
  };
  if (
    !isSafeRelativePath(parsed.path) ||
    parsed.schemaVersion !== schemaVersion ||
    parsed.compression !== 'gzip' ||
    !SHA256_RE.test(parsed.sha256) ||
    !isPositiveSafeInteger(parsed.byteSize) ||
    !isPositiveSafeInteger(parsed.recordCount) ||
    !isNonNegativeSafeInteger(parsed.firstProcessIndex) ||
    !isNonNegativeSafeInteger(parsed.lastProcessIndex) ||
    parsed.lastProcessIndex < parsed.firstProcessIndex
  ) {
    return invalid('v2 chunk metadata is invalid');
  }
  return { ok: true, data: parsed };
}

function validateImpactAxis(
  impacts: AllUnitImpactEntry[],
  requireVersion: boolean,
): AllUnitQueryResult<true> {
  const sorted = [...impacts].sort((left, right) => left.impact_index - right.impact_index);
  const identities = new Set<string>();
  for (let index = 0; index < sorted.length; index += 1) {
    const impact = sorted[index];
    const version = String(impact.impact_version ?? '').trim();
    if (
      impact.impact_index !== index ||
      typeof impact.impact_id !== 'string' ||
      !impact.impact_id.trim() ||
      (requireVersion && !version) ||
      identities.has(impactIdentity(impact.impact_id, version))
    ) {
      return invalid('snapshot impact axis is invalid for an all-unit query artifact');
    }
    identities.add(impactIdentity(impact.impact_id, version));
  }
  return { ok: true, data: true };
}

function resolveBundleChildUrl(manifestUrl: string, childPath: string): AllUnitQueryResult<string> {
  if (!isSafeRelativePath(childPath)) {
    return invalid('v2 chunk path is unsafe');
  }
  try {
    const manifest = new URL(manifestUrl);
    const slash = manifest.pathname.lastIndexOf('/');
    if (slash < 0) {
      return invalid('v2 calculation bundle manifest URL has no parent path');
    }
    const parentPath = manifest.pathname.slice(0, slash + 1);
    const child = new URL(manifest.toString());
    child.pathname = `${parentPath}${childPath}`;
    child.search = '';
    child.hash = '';
    if (child.origin !== manifest.origin || !child.pathname.startsWith(parentPath)) {
      return invalid('v2 chunk path escapes its calculation bundle');
    }
    return { ok: true, data: child.toString() };
  } catch (_error) {
    return invalid('v2 calculation bundle manifest URL is invalid');
  }
}

function isSafeRelativePath(path: string): boolean {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    return false;
  }
  const segments = path.split('/');
  return segments.every((segment) => {
    if (!segment || segment === '.' || segment === '..') {
      return false;
    }
    try {
      const decoded = decodeURIComponent(segment);
      return (
        decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\')
      );
    } catch (_error) {
      return false;
    }
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(record: Record<string, unknown>, field: string): number {
  return typeof record[field] === 'number' ? record[field] : Number.NaN;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function impactIdentity(id: string, version: string): string {
  return `${id.toLowerCase()}\u0000${version}`;
}

function invalid<T = never>(detail: string): AllUnitQueryResult<T> {
  return { ok: false, error: 'query_artifact_shape_invalid', detail };
}
