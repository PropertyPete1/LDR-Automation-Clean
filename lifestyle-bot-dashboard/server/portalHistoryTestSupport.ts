/** Synthetic response router for Candidate 3 positive tests; never bypasses the gate. */
export function withCompleteHistory(personResponse: unknown) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.followupboss.com") throw new Error("SYNTHETIC_UNEXPECTED_REQUEST");
    if (/^\/v1\/people\/\d+$/.test(url.pathname) && url.search === "?fields=allFields") return personResponse as Response;
    if (url.pathname === "/v1/events" && url.searchParams.get("limit") === "100" &&
        /^\d+$/.test(url.searchParams.get("personId") ?? "") && Array.from(url.searchParams.keys()).length === 2) {
      return {
        ok: true, status: 200,
        json: async () => ({ events: [], _metadata: { collection: "events", total: 0 } }),
      } as Response;
    }
    throw new Error("SYNTHETIC_UNEXPECTED_REQUEST");
  };
}
