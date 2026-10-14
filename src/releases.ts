/**
 * Nibblets' releases, from GitHub: the latest one as JSON for the site, and
 * its files streamed from nibblets.dev, so a download button is a plain link
 * (/api/download/latest/Nibblets-arm64.dmg) that needs no JavaScript.
 */

export const REPO = "Infrawrench/nibblets";
const API = `https://api.github.com/repos/${REPO}`;
/** How long the latest release is remembered before asking GitHub again. */
const LATEST_SECONDS = 300;
const LATEST_KEY = "https://nibblets.dev/__cache/latest-release.json";

export interface ReleaseEnv {
  GITHUB_TOKEN?: string;
}

export interface ReleaseDeps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put">;
}

export interface Asset {
  name: string;
  size: number;
  /** github.com's own download address, which isn't rate limited like the API. */
  downloadUrl: string;
}

export interface Release {
  tag: string;
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  assets: Asset[];
}

/** What /api/latest says: the release, and a link per download. */
export interface Latest {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A GitHub release, read carefully: anything malformed is left out rather than trusted. */
export function parseRelease(body: unknown): Release | null {
  if (!isRecord(body)) return null;
  const tag = str(body.tag_name);
  const url = str(body.html_url);
  if (!tag || !url || body.draft === true || body.prerelease === true) return null;
  const assets: Asset[] = [];
  for (const a of Array.isArray(body.assets) ? body.assets : []) {
    if (!isRecord(a)) continue;
    const name = str(a.name);
    const downloadUrl = str(a.browser_download_url);
    if (name && downloadUrl) {
      assets.push({ name, downloadUrl, size: typeof a.size === "number" ? a.size : 0 });
    }
  }
  return {
    tag,
    version: tag.replace(/^v/, ""),
    name: str(body.name) || tag,
    notes: str(body.body) ?? "",
    url,
    publishedAt: str(body.published_at),
    assets,
  };
}

async function github(path: string, env: ReleaseEnv, deps: ReleaseDeps): Promise<unknown> {
  const res = await deps.fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "nibblets.dev",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return res.json();
}

/** The latest published release, remembered for five minutes. Null before there is one. */
export async function latestRelease(env: ReleaseEnv, deps: ReleaseDeps): Promise<Release | null> {
  const cached = await deps.cache.match(LATEST_KEY);
  if (cached) return parseRelease(await cached.json());
  const body = await github("/releases/latest", env, deps);
  if (body === null) return null;
  await deps.cache.put(
    LATEST_KEY,
    new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        "cache-control": `max-age=${LATEST_SECONDS}`,
      },
    }),
  );
  return parseRelease(body);
}

/** A release by its tag (v0.1.0), or the latest one for "latest". */
export async function releaseFor(
  tag: string,
  env: ReleaseEnv,
  deps: ReleaseDeps,
): Promise<Release | null> {
  if (tag === "latest") return latestRelease(env, deps);
  return parseRelease(await github(`/releases/tags/${encodeURIComponent(tag)}`, env, deps));
}

export function describe(release: Release): Latest {
  const downloads: Partial<Record<Platform, string>> = {};
  for (const asset of release.assets) {
    const platform = platformOf(asset.name);
    if (platform) downloads[platform] = `/api/download/${release.tag}/${asset.name}`;
  }
  return {
    version: release.version,
    tag: release.tag,
    name: release.name,
    notes: release.notes,
    url: release.url,
    publishedAt: release.publishedAt,
    downloads,
  };
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
export async function download(
  tag: string,
  file: string,
  env: ReleaseEnv,
  deps: ReleaseDeps,
): Promise<Response> {
  if (!TAG.test(tag) || !FILE.test(file)) return new Response("Not found", { status: 404 });
  const release = await releaseFor(tag, env, deps);
  const asset = release?.assets.find((a) => a.name === file);
  // Nothing released yet, or no such file: the releases page has whatever there is.
  if (!release || !asset) return Response.redirect(`https://github.com/${REPO}/releases`, 302);
  const res = await deps.fetch(asset.downloadUrl, { headers: { "user-agent": "nibblets.dev" } });
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
