/**
 * The dev server's ports were BASALT_API_PORT and BASALT_WEB_PORT until the rename to Orrama
 * (R13); only the ORRAMA_ names are read now. Without ORRAMA_API_PORT, /api is proxied to
 * :4623, the live agent and the real vault, so an old name alone must stop the dev server
 * rather than quietly point it there.
 */
export function renamedEnvProblems(e: Record<string, string | undefined>): string[] {
  return ["API_PORT", "WEB_PORT"]
    .filter((name) => e[`BASALT_${name}`] !== undefined && e[`ORRAMA_${name}`] === undefined)
    .map((name) => `BASALT_${name} is set but ORRAMA_${name} is not: set ORRAMA_${name} instead (BASALT_ names are no longer read)`);
}
