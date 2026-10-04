import { describe, expect, it } from "vitest";
import { stableJson } from "../src/stable-json.js";

describe("stableJson", () => {
  it("sorts keys so equal content serialises identically", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("keeps array order and drops undefined members", () => {
    expect(stableJson({ list: [3, 1, 2], gone: undefined })).toBe(
      '{\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n',
    );
  });

  it("ends with a newline", () => {
    expect(stableJson({ a: 1 }).endsWith("\n")).toBe(true);
  });
});
