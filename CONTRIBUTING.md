# Contributing

Use Node 24 and pnpm 11.1.2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm verify`, `pnpm test:install`, and `pnpm test:coexist`. Use `pnpm test:live:single -- --live --extra-usage-off` only with explicit permission to use the account. Never weaken acceptance assertions to pass a compatibility update. Keep credential-free fixtures. Document upstream API changes with the immutable version and source. No global DSH or Claude upgrades are performed by these scripts.

## Release versions

While preparing `0.1.0`, use an increasing public prerelease counter such as `0.1.0-next.5`; publish it under the npm `next` tag. Local-only versions are never published. Do not overwrite or reuse a published version. Record the source commit, exact tarball digest and actual publication state separately, and attach that same tarball to the matching GitHub version tag. Never rebuild the tarball between final installation verification and publication.

`latest` is reserved for an approved stable release after its acceptance gates pass. A normal experimental publication must not set or preserve a stale experimental `latest` tag. After `0.1.0`, use patch versions for compatible fixes; while the public API is below `1.0.0`, use a new minor version for incompatible API changes. A version number or dist-tag alone is not evidence of stability.

## Publish a prerelease

Merge the pull request that sets `package.json` `version` and the matching `CHANGELOG.md` section. Check out that merged commit, then tag it and push the tag.

```sh
git tag vX.Y.Z-next.N
git push origin vX.Y.Z-next.N
```

The release workflow checks that the tag matches `package.json`, that the commit is on `main`, and that the version is a prerelease not already on npm. It runs the existing verification, publishes that same tarball to the npm `next` dist-tag with provenance, and creates a GitHub prerelease. It does not set `latest`. A stable version tag fails. A manual run only rehearses.

Before the first tag, register a trusted publisher on npmjs.com for GitHub Actions. Use owner `asuhacoder`, repository `dsh-claude-model-provider`, workflow `release.yml`, and environment `npm-next`. Create the GitHub environment `npm-next` with no required reviewers, and allow the tag pattern `v*`. A required reviewer blocks the automatic publish. A rule that allows only protected branches rejects a tag push. Do not create an npm token.
