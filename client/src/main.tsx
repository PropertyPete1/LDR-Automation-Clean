import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import { captureSessionTokenFromUrl, getSessionToken } from "@/lib/sessionToken";
import "./index.css";

// Capture the OAuth session token from the URL fragment (mobile cookie-independent
// auth) BEFORE React mounts, so the very first tRPC requests can attach it.
captureSessionTokenFromUrl();

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        // 1. Primary mobile-safe auth: a Bearer token persisted in localStorage
        //    from the OAuth redirect fragment. This works even when the browser
        //    drops the SameSite=None session cookie on XHR (Safari ITP, iOS
        //    WebViews, strict cross-site cookie policies) — the exact failure that
        //    made owner-only procedures like picks.today 401 on mobile.
        try {
          const stored = getSessionToken();
          if (stored) {
            return { Authorization: `Bearer ${stored}` };
          }
        } catch {
          // localStorage unavailable
        }

        // 2. Preview auto-login fallback: when running inside the Manus preview
        //    iframe, the runtime mirrors the session into sessionStorage so we can
        //    forward it as a Bearer token. The regular OAuth cookie flow keeps
        //    working and takes priority server-side.
        try {
          const raw = sessionStorage.getItem("manus-cookie");
          if (raw) {
            const prefix = `${COOKIE_NAME}=`;
            const pair = raw.split(";").find(s => s.trim().startsWith(prefix));
            const token = pair?.trim().slice(prefix.length);
            if (token) {
              return { Authorization: `Bearer ${token}` };
            }
          }
        } catch {
          // sessionStorage unavailable
        }
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

// Remove the static boot fallback once React is about to take over the root.
const bootFallback = document.getElementById("boot-fallback");
if (bootFallback) bootFallback.remove();

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);

// One-time cleanup: a previous build registered a caching service worker that
// could serve a stale/empty app shell on mobile ("No picks available yet").
// Unregister any existing service worker and purge its caches so every device
// always loads fresh code + live data. The app stays installable to the home
// screen via the web manifest alone (no SW required for Add to Home Screen).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  }).catch(() => {});
}
if (typeof caches !== "undefined" && caches.keys) {
  caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
}
