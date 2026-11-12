import { isProvenanceRecord, isUsablePersonId, sourceMatches } from "./portalProvenance";

export const PORTAL_HISTORY_PAGE_LIMIT = 100;
export const PORTAL_HISTORY_MAX_PAGES = 5;
export const PORTAL_HISTORY_HTTP_TIMEOUT_MS = 15_000;
export type PortalHistoryResult =
  | { sent: true; pages: number; rows: number }
  | { sent: false; reason: "PORTAL_SOURCE" | "PORTAL_HISTORY_UNAVAILABLE" | "PORTAL_HISTORY_INCOMPLETE"; pages: number; rows: number };
export interface PortalHistoryRequest {
  personId: number;
  limit: 100;
  next?: string;
  offset?: number;
}
export type PortalHistoryLoader = (request: PortalHistoryRequest) => Promise<unknown>;

type OwnField = { present: boolean; usable: boolean; value?: unknown };
function own(record: Record<string, unknown>, key: string): OwnField {
  try {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false, usable: true };
    return { present: true, usable: true, value: record[key] };
  } catch { return { present: true, usable: false }; }
}
function record(value: unknown): value is Record<string, unknown> {
  try { return isProvenanceRecord(value); } catch { return false; }
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Extract a cursor, never navigate a server-supplied URL or accept hidden filters. */
function linkCursor(value: unknown, personId: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    // URL normalization must not conceal credentials, path traversal or controls.
    if (/\s|[\\\x00-\x1f\x7f]/.test(value) || !value.startsWith("https://api.followupboss.com/v1/events?")) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.followupboss.com" || url.port ||
        url.username || url.password || url.pathname !== "/v1/events" || url.hash) return null;
    const allowed = new Set(["personId", "limit", "next"]);
    decodeURIComponent(url.search); // URLSearchParams alone tolerates malformed escapes.
    const keys = Array.from(url.searchParams.keys());
    if (keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
    if (url.searchParams.get("personId") !== String(personId)) return null;
    if (url.searchParams.has("limit") && url.searchParams.get("limit") !== "100") return null;
    const cursor = url.searchParams.get("next");
    return cursor && cursor.trim() ? cursor : null;
  } catch { return null; }
}

/** Authorizes API-accessible own-person event history only. No cache, writes or logs.
 * Read every returned row before deferring so readable own-person portal evidence
 * wins over malformed siblings/metadata. Incomplete/nonportal history never allows. */
export async function scanPortalEventHistory(personId: number, loader?: PortalHistoryLoader | null): Promise<PortalHistoryResult> {
  let pages = 0;
  let rows = 0;
  const deferred = (): PortalHistoryResult => ({ sent: false, reason: "PORTAL_HISTORY_UNAVAILABLE", pages, rows });
  const incomplete = (): PortalHistoryResult => ({ sent: false, reason: "PORTAL_HISTORY_INCOMPLETE", pages, rows });
  if (!isUsablePersonId(personId) || typeof loader !== "function") return deferred();
  const ids = new Set<number>();
  const cursors = new Set<string>();
  let total: number | undefined;
  let request: PortalHistoryRequest = { personId, limit: 100 };
  for (let index = 0; index < PORTAL_HISTORY_MAX_PAGES; index++) {
    let page: unknown;
    pages++;
    try { page = await loader(request); } catch { return deferred(); }
    if (!record(page)) return deferred();
    const eventsField = own(page, "events");
    let events: unknown[];
    try {
      if (!eventsField.usable || !eventsField.present || !Array.isArray(eventsField.value)) return deferred();
      events = eventsField.value;
    } catch { return deferred(); }
    let length: number;
    try { length = events.length; } catch { return deferred(); }
    let partial = length > PORTAL_HISTORY_PAGE_LIMIT;
    let malformed = false;
    let portal = false;
    for (let rowIndex = 0; rowIndex < length; rowIndex++) {
      rows++;
      let event: unknown;
      try { event = events[rowIndex]; } catch { malformed = true; continue; }
      if (!record(event)) { malformed = true; continue; }
      const id = own(event, "id");
      const person = own(event, "personId");
      const source = own(event, "source");
      const matchesPerson = person.usable && person.present && isUsablePersonId(person.value) && person.value === personId;
      const sourceUsable = source.usable && source.present && (source.value === null || typeof source.value === "string");
      if (matchesPerson && sourceUsable && typeof source.value === "string" && sourceMatches(source.value)) portal = true;
      if (!matchesPerson || !sourceUsable || !id.usable || !id.present || !isUsablePersonId(id.value)) {
        malformed = true;
        continue;
      }
      if (ids.has(id.value)) partial = true;
      ids.add(id.value);
    }
    if (portal) return { sent: false, reason: "PORTAL_SOURCE", pages, rows };
    if (partial) return incomplete();
    if (malformed) return deferred();
    const metadataField = own(page, "_metadata");
    if (!metadataField.usable || !metadataField.present || !record(metadataField.value)) return deferred();
    const metadata = metadataField.value;
    const collection = own(metadata, "collection");
    const count = own(metadata, "total");
    if (!collection.usable || !collection.present || collection.value !== "events" ||
        !count.usable || !count.present || !nonnegative(count.value)) return deferred();
    if (total !== undefined && count.value !== total) return incomplete();
    total = count.value;
    for (const container of [page, metadata]) {
      for (const key of ["truncated", "incomplete", "restricted"]) {
        const flag = own(container, key);
        if (!flag.usable || (flag.present && typeof flag.value !== "boolean")) return deferred();
        if (flag.value === true) return incomplete();
      }
    }
    const next = own(metadata, "next");
    if (!next.usable || (next.present && next.value !== null && typeof next.value !== "string")) return incomplete();
    let cursor: string | null = typeof next.value === "string" && next.value.trim() ? next.value : null;
    if (cursor === null) {
      const link = own(metadata, "nextLink");
      if (!link.usable) return incomplete();
      if (link.present && link.value !== null && !(typeof link.value === "string" && !link.value.trim())) {
        cursor = linkCursor(link.value, personId);
        if (!cursor) return incomplete();
      }
    }
    if (total < ids.size) return incomplete();
    if (cursor !== null && total === ids.size) return incomplete();
    const outstanding = total > ids.size;
    const continuation = cursor !== null || outstanding;
    for (const container of [page, metadata]) {
      const flag = own(container, "hasMore");
      if (!flag.usable || (flag.present && typeof flag.value !== "boolean")) return deferred();
      if (flag.value === true && !continuation) return incomplete();
    }
    if (!continuation) return { sent: true, pages, rows };
    if (length === 0 || (!cursor && length !== PORTAL_HISTORY_PAGE_LIMIT)) return incomplete();
    if (cursor) {
      if (cursors.has(cursor)) return incomplete();
      cursors.add(cursor);
      request = { personId, limit: 100, next: cursor };
    } else {
      request = { personId, limit: 100, offset: ids.size };
    }
  }
  return incomplete();
}

/** Email-only HTTP loader: fixed endpoint/scope, one attempt, no redirects.
 * The per-request abort timer stays armed during response body and JSON parsing.
 * This is not an absolute global deadline; synchronous parsing cannot be preempted. */
export async function loadPortalEventHistoryPage(request: PortalHistoryRequest, apiKey: string): Promise<unknown> {
  if (!isUsablePersonId(request.personId) || request.limit !== 100 ||
      (request.next !== undefined && (typeof request.next !== "string" || !request.next.trim())) ||
      (request.offset !== undefined && !nonnegative(request.offset)) ||
      (request.next !== undefined && request.offset !== undefined)) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
  const query = new URLSearchParams({ personId: String(request.personId), limit: "100" });
  if (request.next !== undefined) query.set("next", request.next);
  if (request.offset !== undefined) query.set("offset", String(request.offset));
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), PORTAL_HISTORY_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.followupboss.com/v1/events?${query}`, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: "Basic " + Buffer.from(`${apiKey}:`).toString("base64"), Accept: "application/json" },
    });
    if (!response.ok || response.redirected) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
    const page: unknown = await response.json();
    if (controller.signal.aborted || Date.now() - started >= PORTAL_HISTORY_HTTP_TIMEOUT_MS) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
    return page;
  } catch { throw new Error("PORTAL_HISTORY_UNAVAILABLE"); }
  finally { clearTimeout(timer); }
}
