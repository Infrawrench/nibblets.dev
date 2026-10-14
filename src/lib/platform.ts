/** Which download a visitor most likely wants, from what their browser says about itself. */
export type Os = "mac" | "windows" | "linux";

export interface Visitor {
  userAgent: string;
  /** navigator.userAgentData.platform, where there is one. */
  platform?: string | undefined;
}

export function osOf({ userAgent, platform }: Visitor): Os {
  const p = (platform ?? "").toLowerCase();
  if (p === "windows") return "windows";
  if (p === "linux" || p === "chrome os") return "linux";
  if (p === "macos") return "mac";
  // Phones say "like Mac OS X" or "Linux; Android"; neither has an app, so the Mac one leads.
  if (/iphone|ipad|android/i.test(userAgent)) return "mac";
  if (/windows/i.test(userAgent)) return "windows";
  if (/linux|x11|cros/i.test(userAgent)) return "linux";
  return "mac";
}

/** navigator.userAgentData.platform, which only Chromium has (and TypeScript's DOM types lack). */
export function hintedPlatform(nav: object): string | undefined {
  if (!("userAgentData" in nav)) return undefined;
  const data = nav.userAgentData;
  if (typeof data !== "object" || data === null || !("platform" in data)) return undefined;
  return typeof data.platform === "string" ? data.platform : undefined;
}
