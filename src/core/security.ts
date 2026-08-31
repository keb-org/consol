// security.ts — SSOT for secret detection, patterns, redaction, and categoryError helper.

export const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "auth_token",
  "authorization",
  "client_secret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "token",
]);

export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/,
  /(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,})/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z-_]{35}/,
  /Bearer\s+[^\s,;]{8,}/i,
  /Basic\s+[A-Za-z0-9+/=]{12,}/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;}{]{8,}/i,
  /:\/\/[^:\s]+:[^@\s]+@/,
];

export function configuredSecrets(): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)(?:_|$)/i.test(name)) {
      secrets.push(value);
    }
  }
  return [...new Set(secrets)];
}

function normalizedKey(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function secretInText(text: string): boolean {
  if (configuredSecrets().some((secret) => text.includes(secret))) return true;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsSecret(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return secretInText(value);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, seen));
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(normalizedKey(key))) return true;
    if (containsSecret(child, seen)) return true;
  }
  return false;
}

function redactKnownPatterns(text: string): string {
  let out = text;
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
  out = out.replace(/Bearer\s+[^\s,;]{8,}/gi, "Bearer [REDACTED]");
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [REDACTED]");
  out = out.replace(/:\/\/[^:\s]+:[^@\s]+@/g, "://[REDACTED]@");
  out = out.replace(/(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;}{]{8,}["']?/gi, (match) => {
    const sep = match.includes("=") ? "=" : ":";
    const [prefix] = match.split(sep);
    return `${prefix}${sep} [REDACTED]`;
  });
  return out;
}

export function redactSecrets(text: string): string {
  let out = redactKnownPatterns(text);
  for (const secret of configuredSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

// SSOT: Canonical helper for error message construction with category & fix instructions
export function categoryError(
  message: string,
  category: "type error" | "out-of-bounds" | "stale" | "unauthorized" | "contention",
  fix: string,
): Error {
  return new Error(`${message} — category: ${category}. Fix: ${fix}`);
}
