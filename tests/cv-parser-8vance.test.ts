import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `server-only` is a Next.js build marker with no runtime in vitest — stub it
// so the module under test imports cleanly.
vi.mock("server-only", () => ({}));

// Guard the WS path: if parseCv8vance ever tried to open a socket in the
// no-token test, this mock would throw instead of touching the network.
vi.mock("ws", () => ({
  default: class {
    constructor() {
      throw new Error("WebSocket must not be constructed when no token is set");
    }
  },
}));

import { parseCv8vance } from "../src/lib/candidate/cv-parser-8vance";

describe("parseCv8vance — no-token fast path", () => {
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.EIGHTVANCE_CV_PARSER_TOKEN;
    delete process.env.EIGHTVANCE_CV_PARSER_TOKEN;
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env.EIGHTVANCE_CV_PARSER_TOKEN;
    else process.env.EIGHTVANCE_CV_PARSER_TOKEN = prevToken;
  });

  it("returns null immediately when the parser token is unset (no network/WS)", async () => {
    const result = await parseCv8vance("cv.pdf", "aGVsbG8=");
    expect(result).toBeNull();
  });

  it("returns null with an empty-string token too (falsy guard)", async () => {
    process.env.EIGHTVANCE_CV_PARSER_TOKEN = "";
    const result = await parseCv8vance("cv.pdf", "aGVsbG8=", { timeoutMs: 5 });
    expect(result).toBeNull();
  });
});
