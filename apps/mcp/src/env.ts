/**
 * The MCP server's settings were BASALT_URL and BASALT_TOKEN until the rename to Orrama (R13);
 * only ORRAMA_URL and ORRAMA_TOKEN are read now. A config still giving the old name is a
 * switch-over left half done: say which variable to rename (never its value) instead of
 * failing on a missing token or calling the default address.
 */
export function renamedEnvProblems(e: NodeJS.ProcessEnv): string[] {
  return ["URL", "TOKEN"]
    .filter((name) => e[`BASALT_${name}`] !== undefined && e[`ORRAMA_${name}`] === undefined)
    .map((name) => `BASALT_${name} is set but ORRAMA_${name} is not: rename it to ORRAMA_${name} in this MCP server's config (BASALT_ names are no longer read)`);
}
