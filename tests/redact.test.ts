import { afterEach, describe, expect, it } from "vitest";
import {
  REDACTED,
  clearRegisteredSecrets,
  redact,
  redactText,
  registerAlias,
  registerSecret,
} from "../src/redact.js";
import { registerConfigForRedaction } from "../src/config.js";
import { config } from "./helpers.js";

afterEach(() => {
  clearRegisteredSecrets();
  registerConfigForRedaction(config);
});

describe("redact", () => {
  it("redacts nested sensitive keys", () => {
    expect(
      redact({
        token: "abc",
        nested: { Authorization: "Bearer abc", id: "safe" },
      }),
    ).toEqual({
      token: REDACTED,
      nested: { Authorization: REDACTED, id: "safe" },
    });
  });

  it("preserves ordinary arrays and primitive values", () => {
    expect(redact(["safe", 3, { id: "visible" }])).toEqual([
      "safe",
      3,
      { id: "visible" },
    ]);
  });

  it("scrubs a registered secret out of free text", () => {
    registerSecret("super-secret-token-value");
    expect(redactText("auth failed for super-secret-token-value")).toBe(
      `auth failed for ${REDACTED}`,
    );
  });

  it("ignores values too short to scrub safely", () => {
    clearRegisteredSecrets();
    registerSecret("abc");
    expect(redactText("abc")).toBe("abc");
    registerSecret(undefined);
    expect(redactText("abc")).toBe("abc");
  });

  it("replaces configured identifiers with stable labels", () => {
    expect(redactText(`${config.productionHostname}/*`)).toBe(
      "<production-hostname>/*",
    );
    expect(redactText(config.candidateWorker)).toBe("<candidate-worker>");
    expect(redactText(config.token)).toBe(REDACTED);
  });

  it("prefers the longest match so nested identifiers stay intact", () => {
    clearRegisteredSecrets();
    registerAlias("prod.example.test", "production-hostname");
    registerAlias("example.test", "zone-hostname");
    expect(redactText("https://prod.example.test/healthz")).toBe(
      "https://<production-hostname>/healthz",
    );
  });

  it("redacts an error without losing its shape", () => {
    registerSecret("super-secret-token-value");
    const result = redact(
      new Error("failed with super-secret-token-value"),
    ) as {
      name: string;
      message: string;
    };
    expect(result.name).toBe("Error");
    expect(result.message).toBe(`failed with ${REDACTED}`);
  });
});
