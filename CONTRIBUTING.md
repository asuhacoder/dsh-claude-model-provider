# Contributing

Use Node 24 and pnpm 11.1.2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm verify`, `pnpm test:install`, and `pnpm test:coexist`. Use `pnpm test:live:single -- --live --extra-usage-off` only with explicit permission to use the account. Never weaken acceptance assertions to pass a compatibility update. Keep credential-free fixtures. Document upstream API changes with the immutable version and source. No global DSH or Claude upgrades are performed by these scripts.

## Release versions

While preparing `0.1.0`, use an increasing public prerelease counter such as `0.1.0-next.5`; publish it under the npm `next` tag. Local-only versions are never published. Do not overwrite or reuse a published version. Record the source commit, exact tarball digest and actual publication state separately, and attach that same tarball to the matching GitHub version tag. Never rebuild the tarball between final installation verification and publication.

`latest` is reserved for an approved stable release after its acceptance gates pass. A normal experimental publication must not set or preserve a stale experimental `latest` tag. After `0.1.0`, use patch versions for compatible fixes; while the public API is below `1.0.0`, use a new minor version for incompatible API changes. A version number or dist-tag alone is not evidence of stability.
