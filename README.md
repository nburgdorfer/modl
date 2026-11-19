# MODL interactive results

Static research viewer for **Watertight Mesh Optimization of Textured Objects**,
adapted from `mesh_rts/visuals`. It compares reconstructions with linked cameras,
geometry, appearance, and wireframe views, plus optimization videos. Visitors
choose a scene and load it explicitly; its download size is shown first.

The website is configured for <https://nburgdorfer.github.io/modl/>. GitHub Pages
can publish immediately with empty model panels and a coming-soon message.
The Paper and Code buttons are placeholders until their links are available.
Models and videos can be enabled later by configuring a public asset host.

## Hosting layout

GitHub Pages serves the viewer and scene manifest, approximately 1 MB. Separate
public storage serves the meshes and videos. [GitHub Pages limits published
sites to 1 GB and has a soft bandwidth limit of 100 GB per
month](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

| Local collection | Size |
| --- | --- |
| Entire original `visuals/`, including generated copies and ZIP | 7.72 GiB (8.29 GB) |
| Assets used by the published exhibit | 2,839,164,794 bytes (2.64 GiB) |
| One selected scene | About 101–255 MiB |

The exhibit contains 15 scenes, 52 meshes, and 15 videos. Only the selected
scene loads. Use the prepared `exhibit/assets/` tree; the generated exports,
original source datasets, and release ZIP are not needed on the website.

## Recommended storage: Cloudflare R2 Standard

R2 Standard is a good fit for this collection: its monthly free tier includes
10 GB-month of storage, 1 million write-class operations, and 10 million
read-class operations, with no internet egress charge. This collection should
cost $0 for storage and ordinary demo traffic while those account allowances
remain available; domain registration and other services are separate.
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Use a custom asset domain for production, such as `assets.example.org`.
Cloudflare's `r2.dev` URLs are rate-limited development endpoints; the custom
domain must belong to a zone in the same Cloudflare account as the bucket.
[Public bucket setup](https://developers.cloudflare.com/r2/buckets/public-buckets/)

1. Create an R2 bucket using **Standard** storage.
2. Connect the custom asset domain in the bucket's settings.
3. Upload `exhibit/assets/` while preserving `assets/` under the chosen URL
   prefix, then apply the CORS policy in the asset-host section below.
4. Add a cache rule covering the public mesh assets. MODL, PLY, and GLB
   extensions are not cached by default. The largest current object is about
   134 MiB, within the 512 MB cacheable-file limit on Free, Pro, and Business
   plans. [Cloudflare cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
5. Set `ASSET_BASE_URL`, verify a model and video from the Pages origin, and
   follow the publishing steps below.

These are setup instructions; this repository does not create a bucket or
upload files.

### Why retain the current asset formats?

The prepared collection breaks down as follows (sizes are rounded):

| Format | Files | Size | Share |
| --- | ---: | ---: | ---: |
| MODL | 30 | 1.644 GiB | 62.2% |
| GLB | 8 | 0.707 GiB | 26.7% |
| PLY | 14 | 0.287 GiB | 10.8% |
| WebM | 15 | 6.71 MiB | 0.2% |

Parquet is a column-oriented data format with compression, useful for tabular
analysis. Converting these meshes to Parquet would require a new export schema
and browser loader; it would still require hosting the resulting files.
[Parquet overview](https://parquet.apache.org/docs/overview/)
DuckDB-Wasm can query remote data, but it does not provide storage or bypass
browser CORS requirements. Its remote reads still need an HTTPS data host and
appropriate range-request support. For this viewer, that adds another loading
layer without resolving the hosting requirement.
[DuckDB-Wasm remote-file requirements](https://www.duckdb.org/docs/2.0/clients/wasm/troubleshoot)

Ordinary Google Drive sharing links are not a direct replacement for the
`assets/` URLs expected by this viewer. Drive API integration is possible, but
would require adapting downloads around file IDs, permissions, and API access.
Keep Drive for sharing an offline package if convenient; use a public object
host for the live demos.
[Google Drive download options](https://developers.google.com/workspace/drive/api/guides/manage-downloads)

## Local development

Use Node.js 22, then run from this repository:

```sh
npm ci
npm test
npm run build
npm run preview -- --assets /home/nate/dev/mesh_rts/visuals/exhibit
```

Open <http://127.0.0.1:8080/modl/>. The preview serves the existing exhibit
assets directly, without copying them into this repository. Its `/modl/` prefix
matches the GitHub Pages project path. `npm run preview` without `--assets`
is useful once an external asset host is configured. A browser with WebGL2 is
required; opening `index.html` through `file://` will not work.

Edit the viewer in `src/` and the scene list in `public/scenes.json`. Build
output goes to `dist/`. Rebuild after source or configuration changes.

## Set up the asset host

Upload the original `exhibit/assets/` directory to public HTTPS storage that
supports browser access, such as university web hosting, S3, or Cloudflare R2.
Preserve the complete directory tree, including model companion files.

For a base URL of `https://assets.example.org/modl/`, a manifest entry such as
`assets/scan055/model-1/modl.modl` must be available at:

```text
https://assets.example.org/modl/assets/scan055/model-1/modl.modl
```

Set `assetBaseUrl` in `public/site-config.json` to that base URL. Include the
trailing slash. An empty string uses assets alongside the page for local
preview. The `ASSET_BASE_URL` build environment variable overrides this setting,
so deployment can use a GitHub repository variable without changing local
configuration. This URL is public; it must not contain credentials.

The storage host must allow cross-origin reads from
`https://nburgdorfer.github.io` (the origin has no `/modl/` path). For example,
the [R2 CORS dashboard](https://developers.cloudflare.com/r2/buckets/cors/)
accepts:

```json
[
  {
    "AllowedOrigins": ["https://nburgdorfer.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

Add `http://127.0.0.1:8080` to allowed origins when testing external assets
locally. CORS does not itself grant public access; public reads must also be
enabled on the host. Support HTTP byte ranges (`206 Partial Content`) for video
seeking. Use `video/webm` for WebM, `video/mp4` for MP4,
`model/gltf-binary` for GLB, and `application/octet-stream` for MODL and binary
PLY files. Preserve embedded model attribution and license metadata.

## Publish with GitHub Pages

1. Open **Settings → Pages** and choose **GitHub Actions** as the source.
2. Commit and push the website source to `main`, or run the **Build and deploy
   GitHub Pages** workflow manually on `main`.

With no `ASSET_BASE_URL` set, the Pages build publishes the page with empty
model panels, disabled viewer controls, and coming-soon messages. Its generated
scene manifest contains no model or video URLs, so visitors make no asset
requests. To inspect that version locally, run `npm run build:pages` followed by
`npm run preview`. The regular `npm run build` retains local mesh loading.

To enable the interactive demos later:

1. Upload the assets and verify that the public URLs and CORS headers work.
2. In **Settings → Secrets and variables → Actions → Variables**, add
   `ASSET_BASE_URL` with the HTTPS base URL.
3. Run the workflow again on `main`. The same source now builds the full viewer.

The workflow installs locked dependencies, tests, builds, and deploys only
`dist/`. It never uploads the mesh collection. Pull requests run tests and a
preview build without deploying. The production command, `npm run build:pages`,
selects placeholder or interactive mode from the asset configuration. Use
`node build.mjs --placeholder` to force a placeholder build for local inspection.
Check the workflow's returned Pages URL after it succeeds.

The [GitHub Pages custom workflow
documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
describes the required Pages environment and deployment permissions.
