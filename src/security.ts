const SECRET_KEYS = new Set([
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

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bBearer\s+[^\s,;]{8,}/i,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[^\s"',;}{]{8,}/i,
  /:\/\/[^\s/:@]+:[^\s/@]{4,}@/,
];

function configuredSecrets() {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      Boolean(value && value.length >= 8) &&
      /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?)(?:_|$)/i.test(name)
    )
    .map(([, value]) => value as string);
}

function normalizedKey(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function secretInText(text: string) {
  return configuredSecrets().some((secret) => text.includes(secret)) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsSecret(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return secretInText(value);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, seen));
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, child]) =>
    SECRET_KEYS.has(normalizedKey(key)) || containsSecret(child, seen)
  );
}

function redactKnownPatterns(text: string) {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)["']?[^\s"',;}{]+/gi, (match, separator) => `${match.slice(0, match.indexOf(separator))}${separator}[REDACTED]`)
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://[REDACTED]@")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

export function redactSecrets(text: string) {
  let redacted = redactKnownPatterns(text);
  for (const secret of configuredSecrets()) redacted = redacted.split(secret).join("[REDACTED]");
  return redactKnownPatterns(redacted);
}
