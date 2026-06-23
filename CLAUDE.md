# Project notes for Claude

## This repo is a fork — always create PRs against BloomBooks, never upstream

`BloomBooks/bloom-parse-server` is a GitHub fork of `parse-community/parse-server-example`,
and that parent is configured as the `upstream` remote. Because of this, a plain
`gh pr create` defaults the PR **base to the upstream parent repo**, opening the PR against
`parse-community/parse-server-example` by mistake.

When creating a pull request, **always pass the repo explicitly and target `develop`**:

```bash
gh pr create --repo BloomBooks/bloom-parse-server --base develop --head <branch> ...
```

`develop` is our integration branch and is the correct PR base. The
`--repo BloomBooks/bloom-parse-server` flag is mandatory to avoid opening the PR against
the upstream parent.
