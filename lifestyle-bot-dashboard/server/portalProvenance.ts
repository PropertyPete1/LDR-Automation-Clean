/** Portal evidence is limited to explicit source metadata, never contact/content fields. */
export interface PortalSourceObject {
  name?: string | null;
  source?: string | null;
  leadSource?: string | null;
}
export interface PortalProvenance {
  isZillowPACLead?: boolean | null;
  source?: string | null;
  leadSource?: string | null;
  sourceUrl?: string | null;
  tags?: Array<string | { name?: string }> | null;
  originalSource?: string | PortalSourceObject | null;
  eventSource?: string | PortalSourceObject | null;
  original?: PortalProvenance | null;
  event?: PortalProvenance | null;
  originalProvenance?: PortalProvenance | null;
  eventProvenance?: PortalProvenance | null;
  provenance?: PortalProvenance[] | null;
  events?: PortalProvenance[] | null;
}

export const PORTAL_SOURCE_NAMES: readonly string[] = [
  "zillow", "realtor com", "realtordotcom", "realtor dot com",
];

export function normalizePortalSource(value: string): string {
  return value.toLowerCase().replace(/[™®℠]/g, "").replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), " ").trim();
}

/** Exact configured portal aliases, NOT the old Zillow Rentals exclusion. */
export function isPortalSourceName(value: string): boolean {
  return PORTAL_SOURCE_NAMES.includes(normalizePortalSource(value));
}

const REALTOR_SOURCE_FORM = /(?:realtor com|realtordotcom|realtor dot com)(?: |$)/;
const REALTOR_TAG_FORM = /^(?:realtor com|realtordotcom|realtor dot com)(?: |$)/;
export function sourceMatches(value: string): boolean {
  const normalized = normalizePortalSource(value);
  return normalized.includes("zillow") || REALTOR_SOURCE_FORM.test(normalized);
}

/** Read only a recovered authority, never brand mentions in path/query/userinfo.
 * sourceUrl is provenance, not a URL we navigate: a bad port or missing scheme
 * cannot hide a clear portal host. Unreadable nonblank hosts defer the send. */
export function inspectPortalUrl(value: unknown): { portal: boolean; metadataUsable: boolean } {
  if (value === null || value === undefined || value === "") return { portal: false, metadataUsable: true };
  if (typeof value !== "string") return { portal: false, metadataUsable: false };
  const text = value.trim().replace(/\\/g, "/");
  if (!text) return { portal: false, metadataUsable: true };
  try {
    let remainder = text;
    const scheme = remainder.match(/^https?:/i) || remainder.match(/^[a-z][a-z0-9+.-]*:\/\//i);
    if (scheme) remainder = remainder.slice(scheme[0].length).replace(/^\/+/, "");
    else if (remainder.startsWith("//")) remainder = remainder.replace(/^\/+/, "");
    const authority = remainder.split(/[/?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    if (!hostPort || /\s|[\x00-\x1f\x7f]/.test(hostPort)) return { portal: false, metadataUsable: false };
    let rawHost: string;
    if (hostPort.startsWith("[")) {
      const bracket = hostPort.match(/^(\[[^\[\]]+\])(?::[^:]*|)$/);
      if (!bracket) return { portal: false, metadataUsable: false };
      rawHost = bracket[1];
    } else {
      if ((hostPort.match(/:/g) || []).length > 1) return { portal: false, metadataUsable: false };
      rawHost = hostPort.split(":", 1)[0];
      if (!rawHost || /[\[\]]/.test(rawHost)) return { portal: false, metadataUsable: false };
    }
    // Decoding is strict; URL supplies browser-equivalent IDNA hostname mapping.
    const decodedHost = decodeURIComponent(rawHost);
    if (/\s|[\x00-\x1f\x7f]/.test(decodedHost)) return { portal: false, metadataUsable: false };
    const parsed = new URL(`http://${decodedHost}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return { portal: false, metadataUsable: false };
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (host.startsWith("[")) return { portal: false, metadataUsable: true }; // parsed valid IPv6
    const labels = host.split(".");
    if (host.length > 253 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      return { portal: false, metadataUsable: false };
    }
    if (labels.length < 2 && host !== "localhost") return { portal: false, metadataUsable: false };
    return { portal: ["zillow.com", "realtor.com"].some(domain => host === domain || host.endsWith(`.${domain}`)), metadataUsable: true };
  } catch { return { portal: false, metadataUsable: false }; }
}

export function isProvenanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SOURCE_KEYS = ["source", "leadSource", "originalSource", "eventSource"];
const SOURCE_OBJECT_KEYS = ["name", "source", "leadSource"];
const OBJECT_KEYS = ["original", "event", "originalProvenance", "eventProvenance"];
const ARRAY_KEYS = ["provenance", "events"];
const RECORD_KEYS = ["isZillowPACLead", ...SOURCE_KEYS, "sourceUrl", "tags", ...OBJECT_KEYS, ...ARRAY_KEYS];

/** Inspect whitelisted own metadata, safely and cycle-free. Unknown fields on an
 * unrelated top-level snapshot are absent; explicit nested provenance must have
 * a recognized shape. Any readable portal branch wins over unreadable siblings. */
export function inspectPortalProvenance(value: unknown): { portal: boolean; metadataUsable: boolean } {
  if (value === null || value === undefined) return { portal: false, metadataUsable: true };
  const pending: Array<{ value: unknown; sourceObject: boolean; requireShape: boolean }> = [{ value, sourceObject: false, requireShape: false }];
  const seenRecords = new Set<object>();
  const seenStrictRecords = new Set<object>();
  const seenSourceObjects = new Set<object>();
  let portal = false;
  let metadataUsable = true;
  while (pending.length) {
    const entry = pending.pop()!;
    let record: Record<string, unknown>;
    try {
      if (!isProvenanceRecord(entry.value)) { metadataUsable = false; continue; }
      record = entry.value;
      const seen = entry.sourceObject ? seenSourceObjects : entry.requireShape ? seenStrictRecords : seenRecords;
      if (seen.has(record)) continue;
      seen.add(record);
    } catch { metadataUsable = false; continue; }
    let recognized = false;
    for (const key of entry.sourceObject ? SOURCE_OBJECT_KEYS : RECORD_KEYS) {
      let field: unknown;
      try {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        recognized = true;
        field = record[key];
      } catch { metadataUsable = false; continue; }
      if (field === undefined) { metadataUsable = false; continue; }
      if (field === null) continue;
      try {
        if (key === "isZillowPACLead") {
          if (field === true) portal = true;
          else if (field !== false) metadataUsable = false;
        } else if (SOURCE_KEYS.includes(key) || key === "name") {
          if (typeof field === "string") { if (sourceMatches(field)) portal = true; }
          else if (!entry.sourceObject && ["originalSource", "eventSource"].includes(key) && isProvenanceRecord(field)) {
            pending.push({ value: field, sourceObject: true, requireShape: true });
          } else metadataUsable = false;
        } else if (key === "sourceUrl") {
          const result = inspectPortalUrl(field);
          portal = result.portal || portal;
          metadataUsable = result.metadataUsable && metadataUsable;
        } else if (key === "tags") {
          if (!Array.isArray(field)) { metadataUsable = false; continue; }
          try {
            for (const tag of field) {
              let name: unknown;
              try { name = typeof tag === "string" ? tag : isProvenanceRecord(tag) && Object.prototype.hasOwnProperty.call(tag, "name") ? tag.name : undefined; }
              catch { metadataUsable = false; continue; }
              if (typeof name !== "string") { metadataUsable = false; continue; }
              const normalized = normalizePortalSource(name);
              if (normalized.startsWith("zillow") || REALTOR_TAG_FORM.test(normalized)) portal = true;
            }
          } catch { metadataUsable = false; }
        } else if (OBJECT_KEYS.includes(key)) {
          pending.push({ value: field, sourceObject: false, requireShape: true });
        } else if (ARRAY_KEYS.includes(key)) {
          if (!Array.isArray(field)) { metadataUsable = false; continue; }
          try { for (const item of field) pending.push({ value: item, sourceObject: false, requireShape: true }); }
          catch { metadataUsable = false; }
        }
      } catch { metadataUsable = false; }
    }
    if (!recognized && (entry.sourceObject || entry.requireShape)) metadataUsable = false;
  }
  return { portal, metadataUsable };
}

export function hasPortalProvenance(value: unknown): boolean {
  return inspectPortalProvenance(value).portal;
}
export function hasUsableProvenanceMetadata(value: unknown): boolean {
  return inspectPortalProvenance(value).metadataUsable;
}

/** Numeric identities only: no coercion, booleans, fractions or unsafe integers. */
export function isUsablePersonId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** An all-fields person must expose a usable scalar source, including intentional blanks. */
export function hasUsableFreshProvenance(value: unknown, personId: number): value is PortalProvenance & { id: number } {
  try {
    if (!isUsablePersonId(personId) || !isProvenanceRecord(value)) return false;
    const own = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
    if (!own("id") || !isUsablePersonId(value.id) || value.id !== personId) return false;
    if (!["source", "leadSource"].some(key => own(key) && (value[key] === null || typeof value[key] === "string"))) return false;
    return hasUsableProvenanceMetadata(value);
  } catch { return false; }
}
