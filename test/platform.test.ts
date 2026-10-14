import { describe, expect, it } from "vitest";
import { hintedPlatform, osOf } from "../src/lib/platform.ts";

describe("osOf", () => {
  it("goes by the platform the browser names", () => {
    expect(osOf({ userAgent: "", platform: "Windows" })).toBe("windows");
    expect(osOf({ userAgent: "", platform: "Linux" })).toBe("linux");
    expect(osOf({ userAgent: "", platform: "macOS" })).toBe("mac");
  });

  it("falls back to the user agent", () => {
    expect(osOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0" })).toBe(
      "windows",
    );
    expect(osOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Firefox/140.0" })).toBe(
      "linux",
    );
    expect(
      osOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" }),
    ).toBe("mac");
  });

  it("leads with the Mac app on phones and anything unknown", () => {
    expect(osOf({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0" })).toBe(
      "mac",
    );
    expect(osOf({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)" })).toBe(
      "mac",
    );
    expect(osOf({ userAgent: "" })).toBe("mac");
  });
});

describe("hintedPlatform", () => {
  it("reads Chromium's hint, and nothing else", () => {
    expect(hintedPlatform({ userAgentData: { platform: "Windows" } })).toBe("Windows");
    expect(hintedPlatform({ userAgentData: null })).toBeUndefined();
    expect(hintedPlatform({})).toBeUndefined();
  });
});
