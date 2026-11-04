// CLI → Worker control plane auth: a bearer CONTROL_SECRET, compared in
// constant time. Lives outside Cloudflare Access (like /webhooks/github).

export function controlAuthorized(c: {
  req: { header: (n: string) => string | undefined };
  env: { CONTROL_SECRET?: string };
}): boolean {
  const secret = c.env.CONTROL_SECRET;
  if (!secret) return false;
  const auth = c.req.header("Authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
