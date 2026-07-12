import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { getLoginUrl } from "./const";
import "./index.css";

/**
 * Fire-and-forget helper: sends a client-side tRPC/query error to the
 * ui_error_log table so the nightly healer can process it.
 * Never throws — must not cascade into the error handler itself.
 */
function reportClientError(error: unknown, action: string) {
  if (!(error instanceof TRPCClientError)) return;
  // Skip expected auth errors — only log real failures
  if (error.message === UNAUTHED_ERR_MSG) return;
  const body = JSON.stringify({
    "0": {
      json: {
        actor: "unknown", // auth state not available here; healer uses action path
        action,
        errorMessage: error.message.slice(0, 500),
        errorDetail: error.stack?.slice(0, 2000) ?? null,
        category: action.includes('roster') || action.includes('agent') ? 'roster' :
                  action.includes('audit') ? 'audit' :
                  action.includes('sms') || action.includes('ai') ? 'sms' : 'other',
      },
    },
  });
  fetch("/api/trpc/errors.logClientError", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body,
  }).catch(() => {});
}

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
    // Report to nightly healer
    const queryKey = String(event.query.queryKey?.[0] ?? 'unknown');
    reportClientError(error, `query:${queryKey}`);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
    // Report to nightly healer
    const mutationKey = String(event.mutation.options.mutationKey?.[0] ?? 'unknown');
    reportClientError(error, `mutation:${mutationKey}`);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </ErrorBoundary>
);
