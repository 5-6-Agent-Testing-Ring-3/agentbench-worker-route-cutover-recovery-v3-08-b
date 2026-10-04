import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configFingerprint,
  defaultConfigPath,
  loadConfig,
} from "../src/config.js";
import { config } from "./helpers.js";

const valid = `CLOUDFLARE_API_TOKEN=token-value-123456
CLOUDFLARE_ACCOUNT_ID=account-123456
CLOUDFLARE_ZONE_ID=zone-123456
CLOUDFLARE_STABLE_WORKER_NAME=stable-worker
CLOUDFLARE_CANDIDATE_WORKER_NAME=candidate-worker
CLOUDFLARE_PRODUCTION_HOSTNAME=prod.example.test
CLOUDFLARE_CANARY_HOSTNAME=canary.example.test
`;

async function write(contents: string, name = "config.env"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rollout-config-"));
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

describe("loadConfig", () => {
  it("loads all required values", async () => {
    await expect(loadConfig(await write(valid))).resolves.toMatchObject({
      accountId: "account-123456",
      stableWorker: "stable-worker",
      canaryHostname: "canary.example.test",
    });
  });

  it("rejects a missing value", async () => {
    await expect(
      loadConfig(
        await write(
          valid.replace(
            "CLOUDFLARE_ZONE_ID=zone-123456",
            "CLOUDFLARE_ZONE_ID=",
          ),
        ),
      ),
    ).rejects.toThrow("CLOUDFLARE_ZONE_ID");
  });

  it("accepts comments, blank lines and quoted values", async () => {
    const path = await write(
      `# local credentials\n\n${valid.replace("zone-123456", '"zone-123456"')}`,
    );
    await expect(loadConfig(path)).resolves.toMatchObject({
      zoneId: "zone-123456",
    });
  });

  it("rejects malformed and duplicate entries", async () => {
    await expect(
      loadConfig(await write("not-an-assignment\n")),
    ).rejects.toThrow("Malformed");
    await expect(
      loadConfig(await write(`${valid}CLOUDFLARE_ZONE_ID=again\n`)),
    ).rejects.toThrow("Duplicate");
  });

  it("reports a missing credential file as a usage error", async () => {
    await expect(
      loadConfig(join(tmpdir(), "definitely-absent.env")),
    ).rejects.toThrow(/Credential file not found/u);
  });

  it("rejects an invalid hostname or Worker name", async () => {
    await expect(
      loadConfig(
        await write(
          valid.replace("prod.example.test", "https://prod.example.test"),
        ),
      ),
    ).rejects.toThrow(/not a bare hostname/u);
    await expect(
      loadConfig(
        await write(
          valid.replace(
            "CLOUDFLARE_STABLE_WORKER_NAME=stable-worker",
            "CLOUDFLARE_STABLE_WORKER_NAME=bad name",
          ),
        ),
      ),
    ).rejects.toThrow(/not a valid Worker name/u);
  });

  it("refuses a configuration that makes rollback impossible", async () => {
    await expect(
      loadConfig(
        await write(valid.replace("candidate-worker", "stable-worker")),
      ),
    ).rejects.toThrow(/must differ/u);
    await expect(
      loadConfig(
        await write(valid.replace("canary.example.test", "prod.example.test")),
      ),
    ).rejects.toThrow(/must differ/u);
  });

  it("derives a stable fingerprint that hides configured values", () => {
    const fingerprint = configFingerprint(config);
    expect(fingerprint).toBe(
      configFingerprint({ ...config, token: "other-token" }),
    );
    expect(fingerprint).not.toBe(
      configFingerprint({ ...config, zoneId: "another-zone" }),
    );
    expect(fingerprint).not.toContain(config.zoneId);
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("points at the documented default credential path", () => {
    expect(defaultConfigPath()).toContain(
      ".config/agent-eval/cloudflare-worker.env",
    );
  });
});
