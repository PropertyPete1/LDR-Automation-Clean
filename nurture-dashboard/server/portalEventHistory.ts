/** Email authorization only. Never share this reader with inbound/SMS event retrieval.
 * Exhaustion covers API-accessible events only, not all events visible in FUB UI. */
export interface PortalHistoryRequest {
  personId: number;
  limit: 100;
  next?: string;
  offset?: number;
}
export type PortalHistoryLoader = (request: PortalHistoryRequest) => Promise<unknown>;
export type PortalHistoryVerdict =
  | { allowed: true; pages: number; rows: number }
  | { allowed: false; reason: "PORTAL_SOURCE_EXCLUDED" | "PORTAL_HISTORY_UNAVAILABLE" | "PORTAL_HISTORY_INCOMPLETE"; pages: number; rows: number };

const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 15_000;
const partialFields = ["truncated", "incomplete", "restricted", "hasMore"] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function own(value: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(value, field)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
  return value[field];
}

/** One attempt per page; abort stays active through body consumption and JSON.
 * A configured per-request timeout is not an absolute whole-history deadline. */
export async function loadPortalEventPage(request: PortalHistoryRequest): Promise<unknown> {
  const key = process.env.FUB_API_KEY;
  if (!key) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
  const query = new URLSearchParams({ personId: String(request.personId), limit: String(PAGE_SIZE) });
  if (request.next !== undefined) query.set("next", request.next);
  else if (request.offset !== undefined) query.set("offset", String(request.offset));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.followupboss.com/v1/events?${query}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (controller.signal.aborted || !response.ok) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
    const result: unknown = await response.json();
    if (controller.signal.aborted) throw new Error("PORTAL_HISTORY_UNAVAILABLE");
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** Extract only a validated official cursor. Never navigate a response URL. */
function linkCursor(link: string, personId: number): string {
  const prefix = "https://api.followupboss.com/v1/events?";
  // Check the raw endpoint before any URL normalization can erase dot segments,
  // credentials, backslashes or explicit ports (including the default HTTPS port).
  if (!link.startsWith(prefix) || /[\x00-\x20\x7f\\]/.test(link) || link.includes("#")) {
    throw new Error("PORTAL_HISTORY_INCOMPLETE");
  }
  const query = link.slice(prefix.length);
  // URLSearchParams tolerates malformed escapes/UTF-8 with literal/replacement
  // characters. Strictly validate the whole query first, including encoded keys.
  decodeURIComponent(query.replace(/\+/g, " "));
  const params = new URLSearchParams(query);
  const allowed = new Set(["personId", "limit", "next"]);
  for (const key of Array.from(params.keys())) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("PORTAL_HISTORY_INCOMPLETE");
  }
  if (params.get("personId") !== String(personId)
    || (params.has("limit") && params.get("limit") !== String(PAGE_SIZE))) {
    throw new Error("PORTAL_HISTORY_INCOMPLETE");
  }
  const cursor = params.get("next");
  if (!cursor?.trim()) throw new Error("PORTAL_HISTORY_INCOMPLETE");
  return cursor;
}

/** No cache, transport, logging or state mutations. Refusal remains retryable. */
export async function scanPortalEventHistory(
  personId: number,
  loader: PortalHistoryLoader | null | undefined,
  sourceMatches: (source: string) => boolean,
): Promise<PortalHistoryVerdict> {
  let pages = 0;
  const ids = new Set<number>();
  const cursors = new Set<string>();
  const refuse = (reason: Extract<PortalHistoryVerdict, { allowed: false }>["reason"]): PortalHistoryVerdict =>
    ({ allowed: false, reason, pages, rows: ids.size });
  if (!positiveInteger(personId)) return refuse("PORTAL_HISTORY_INCOMPLETE");
  if (typeof loader !== "function") return refuse("PORTAL_HISTORY_UNAVAILABLE");
  let total: number | undefined;
  let request: PortalHistoryRequest = { personId, limit: PAGE_SIZE };
  while (pages < MAX_PAGES) {
    let page: unknown;
    try { page = await loader(request); } catch { return refuse("PORTAL_HISTORY_UNAVAILABLE"); }
    pages++;
    let portal = false;
    let malformed = false;
    let length = 0;
    let events: unknown[] | undefined;
    try {
      if (!record(page)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
      const values = own(page, "events");
      if (!Array.isArray(values)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
      events = values;
      length = events.length;
      if (!nonnegativeInteger(length) || length > PAGE_SIZE) malformed = true;
    } catch { malformed = true; }
    // Continue across unreadable/invalid siblings so a known own-person portal wins.
    if (events) {
      for (let index = 0; index < length; index++) {
        try {
          if (!Object.hasOwn(events, index)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
          const row: unknown = events[index];
          if (!record(row)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
          let matchedPerson = false;
          let id: unknown;
          let source: unknown;
          try {
            const eventPersonId = own(row, "personId");
            matchedPerson = positiveInteger(eventPersonId) && eventPersonId === personId;
          }
          catch { malformed = true; }
          if (!matchedPerson) malformed = true;
          try {
            source = own(row, "source");
            if (source !== null && typeof source !== "string") malformed = true;
            else if (matchedPerson && typeof source === "string" && sourceMatches(source)) portal = true;
          } catch { malformed = true; }
          try {
            id = own(row, "id");
            if (!positiveInteger(id) || ids.has(id)) malformed = true;
            else ids.add(id);
          } catch { malformed = true; }
        } catch { malformed = true; }
      }
    }
    // Inspected the page before its metadata; no malformed pagination can hide portal rows.
    if (portal) return refuse("PORTAL_SOURCE_EXCLUDED");
    if (malformed) return refuse("PORTAL_HISTORY_INCOMPLETE");
    try {
      if (!record(page)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
      const meta = own(page, "_metadata");
      if (!record(meta) || own(meta, "collection") !== "events") throw new Error("PORTAL_HISTORY_INCOMPLETE");
      const pageTotal = own(meta, "total");
      if (!nonnegativeInteger(pageTotal) || (total !== undefined && total !== pageTotal)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
      total = pageTotal;
      if (ids.size > total) throw new Error("PORTAL_HISTORY_INCOMPLETE");
      let hasMore = false;
      for (const field of partialFields) {
        for (const value of [page, meta]) {
          if (!Object.hasOwn(value, field)) continue;
          const signal = value[field];
          if (typeof signal !== "boolean") throw new Error("PORTAL_HISTORY_INCOMPLETE");
          if (signal === true) {
            if (field === "hasMore") hasMore = true;
            else throw new Error("PORTAL_HISTORY_INCOMPLETE");
          }
        }
      }
      let next: string | undefined;
      if (Object.hasOwn(meta, "next")) {
        const primary = meta.next;
        if (primary !== null && typeof primary !== "string") throw new Error("PORTAL_HISTORY_INCOMPLETE");
        if (typeof primary === "string" && primary.trim()) next = primary;
      }
      if (next === undefined && Object.hasOwn(meta, "nextLink")) {
        const link = meta.nextLink;
        if (link !== null && typeof link !== "string") throw new Error("PORTAL_HISTORY_INCOMPLETE");
        if (typeof link === "string" && link.trim()) next = linkCursor(link, personId);
      }
      if (next !== undefined) {
        if (!length || ids.size >= total || cursors.has(next)) throw new Error("PORTAL_HISTORY_INCOMPLETE");
        cursors.add(next);
        request = { personId, limit: PAGE_SIZE, next };
      } else if (ids.size < total) {
        if (length !== PAGE_SIZE) throw new Error("PORTAL_HISTORY_INCOMPLETE");
        request = { personId, limit: PAGE_SIZE, offset: ids.size };
      } else {
        if (hasMore) throw new Error("PORTAL_HISTORY_INCOMPLETE");
        return { allowed: true, pages, rows: ids.size };
      }
    } catch { return refuse("PORTAL_HISTORY_INCOMPLETE"); }
  }
  return refuse("PORTAL_HISTORY_INCOMPLETE");
}
