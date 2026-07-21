export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  fubApiKey: process.env.FUB_API_KEY ?? "",
  powerQueueAdminToken: process.env.POWER_QUEUE_ADMIN_TOKEN ?? "",
  // Read lazily so the key can be injected after module load (tests set it in
  // beforeEach; the deployed env injects secrets at boot). Always sanitized.
  get anthropicApiKey(): string {
    return sanitizeApiKey(process.env.ANTHROPIC_API_KEY ?? "");
  },
};

/**
 * Sanitize API keys that may contain Cyrillic homoglyphs from copy-paste.
 * Replaces common Cyrillic lookalikes with their ASCII equivalents.
 */
function sanitizeApiKey(key: string): string {
  const cyrillicToLatin: Record<string, string> = {
    '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E',
    '\u041D': 'H', '\u041A': 'K', '\u041C': 'M', '\u041E': 'O',
    '\u0420': 'P', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y',
    '\u0417': 'Z', '\u0430': 'a', '\u0435': 'e', '\u043E': 'o',
    '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
    '\u0456': 'i', '\u0457': 'i', '\u0491': 'g',
    '\u0130': 'I',
  };
  let result = '';
  for (const ch of key) {
    result += cyrillicToLatin[ch] ?? ch;
  }
  return result;
}
