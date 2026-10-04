import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configFingerprint } from "../src/config.js";
import { UnsafeStateError } from "../src/errors.js";
import { JournalStore, advance, note, startJournal } from "../src/journal.js";
import { config, testClock, workspace } from "./helpers.js";

describe("JournalStore", () => {
  it("returns null when absent and round-trips a journal", async () => {
    const { journalPath } = await workspace("rollout-journal-");
    const store = new JournalStore(journalPath);
    await expect(store.read()).resolves.toBeNull();
    const journal = startJournal(
      "run-1",
      configFingerprint(config),
      testClock(),
    );
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
    expect(await readFile(journalPath, "utf8")).toMatch(/\n$/u);
  });

  it("writes deterministic JSON", async () => {
    const first = await workspace("rollout-journal-");
    const second = await workspace("rollout-journal-");
    const journal = startJournal(
      "run-1",
      configFingerprint(config),
      testClock(),
    );
    await new JournalStore(first.journalPath).write(journal);
    await new JournalStore(second.journalPath).write(journal);
    expect(await readFile(first.journalPath, "utf8")).toBe(
      await readFile(second.journalPath, "utf8"),
    );
  });

  it("refuses corrupt JSON", async () => {
    const { journalPath } = await workspace("rollout-journal-");
    const store = new JournalStore(journalPath);
    await store.write(startJournal("run-1", "fingerprint", testClock()));
    await writeFile(journalPath, "{broken");
    await expect(store.read()).rejects.toThrow(UnsafeStateError);
  });

  it("refuses a journal from an older schema", async () => {
    const { journalPath } = await workspace("rollout-journal-");
    const store = new JournalStore(journalPath);
    await store.write(startJournal("run-1", "fingerprint", testClock()));
    await writeFile(
      journalPath,
      JSON.stringify({ schemaVersion: 1, runId: "old", startedAt: "x" }),
    );
    await expect(store.read()).rejects.toThrow(/unsupported schemaVersion 1/u);
  });

  it("refuses a journal missing required fields or of the wrong shape", async () => {
    const { journalPath } = await workspace("rollout-journal-");
    const store = new JournalStore(journalPath);
    await store.write(startJournal("run-1", "fingerprint", testClock()));
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 2 }));
    await expect(store.read()).rejects.toThrow(/missing required fields/u);
    await writeFile(journalPath, JSON.stringify([1, 2]));
    await expect(store.read()).rejects.toThrow(/not an object/u);
  });

  it("clears a journal and tolerates a missing file", async () => {
    const { journalPath } = await workspace("rollout-journal-");
    const store = new JournalStore(journalPath);
    await store.write(startJournal("run-1", "fingerprint", testClock()));
    await store.clear();
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });
});

describe("journal transitions", () => {
  it("appends history and marks terminal phases complete", () => {
    const clock = testClock();
    let journal = startJournal("run-1", "fingerprint", clock);
    expect(journal.completed).toBe(false);
    clock.advance(1_000);
    journal = advance(
      journal,
      "candidate-deployed",
      { bundleHash: "hash" },
      clock,
    );
    expect(journal.history.map((entry) => entry.phase)).toEqual([
      "started",
      "candidate-deployed",
    ]);
    expect(journal.bundleHash).toBe("hash");
    expect(journal.completed).toBe(false);
    journal = advance(journal, "completed", {}, clock);
    expect(journal.completed).toBe(true);
  });

  it("records each reconciliation once", () => {
    const clock = testClock();
    const journal = note(
      note(startJournal("run-1", "fingerprint", clock), "resumed"),
      "resumed",
    );
    expect(journal.reconciliations).toEqual(["resumed"]);
  });
});
