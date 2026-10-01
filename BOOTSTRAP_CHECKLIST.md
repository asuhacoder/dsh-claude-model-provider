# External bootstrap boundaries

- Personal GitHub owner: asuhacoder. Enable repository private vulnerability reporting and branch rules requiring CI, a review for protected paths, and exact final-SHA checks.
- npm: account `asuha` is authenticated against the public registry, and the exact next.2 tarball passed an authenticated publication dry run. No npm version has been published. Configure npm trusted publishing/OIDC for `release.yml` and the `npm-next` environment after initial package setup; login alone does not enroll a trusted publisher. No token is requested or stored by the repair worker.
- Review current upstream service terms/required authorization for this distribution. MIT source licensing does not establish service permission.
- A separate maintainer runner and publisher GitHub App are not provisioned. Configure an isolated official coding client, one active job per fingerprint, three-attempt/one-hour budget, six-hour failure cooldown, and a publisher restricted to bot branches. Do not treat the included worker launcher as a deployed service.
- Two real Claude identities and Keychain isolation are unavailable. L4 stays BLOCKED and is explicitly waived as a publication gate. Do not duplicate one profile to label a test as two accounts.
- Publication is conditional on completion of the other tasks. `RELEASE_STATUS.md` lists the remaining review, deployment and verification boundaries; the L4 waiver does not waive those items.
- Before npm latest, require the same artifact digest through install, live and publication; independent signed evidence and 24-hour canary. The release workflow defaults to rehearsal and includes an optional exact-artifact OIDC npm-next lane. npm trusted publishing must be configured before enabling it.
