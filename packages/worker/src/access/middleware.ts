import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { verifyAccessJwt } from "./jwt";

export interface AccessVariables {
  accessEmail?: string;
}

const COOKIE_NAME = "CF_Authorization";

function tokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=");
  }
  return undefined;
}

/**
 * Gates a route group behind a verified Cloudflare Access token. No-ops when
 * ACCESS_AUD is unset, so public-repo mirrors stay open until the user opts in
 * via `gitflare access enable`. Defense-in-depth: Access also blocks at the
 * edge, but this middleware is the real boundary inside the Worker.
 */
export const accessGuard: MiddlewareHandler<{
  Bindings: Env;
  Variables: AccessVariables;
}> = async (c, next) => {
  const aud = c.env.ACCESS_AUD;
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  if (!aud || !teamDomain) return next(); // public mirror

  const token =
    c.req.header("Cf-Access-Jwt-Assertion") ??
    tokenFromCookie(c.req.header("Cookie"));
  if (!token) return c.text("Forbidden — Cloudflare Access required", 403);

  const claims = await verifyAccessJwt(token, { aud, teamDomain });
  if (!claims) return c.text("Forbidden — invalid Access token", 403);

  if (claims.email) c.set("accessEmail", claims.email);
  return next();
};
