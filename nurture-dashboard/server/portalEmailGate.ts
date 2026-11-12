/** Portal email suppression reads explicitly loaded provenance, never communication content. */
import { loadPortalEventPage, scanPortalEventHistory, type PortalHistoryLoader } from "./portalEventHistory";

export const PORTAL_SOURCE_NAMES = ["zillow", "realtor.com", "realtor com", "realtordotcom", "realtor dot com"] as const;
export const PORTAL_SOURCE_HOSTS = ["zillow.com", "realtor.com"] as const;

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

export function normalizePortalSource(value: string): string {
  return value.toLowerCase().replace(/[™®℠]/g, "").replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), " ").trim();
}

// The complete Realtor.com form must end at a normalized token boundary.
const REALTOR_SOURCE = /(?:realtor(?: com| dot com)|realtordotcom)(?: |$)/;
const REALTOR_TAG = /^(?:realtor(?: com| dot com)|realtordotcom)(?: |$)/;
const RECORD_FIELDS = ["isZillowPACLead", "source", "leadSource", "sourceUrl", "tags", "originalSource", "eventSource",
  "original", "event", "originalProvenance", "eventProvenance", "provenance", "events"] as const;

export function sourceMatches(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizePortalSource(value);
  return normalized.includes("zillow") || REALTOR_SOURCE.test(normalized);
}

/** sourceUrl is provenance, not a navigation target. Recover only its authority;
 * a bad scheme spelling/port cannot hide a clearly readable portal hostname. */
export function inspectPortalUrl(value: unknown): { portal: boolean; metadataUsable: boolean } {
  if (value === null || value === undefined || value === "") return { portal: false, metadataUsable: true };
  if (typeof value !== "string") return { portal: false, metadataUsable: false };
  const text = value.trim().replace(/\\/g, "/");
  if (!text) return { portal: false, metadataUsable: true };
  try {
    const scheme = text.match(/^(?:https?:|[a-z][a-z0-9+.-]*:\/\/)/i);
    const remainder = scheme ? text.slice(scheme[0].length).replace(/^\/+/, "")
      : text.startsWith("//") ? text.replace(/^\/+/, "") : text;
    const authority = remainder.split(/[/?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    if (!hostPort || /\s|[\x00-\x1f\x7f]/.test(hostPort)) return { portal: false, metadataUsable: false };
    let rawHost: string;
    if (hostPort.startsWith("[")) {
      const bracket = hostPort.match(/^(\[[^\]]+\])(?::[^:/?#]*)?$/);
      if (!bracket) return { portal: false, metadataUsable: false };
      rawHost = bracket[1];
    } else {
      if (hostPort.split(":").length > 2) return { portal: false, metadataUsable: false };
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
    return { portal: PORTAL_SOURCE_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`)), metadataUsable: true };
  } catch { return { portal: false, metadataUsable: false }; }
}

function urlMatches(value: unknown): boolean {
  return inspectPortalUrl(value).portal;
}

function tagMatches(name: string): boolean {
  const normalized = normalizePortalSource(name);
  return normalized.startsWith("zillow") || REALTOR_TAG.test(normalized);
}

/** Inspect only whitelisted own fields. Invalid explicit metadata defers, but a
 * known portal on any readable branch still wins. No person.name/content scans. */
export function inspectPortalProvenance(provenance: unknown): { portal: boolean; metadataUsable: boolean } {
  if (provenance === null || provenance === undefined) return { portal: false, metadataUsable: true };
  let portal = false;
  let metadataUsable = true;
  const pending: Array<{ value: unknown; sourceObject: boolean; topLevel: boolean }> = [{ value: provenance, sourceObject: false, topLevel: true }];
  const seenRecords = new Set<object>();
  const seenStrictRecords = new Set<object>();
  const seenSourceObjects = new Set<object>();
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  while (pending.length) {
    const entry = pending.pop()!;
    let record: Record<string, unknown>;
    try {
      if (!isRecord(entry.value)) { metadataUsable = false; continue; }
      record = entry.value;
      const seen = entry.sourceObject ? seenSourceObjects : entry.topLevel ? seenRecords : seenStrictRecords;
      if (seen.has(record)) continue;
      seen.add(record);
    } catch { metadataUsable = false; continue; }
    let recognized = false;
    for (const field of entry.sourceObject ? ["name", "source", "leadSource"] : RECORD_FIELDS) {
      let item: unknown;
      try {
        if (!Object.hasOwn(record, field)) continue;
        recognized = true;
        item = record[field];
      } catch { metadataUsable = false; continue; }
      if (item === undefined) { metadataUsable = false; continue; }
      if (item === null) continue;
      try {
        if (field === "isZillowPACLead") {
          if (item === true) portal = true;
          else if (item !== false) metadataUsable = false;
        } else if (field === "source" || field === "leadSource" || field === "name") {
          if (typeof item !== "string") metadataUsable = false;
          else if (sourceMatches(item)) portal = true;
        } else if (field === "sourceUrl") {
          const inspected = inspectPortalUrl(item);
          if (!inspected.metadataUsable) metadataUsable = false;
          if (urlMatches(item)) portal = true;
        } else if (field === "originalSource" || field === "eventSource") {
          if (typeof item === "string") { if (sourceMatches(item)) portal = true; }
          else if (isRecord(item)) pending.push({ value: item, sourceObject: true, topLevel: false });
          else metadataUsable = false;
        } else if (field === "tags" || field === "provenance" || field === "events") {
          if (!Array.isArray(item)) { metadataUsable = false; continue; }
          const length = item.length;
          for (let index = 0; index < length; index++) {
            try {
              const value = item[index];
              if (field !== "tags") {
                pending.push({ value, sourceObject: false, topLevel: false });
                continue;
              }
              const name = typeof value === "string" ? value
                : isRecord(value) && Object.hasOwn(value, "name") ? value.name : undefined;
              if (typeof name !== "string") metadataUsable = false;
              else if (tagMatches(name)) portal = true;
            } catch { metadataUsable = false; }
          }
        } else {
          pending.push({ value: item, sourceObject: false, topLevel: false });
        }
      } catch { metadataUsable = false; }
    }
    // Unrelated top-level webhook/person data is absent provenance, but an
    // explicitly named nested metadata object must have a recognized shape.
    if (!recognized && !entry.topLevel) metadataUsable = false;
  }
  return { portal, metadataUsable };
}

export function hasPortalProvenance(provenance: PortalProvenance | null | undefined): boolean {
  return inspectPortalProvenance(provenance).portal;
}

/** Generic eligibility can lack source fields; it does not authorize SMTP.
 * Explicit fields, unlike missing fields, must always be readable and valid. */
export function hasMalformedPortalMetadata(provenance: object): boolean {
  try {
    return RECORD_FIELDS.some(field => Object.hasOwn(provenance, field))
      && !inspectPortalProvenance(provenance).metadataUsable;
  } catch {
    return true;
  }
}

export type PortalEmailVerdict =
  | { allowed: true }
  | { allowed: false; reason: "PORTAL_SOURCE_EXCLUDED" | "PORTAL_PERSON_ID_UNRESOLVED" | "PORTAL_FRESH_READ_FAILED" | "PORTAL_FRESH_PERSON_UNUSABLE" | "PORTAL_PROVENANCE_UNUSABLE" | "PORTAL_HISTORY_UNAVAILABLE" | "PORTAL_HISTORY_INCOMPLETE" };

function blocked(reason: Extract<PortalEmailVerdict, { allowed: false }>["reason"]): PortalEmailVerdict {
  console.info(reason);
  return { allowed: false, reason };
}

/** No coercion of booleans/arrays/fractions; strings must be canonical safe positive integers. */
function positiveIdentity(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && String(id) === value ? id : null;
}

export function isUsablePortalPerson(person: unknown, personId: number): boolean {
  try {
    const requestedId = positiveIdentity(personId);
    if (requestedId === null || !person || typeof person !== "object" || Array.isArray(person)) return false;
    const value = person as Record<string, unknown>;
    if (!Object.hasOwn(value, "id") || positiveIdentity(value.id) !== requestedId) return false;
    // A URL/tags-only or id-only response is not a current source read.
    // Explicit blank strings and null sources are usable; absent/undefined is not.
    if (!["source", "leadSource"].some(field => Object.hasOwn(value, field)
      && (value[field] === null || typeof value[field] === "string"))) return false;
    return inspectPortalProvenance(value).metadataUsable;
  } catch {
    return false;
  }
}

/** One fresh read per attempted lead-facing SMTP send; no sent bookkeeping here. */
export async function portalEmailGate(personId: number, provenance?: PortalProvenance | null,
  historyLoader: PortalHistoryLoader | null = loadPortalEventPage): Promise<PortalEmailVerdict> {
  const original = inspectPortalProvenance(provenance);
  const requestedId = positiveIdentity(personId);
  if (requestedId === null) return blocked(original.portal ? "PORTAL_SOURCE_EXCLUDED" : "PORTAL_PERSON_ID_UNRESOLVED");
  const key = process.env.FUB_API_KEY;
  if (!key) return blocked(original.portal ? "PORTAL_SOURCE_EXCLUDED" : "PORTAL_FRESH_READ_FAILED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.followupboss.com/v1/people/${requestedId}?fields=allFields`, {
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      signal: controller.signal,
    });
    if (!response.ok) return blocked(original.portal ? "PORTAL_SOURCE_EXCLUDED" : "PORTAL_FRESH_READ_FAILED");
    const person: unknown = await response.json();
    if (original.portal || inspectPortalProvenance(person).portal) return blocked("PORTAL_SOURCE_EXCLUDED");
    if (!isUsablePortalPerson(person, requestedId)) return blocked("PORTAL_FRESH_PERSON_UNUSABLE");
    if (!original.metadataUsable) return blocked("PORTAL_PROVENANCE_UNUSABLE");
    clearTimeout(timeout); // Fresh-person deadline ends; history has its own per-page timeout.
    const history = await scanPortalEventHistory(requestedId, historyLoader, sourceMatches);
    return history.allowed ? { allowed: true } : blocked(history.reason);
  } catch {
    return blocked(original.portal ? "PORTAL_SOURCE_EXCLUDED" : "PORTAL_FRESH_READ_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

/** A skip is never represented as transport success to an exported helper's caller. */
export class PortalEmailBlockedError extends Error {
  constructor(public readonly reason: Extract<PortalEmailVerdict, { allowed: false }>["reason"]) {
    super(reason);
    this.name = "PortalEmailBlockedError";
  }
}
