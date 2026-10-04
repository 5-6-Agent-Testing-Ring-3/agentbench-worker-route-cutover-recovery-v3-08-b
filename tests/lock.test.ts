import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { UnsafeStateError } from "../src/errors.js";
import { RolloutLock } from "../src/lock.js";
import { testClock, workspace } from "./helpers.js";

describe("RolloutLock", () => {
  it("acquires and releases a lock", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const lock = new RolloutLock(lockPath, testClock());
    const held = await lock.acquire("run-1");
    expect(held.record.runId).toBe("run-1");
    expect(held.stolenFrom).toBeNull();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      runId: "run-1",
    });
    await held.release();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    await held.release();
  });

  it("refuses a second rollout while a live process holds the lock", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    const first = new RolloutLock(lockPath, clock, {
      isProcessAlive: () => true,
    });
    await first.acquire("run-1");
    const second = new RolloutLock(lockPath, clock, {
      isProcessAlive: () => true,
    });
    await expect(second.acquire("run-2")).rejects.toThrow(
      /Another rollout is already running/u,
    );
  });

  it("takes over a lock whose process is gone", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    await new RolloutLock(lockPath, clock, {
      isProcessAlive: () => true,
    }).acquire("run-1");
    const second = new RolloutLock(lockPath, clock, {
      isProcessAlive: () => false,
    });
    const held = await second.acquire("run-2");
    expect(held.stolenFrom?.runId).toBe("run-1");
  });

  it("takes over a lock that outlived its window", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    await new RolloutLock(lockPath, clock, {
      isProcessAlive: () => true,
    }).acquire("run-1");
    clock.advance(31 * 60_000);
    const held = await new RolloutLock(lockPath, clock, {
      isProcessAlive: () => true,
    }).acquire("run-2");
    expect(held.stolenFrom?.runId).toBe("run-1");
  });

  it("refuses a fresh lock held by another host", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    await new RolloutLock(lockPath, clock, { host: "other-host" }).acquire(
      "run-1",
    );
    await expect(
      new RolloutLock(lockPath, clock, { host: "this-host" }).acquire("run-2"),
    ).rejects.toThrow(UnsafeStateError);
  });

  it("treats an unreadable lock file as abandoned", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "{not json");
    const held = await new RolloutLock(lockPath, testClock()).acquire("run-1");
    expect(held.stolenFrom).toBeNull();
    await held.release();
  });

  it("does not release a lock another run has taken", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    const held = await new RolloutLock(lockPath, clock, {
      isProcessAlive: () => false,
    }).acquire("run-1");
    await new RolloutLock(lockPath, clock, {
      isProcessAlive: () => false,
    }).acquire("run-2");
    await held.release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      runId: "run-2",
    });
  });

  it("uses a real process probe by default", async () => {
    const { lockPath } = await workspace("rollout-lock-");
    const clock = testClock();
    await new RolloutLock(lockPath, clock).acquire("run-1");
    await expect(
      new RolloutLock(lockPath, clock).acquire("run-2"),
    ).rejects.toThrow(/Another rollout is already running/u);
  });
});
