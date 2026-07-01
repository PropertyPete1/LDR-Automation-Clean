import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Mobile fallback: some mobile browsers (Safari ITP, iOS WebViews, strict
      // cross-site cookie policies) drop the SameSite=None session cookie on the
      // XHR to /api/trpc even though the top-level navigation carried it. That
      // makes owner-only procedures (e.g. picks.today) 401 while public ones
      // (auth.me) still resolve, producing a dashboard that renders but shows
      // "No picks available yet".
      //
      // To make auth cookie-independent, we also hand the token to the client via
      // the URL fragment. Fragments are never sent to the server and never logged
      // by proxies/CDNs. The client reads it once, moves it into localStorage, and
      // strips it from the URL. From then on the tRPC client attaches it as a
      // Bearer header on every request, so auth works with or without the cookie.
      const encoded = encodeURIComponent(sessionToken);
      res.redirect(302, `/#session=${encoded}`);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
