import { describe, expect, it } from "vitest";
import { createApp, type Deps, type Env } from "../src/app.ts";
import { parseRelease, platformOf } from "../src/releases.ts";

const RELEASE = {
  tag_name: "v0.1.0",
  name: "Nibblets 0.1.0",
  body: "## What's new",
  html_url: "https://github.com/Infrawrench/nibblets/releases/tag/v0.1.0",
  published_at: "2026-10-14T12:00:00Z",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "Nibblets-arm64.dmg",
      size: 3,
      browser_download_url:
        "https://github.com/Infrawrench/nibblets/releases/download/v0.1.0/Nibblets-arm64.dmg",
    },
    {
      name: "Nibblets-x64.dmg",
      size: 3,
      browser_download_url:
        "https://github.com/Infrawrench/nibblets/releases/download/v0.1.0/Nibblets-x64.dmg",
    },
  ],
};

function setup(released: boolean) {
  const store = new Map<string, Response>();
  const asked: string[] = [];
  const deps: Deps = {
    cache: {
      match: async (key) => store.get(String(key))?.clone(),
      put: async (key, res) => void store.set(String(key), res.clone()),
    },
    fetch: async (input) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/releases/latest") || url.endsWith("/releases/tags/v0.1.0")) {
        return released ? Response.json(RELEASE) : new Response("{}", { status: 404 });
      }
      if (url.startsWith("https://github.com/") && url.endsWith(".dmg")) {
        return new Response("dmg", { headers: { "content-length": "3" } });
      }
      return new Response("nope", { status: 404 });
    },
  };
  const env: Env = {
    ASSETS: {
      fetch: async () => new Response("asset"),
      connect: () => {
        throw new Error("unused");
      },
    },
  };
  const app = createApp(() => deps);
  const get = (path: string) => app.request(`https://nibblets.dev${path}`, {}, env);
  return { get, asked };
}

describe("releases", () => {
  it("knows which download each file is", () => {
    expect(platformOf("Nibblets-arm64.dmg")).toBe("mac-arm64");
    expect(platformOf("Nibblets-x64.dmg")).toBe("mac-x64");
    expect(platformOf("Nibblets-arm64.zip")).toBeNull();
    expect(platformOf("Nibblets-setup-x64.exe")).toBe("windows-x64");
    expect(platformOf("Nibblets-setup-arm64.exe")).toBe("windows-arm64");
    expect(platformOf("Nibblets-x64.AppImage")).toBe("linux-x64-appimage");
    expect(platformOf("Nibblets-arm64.deb")).toBe("linux-arm64-deb");
  });

  it("leaves out drafts and prereleases", () => {
    expect(parseRelease({ ...RELEASE, draft: true })).toBeNull();
    expect(parseRelease({ ...RELEASE, prerelease: true })).toBeNull();
  });

  it("describes the latest release with a link per download", async () => {
    const { get } = setup(true);
    const res = await get("/api/latest");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: "0.1.0",
      downloads: {
        "mac-arm64": "/api/download/v0.1.0/Nibblets-arm64.dmg",
        "mac-x64": "/api/download/v0.1.0/Nibblets-x64.dmg",
      },
    });
  });

  it("remembers the latest release for a while", async () => {
    const { get, asked } = setup(true);
    await get("/api/latest");
    await get("/api/latest");
    expect(asked.filter((u) => u.endsWith("/releases/latest"))).toHaveLength(1);
  });

  it("streams the latest file as an attachment, from github.com rather than the API", async () => {
    const { get, asked } = setup(true);
    const res = await get("/api/download/latest/Nibblets-arm64.dmg");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dmg");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Nibblets-arm64.dmg"',
    );
    expect(res.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(asked.at(-1)).toMatch(
      /^https:\/\/github\.com\/.*\/download\/v0\.1\.0\/Nibblets-arm64\.dmg$/,
    );
  });

  it("serves a versioned file to be cached for good", async () => {
    const { get } = setup(true);
    const res = await get("/api/download/v0.1.0/Nibblets-x64.dmg");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("sends people to the releases page before there's a release", async () => {
    const { get } = setup(false);
    expect((await get("/api/latest")).status).toBe(404);
    const res = await get("/api/download/latest/Nibblets-arm64.dmg");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://github.com/Infrawrench/nibblets/releases");
  });

  it("refuses odd tags and file names", async () => {
    const { get } = setup(true);
    expect((await get("/api/download/main/Nibblets-arm64.dmg")).status).toBe(404);
    expect((await get("/api/download/v0.1.0/..%2Fsecret")).status).toBe(404);
  });
});
