# Contributing

Use Node 24 and pnpm 11.1.2. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm verify`, `pnpm test:install`, and `pnpm test:coexist`. Use `pnpm test:live:single -- --live --extra-usage-off` only with explicit permission to use the account. Never weaken acceptance assertions to pass a compatibility update. Keep credential-free fixtures. Document upstream API changes with the immutable version and source. No global DSH or Claude upgrades are performed by these scripts.
