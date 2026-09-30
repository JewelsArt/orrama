/**
 * The Authorization header for a Basalt API token.
 *
 * Tokens are minted as `bslt_<hex>`, and the .mcp.json Basalt writes asks for
 * one (`bslt_your_api_token_here`). This used to prepend `bslt_` again, so a
 * token pasted whole went out as `bslt_bslt_…` and every call was a 401 —
 * only a token with its prefix stripped by hand worked. Both forms work now.
 */
export function authHeader(token: string): string {
  const bare = token.trim().replace(/^Bearer\s+/i, "").replace(/^bslt_/, "");
  return `Bearer bslt_${bare}`;
}
