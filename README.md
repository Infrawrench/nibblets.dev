<p align="center">
  <img src="public/og-icon.png" alt="" width="128">
</p>

# nibblets.dev

The website for [Nibblets](https://github.com/Infrawrench/nibblets): a static [Astro](https://astro.build) site, served by a small [Hono](https://hono.dev) Worker on Cloudflare.

The Worker also serves [`/install.sh`](https://nibblets.dev/install.sh), the Linux installer, fetched from the Nibblets repository's main branch. It keeps a fresh copy for five minutes and the last good copy for a week, in case GitHub can't be reached. (The installer itself installs the latest release.) While the repository is private, set a `GITHUB_TOKEN` secret so the Worker can fetch it.

The hamsters in `src/hamsters` were drawn by Nibblets' own `Hamster` component and saved as SVG.

```sh
pnpm install
pnpm dev        # the site, with Astro
pnpm preview    # the site and the Worker, with Wrangler
pnpm test
pnpm deploy
```

## Licence

GPL-2.0. See [LICENSE](LICENSE).
