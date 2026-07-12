import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { logUiError } from "../db";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Error logging middleware — wraps every procedure.
 * On any unexpected error (non-auth, non-validation), writes to ui_error_log.
 * Auth/validation errors are expected and not logged to avoid noise.
 */
const errorLogger = t.middleware(async ({ path, next, ctx }) => {
  const result = await next();
  if (!result.ok) {
    const err = result.error;
    // Skip expected auth/validation errors — only log real failures
    const skipCodes = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND']);
    if (!skipCodes.has(err.code)) {
      const actor = (ctx as TrpcContext).user?.name ?? 'unknown';
      // Categorise by procedure path prefix
      const category =
        path.startsWith('agent') ? 'roster' :
        path.startsWith('audit') ? 'audit' :
        path.startsWith('leads') ? 'fub_api' :
        path.startsWith('sms') || path.startsWith('ai') ? 'sms' :
        path.startsWith('auth') ? 'auth' : 'other';
      // Fire-and-forget — never await so logging can't slow down the response
      logUiError({
        actor,
        action: `trpc:${path}`,
        errorMessage: err.message ?? err.code,
        errorDetail: err.stack?.slice(0, 2000) ?? null,
        category,
      }).catch(() => {}); // swallow any logging failure
    }
  }
  return result;
});

export const publicProcedure = t.procedure.use(errorLogger);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
