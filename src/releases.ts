/**
 * Nibblets' releases, from GitHub: the latest one as JSON for the site, and
 * its files streamed from nibblets.dev, so a download button is a plain link
 * (/api/download/latest/Nibblets-arm64.dmg) that needs no JavaScript.
 */

export const REPO = "Infrawrench/nibblets";
/** How long the latest release is remembered before asking GitHub again. */
const LATEST_SECONDS = 300;
const LATEST_KEY = "https://nibblets.dev/__cache/latest-release-tag";

export interface ReleaseDeps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put">;
}

export interface Release {
  tag: string;
  version: string;
  url: string;
}

/** What /api/latest says: the release, and a link per download. */
export interface Latest {
  version: string;
  tag: string;
  url: string;
  downloads: Partial<Record<Platform, string>>;
}

export type Platform =
  | "mac-arm64"
  | "mac-x64"
  | "windows-x64"
  | "windows-arm64"
  | "linux-x64-appimage"
  | "linux-arm64-appimage"
  | "linux-x64-deb"
  | "linux-arm64-deb";

/** What every release carries, as the release workflow names it. */
export const FILES: Record<Platform, string> = {
  "mac-arm64": "Nibblets-arm64.dmg",
  "mac-x64": "Nibblets-x64.dmg",
  "windows-x64": "Nibblets-setup-x64.exe",
  "windows-arm64": "Nibblets-setup-arm64.exe",
  "linux-x64-appimage": "Nibblets-x64.AppImage",
  "linux-arm64-appimage": "Nibblets-arm64.AppImage",
  "linux-x64-deb": "Nibblets-x64.deb",
  "linux-arm64-deb": "Nibblets-arm64.deb",
};

/**
 * Which download a file is, by its name: Nibblets-arm64.dmg,
 * Nibblets-setup-x64.exe, Nibblets-x64.AppImage, Nibblets-arm64.deb and so on.
 */
export function platformOf(name: string): Platform | null {
  const arm = /arm64|aarch64/.test(name);
  const x64 = /x64|x86_64|amd64|intel/i.test(name);
  if (!arm && !x64) return null;
  const arch = arm ? "arm64" : "x64";
  if (name.endsWith(".dmg")) return `mac-${arch}`;
  if (name.endsWith(".exe")) return `windows-${arch}`;
  if (name.endsWith(".AppImage")) return `linux-${arch}-appimage`;
  if (name.endsWith(".deb")) return `linux-${arch}-deb`;
  return null;
}

/**
 * The tag github.com's /releases/latest redirects to, or null before there's
 * a release (it redirects to the releases list then). Not the API: Workers
 * share addresses, so unauthenticated API calls run out of their rate limit.
 */
export function tagFromLatestRedirect(location: string | null): string | null {
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(location ?? "");
  const tag = m?.[1] ? decodeURIComponent(m[1]) : null;
  return tag && TAG.test(tag) && tag !== "latest" ? tag : null;
}

const release = (tag: string): Release => ({
  tag,
  version: tag.replace(/^v/, ""),
  url: `https://github.com/${REPO}/releases/tag/${tag}`,
});

/** The latest published release, remembered for five minutes. Null before there is one. */
export async function latestRelease(deps: ReleaseDeps): Promise<Release | null> {
  const cached = await deps.cache.match(LATEST_KEY);
  if (cached) {
    const tag = tagFromLatestRedirect(`/releases/tag/${await cached.text()}`);
    return tag ? release(tag) : null;
  }
  const res = await deps.fetch(`https://github.com/${REPO}/releases/latest`, {
    redirect: "manual",
    headers: { "user-agent": "nibblets.dev" },
  });
  const tag = tagFromLatestRedirect(res.headers.get("location"));
  if (!tag) return null;
  await deps.cache.put(
    LATEST_KEY,
    new Response(tag, { headers: { "cache-control": `max-age=${LATEST_SECONDS}` } }),
  );
  return release(tag);
}

export function describe(r: Release): Latest {
  const downloads: Partial<Record<Platform, string>> = {};
  for (const [platform, file] of Object.entries(FILES)) {
    const known = platformOf(file);
    if (known === platform) downloads[known] = `/api/download/${r.tag}/${file}`;
  }
  return { version: r.version, tag: r.tag, url: r.url, downloads };
}

/** Tags look like v0.1.0 (or v0.1.0-beta.1); "latest" means the newest. */
export const TAG = /^(latest|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
export const FILE = /^[A-Za-z0-9._-]+$/;

const CONTENT_TYPES: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  exe: "application/vnd.microsoft.portable-executable",
  deb: "application/vnd.debian.binary-package",
  AppImage: "application/vnd.appimage",
};

/** Streams one file of a release, as an attachment. */
export async function download(tag: string, file: string, deps: ReleaseDeps): Promise<Response> {
  if (!TAG.test(tag) || !FILE.test(file)) return new Response("Not found", { status: 404 });
  const resolved = tag === "latest" ? (await latestRelease(deps))?.tag : tag;
  const res = resolved
    ? await deps.fetch(
        `https://github.com/${REPO}/releases/download/${resolved}/${encodeURIComponent(file)}`,
        { headers: { "user-agent": "nibblets.dev" } },
      )
    : null;
  // Nothing released yet, or no such file: the releases page has whatever there is.
  if (!res || res.status === 404) {
    return Response.redirect(`https://github.com/${REPO}/releases`, 302);
  }
  if (!res.ok || !res.body) return new Response("Couldn't fetch that file", { status: 502 });
  const ext = file.split(".").pop() ?? "";
  const headers = new Headers({
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${file}"`,
    // A versioned file never changes; "latest" moves on with each release.
    "cache-control":
      tag === "latest"
        ? `public, max-age=${LATEST_SECONDS}`
        : "public, max-age=31536000, immutable",
  });
  const length = res.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(res.body, { status: 200, headers });
}
