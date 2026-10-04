const sensitiveKey = /authorization|token|secret|password|credential|bearer/iu;

export const REDACTED = "[REDACTED]";

/**
 * Values registered here are scrubbed out of every string this module touches,
 * so a secret that leaks into a message body, URL or subprocess output is still
 * removed even though no key name marks it as sensitive.
 */
const secrets = new Set<string>();

/** Short values are skipped: scrubbing them would mangle unrelated text. */
const minimumSecretLength = 8;

export function registerSecret(value: string | undefined): void {
  if (!value) return;
  if (value.length < minimumSecretLength) return;
  secrets.add(value);
}

/**
 * Configured resource identifiers are not credentials, but they still come out
 * of the environment file, so reports refer to them by a stable self-describing
 * label instead of their literal value. Operators keep the mapping locally;
 * artifacts stay publishable.
 */
const aliases = new Map<string, string>();

export function registerAlias(value: string | undefined, label: string): void {
  if (!value) return;
  aliases.set(value, `<${label}>`);
}

export function clearRegisteredSecrets(): void {
  secrets.clear();
  aliases.clear();
}

/** Longest first, so a value contained in another is not partly rewritten. */
function byLengthDescending(left: string, right: string): number {
  return right.length - left.length;
}

export function redactText(text: string): string {
  let result = text;
  for (const secret of [...secrets].sort(byLengthDescending)) {
    result = result.replaceAll(secret, REDACTED);
  }
  for (const value of [...aliases.keys()].sort(byLengthDescending)) {
    const label = aliases.get(value);
    if (label) result = result.replaceAll(value, label);
  }
  return result;
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(typeof value.stack === "string"
        ? { stack: redactText(value.stack) }
        : {}),
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redact(item),
      ]),
    );
  }
  return value;
}
