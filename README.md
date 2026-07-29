# repo-lib

`repo-lib` is a small local companion for projects whose source code lives in
remote Git repositories. It keeps only untracked, machine-local project files
such as `.env` files in a separate **library**, then restores those files into
the corresponding project in a **worktree**.

> [!WARNING]
> The library is plain, unencrypted storage and may contain passwords, API keys,
> certificates, and other secrets. Keep it private, protect it with appropriate
> filesystem permissions and backups, and never publish or commit it.

`repo-lib` is an interactive terminal application built with React and Ink. It
requires Node.js **22.12 or newer**.

## Concepts

- The **worktree root** contains normal Git projects.
- The **library root** mirrors project paths beneath the worktree root.
- Each registered remote-backed project has a reserved `remote-repo.txt` file
  containing its selected Git fetch URL.
- Tracked Git files are never stored in the library. This includes files staged
  for addition and files deleted from disk but still present in the index.
- Nested Git repositories, submodules, and linked worktrees are separate
  projects. Operations on a parent project do not enter them.
- The current project is determined from the current directory with Git's
  project root. It must be registered beneath the configured worktree root.

One active library/worktree pair is stored in the operating system's user
configuration directory.

## Quick start

Run the published CLI without installing it globally:

```sh
npx @alexissliwak/repo-lib init
```

You can also install it globally with pnpm:

```sh
pnpm add --global @alexissliwak/repo-lib
repo-lib --help
```

During `init`, choose one of two modes:

1. **Create an empty library** records the library and worktree roots without
   importing project payload.
2. **Build from an existing worktree** discovers Git projects under the chosen
   worktree. A project with one remote is associated automatically; if it has
   several, you select one. Only `remote-repo.txt` markers are created—tracked
   and untracked worktree files are not copied.

If a discovered repository has no remote, `init` explains that its tracked
source will not be backed up and asks whether to register it as local-only. You
can add a Git remote later and run `npx @alexissliwak/repo-lib push`.

The library destination must be empty, and the library and worktree roots must
not overlap.

## Commands

Run project commands from anywhere inside the intended Git project.

### `repo-lib init`

Interactively creates the active configuration and optionally discovers
projects in an existing worktree.

```sh
npx @alexissliwak/repo-lib init
```

Initialization shows the plaintext-storage warning before configuration is
saved. It does not copy untracked files from an existing worktree.

### `repo-lib add <path...>`

Explicitly adds files or directories from the current project to its library:

```sh
npx @alexissliwak/repo-lib add .env config/local.json private-certs/
```

Directories are traversed recursively. Only untracked regular files are copied.
Explicitly named ignored files are eligible, which makes `add` the appropriate
command for `.env` and similar files. Tracked files, `.git`,
`remote-repo.txt`, nested projects, symlinks, and junctions are skipped.

All paths must remain inside the current Git project.

### `repo-lib push [--all]`

Updates the library from the current worktree:

```sh
# Refresh only payload already represented in the library
npx @alexissliwak/repo-lib push

# Also discover new, non-ignored untracked files
npx @alexissliwak/repo-lib push --all
```

Before copying, both forms remove library payload that has become tracked and
prune empty directories. The default form updates existing library payload when
the corresponding worktree file still exists; a library file is preserved when
its worktree counterpart is missing.

`--all` additionally previews and asks before copying new, non-ignored,
untracked files. Newly ignored files are not bulk-added and must be selected
explicitly with `repo-lib add`.

For a local-only project, `push` warns that tracked source is not backed up and
asks for confirmation. If remotes have since been added, it creates a marker
after selecting the intended remote when necessary. An existing marker that no
longer matches any configured remote is treated as an error.

### `repo-lib pull`

Updates tracked source and then overlays the current project's library payload:

```sh
npx @alexissliwak/repo-lib pull
```

For a remote-backed project, `pull` requires:

- a clean tracked worktree;
- an attached branch with an upstream; and
- an upstream remote URL matching `remote-repo.txt`.

It runs a fast-forward-only Git pull. If Git cannot fast-forward, no library
payload is overlaid. After a successful Git update, files that have become
tracked are removed from the library, then the remaining library files are
copied to the worktree.

Differing untracked destination files are previewed and require one
confirmation. File/directory type conflicts stop the operation safely. If that
confirmation is cancelled after Git updated, the Git update remains but no
library payload is copied.

For a local-only project, no Git pull is attempted. The command warns that
tracked source cannot be restored and offers the same payload overlay flow.

### `repo-lib list`

Lists the current project's stored payload files in stable, project-relative
order:

```sh
npx @alexissliwak/repo-lib list
```

The reserved marker and nested projects are not shown.

### Help and version

```sh
npx @alexissliwak/repo-lib --help
npx @alexissliwak/repo-lib --version
npx @alexissliwak/repo-lib push --help
```

## Safety behavior

- Git commands are invoked directly without a shell.
- Copy targets are canonicalized and constrained to the configured roots.
- Symlinks and junctions are skipped rather than followed.
- Copies use temporary sibling files and atomic replacement where supported.
- Tracked payload is removed from the library on every `push` and `pull`.
- `remote-repo.txt` is metadata only and is never copied into a worktree.
- New ignored files are copied only when explicitly named with `add`.

`repo-lib` is not a replacement for a secret manager, encryption, access
controls, or a backup of remote Git repositories.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Command succeeded, including a safe no-op. |
| `1` | Operational failure, such as a Git, filesystem, or configuration error. |
| `2` | Invalid command-line usage. |
| `130` | The user cancelled an interactive operation. |

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run coverage
pnpm run build
pnpm run pack:verify
```

Tests use isolated real Git repositories and local bare remotes; they do not
need network access. Continuous integration runs on Windows and Ubuntu with
Node.js 22 and 24. The repository pins pnpm through the `packageManager` field;
`package-lock.json` is intentionally not used.

## Publishing

Publishing is intentionally manual. Before release:

1. Confirm the package name is still available and that the registry account has
   permission to publish it:

   ```sh
   pnpm view @alexissliwak/repo-lib name version
   ```

   An unclaimed name normally returns a registry `E404`; a successful response
   means the name is already registered and ownership must be verified.

2. Run the complete verification suite:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm test
   pnpm run coverage
   pnpm run build
   pnpm run pack:verify
   ```

3. Inspect the generated package archive, then publish publicly:

   ```sh
   pnpm publish --access public
   ```

The npm package should contain only compiled output, this README, the license,
and package metadata.

## License

[MIT](LICENSE)
