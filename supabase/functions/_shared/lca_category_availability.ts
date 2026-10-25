/** Worker-owned applicability policy and complete ordered category availability wire. */
export const LCIA_APPLICABILITY_POLICY_VERSION = 'lcia.applicability.source-bound.v3';
export const LCIA_AVAILABILITY_SCHEMA_VERSION = 'lcia.category-availability.v1';

export type LciaCategoryAvailability = {
  impact_index: number;
  method_id: string;
  method_version: string;
  status: 'available' | 'unavailable';
  reasons: string[];
};

export type LciaAvailability = {
  schema_version: typeof LCIA_AVAILABILITY_SCHEMA_VERSION;
  policy_version: typeof LCIA_APPLICABILITY_POLICY_VERSION;
  completeness: 'complete' | 'partial' | 'unavailable';
  categories: LciaCategoryAvailability[];
};

export type LciaAvailabilityAxis = {
  impact_index: number;
  impact_id: string;
  impact_version?: string;
};

/** Missing/unknown availability never authorizes a numeric category. */
export function parseLciaAvailability(
  raw: unknown,
  impacts?: LciaAvailabilityAxis[],
): LciaAvailability | null {
  const value = asRecord(raw);
  if (
    !value ||
    !exactKeys(value, ['schema_version', 'policy_version', 'completeness', 'categories']) ||
    value.schema_version !== LCIA_AVAILABILITY_SCHEMA_VERSION ||
    value.policy_version !== LCIA_APPLICABILITY_POLICY_VERSION ||
    !Array.isArray(value.categories) ||
    value.categories.length === 0 ||
    value.categories.length > 256 ||
    (impacts && value.categories.length !== impacts.length)
  )
    return null;
  const orderedAxis = impacts ? [...impacts].sort((a, b) => a.impact_index - b.impact_index) : null;
  const identities = new Set<string>();
  const categories: LciaCategoryAvailability[] = [];
  for (const [index, rawCategory] of value.categories.entries()) {
    const category = asRecord(rawCategory);
    if (
      !category ||
      !exactKeys(category, ['impact_index', 'method_id', 'method_version', 'status', 'reasons']) ||
      category.impact_index !== index ||
      typeof category.method_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(category.method_id) ||
      typeof category.method_version !== 'string' ||
      !/^\d{2}\.\d{2}\.\d{3}$/.test(category.method_version) ||
      (category.status !== 'available' && category.status !== 'unavailable') ||
      !Array.isArray(category.reasons) ||
      category.reasons.length > 32 ||
      category.reasons.some(
        (reason, reasonIndex, reasons) =>
          typeof reason !== 'string' ||
          !/^[a-z0-9_]{1,160}$/.test(reason) ||
          (reasonIndex > 0 && reasons[reasonIndex - 1] >= reason),
      ) ||
      (category.status === 'available'
        ? category.reasons.length !== 0
        : category.reasons.length === 0)
    )
      return null;
    const identity = `${category.method_id.toLowerCase()}\u0000${category.method_version}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    const expected = orderedAxis?.[index];
    if (
      expected &&
      (expected.impact_index !== index ||
        category.method_id !== expected.impact_id ||
        category.method_version !== expected.impact_version)
    )
      return null;
    categories.push({
      impact_index: index,
      method_id: category.method_id,
      method_version: category.method_version,
      status: category.status,
      reasons: [...category.reasons],
    });
  }
  const available = categories.filter((category) => category.status === 'available').length;
  const completeness =
    available === categories.length ? 'complete' : available === 0 ? 'unavailable' : 'partial';
  if (value.completeness !== completeness) return null;
  return {
    schema_version: LCIA_AVAILABILITY_SCHEMA_VERSION,
    policy_version: LCIA_APPLICABILITY_POLICY_VERSION,
    completeness,
    categories,
  };
}

/** Snapshot receipt is the authoritative availability of every current calculation. */
export function parseSnapshotLciaAvailability(
  raw: unknown,
  impacts: LciaAvailabilityAxis[],
): LciaAvailability | null {
  const evidence = asRecord(raw);
  return evidence?.schema_version === 'lcia.applicability.evidence.v2' &&
    evidence.policy_version === LCIA_APPLICABILITY_POLICY_VERSION
    ? parseLciaAvailability(evidence.availability, impacts)
    : null;
}

/** Compares validated immutable receipts, including reasons and the exact method/version axis. */
export function lciaAvailabilityMatches(a: LciaAvailability, b: LciaAvailability): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
