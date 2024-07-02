# coldstart

**Does your repo pass a fresh clone?**

Every README makes a promise: run these commands and it works. coldstart
checks the promise. It clones your repo into a clean temp dir, runs static
checks against what actually ships, then replays the commands your README
tells a stranger to run.

```bash
npx coldstart-cli              # replay the repo in the current directory
npx coldstart-cli <path>       # a local repo
npx coldstart-cli <git-url>    # or straight from GitHub
```

![coldstart replaying a broken quickstart](demo.png)

## What it catches

- `npm run build` when package.json has no `build` script (flagged before
  anything runs)
- `./scripts/setup.sh` that the README references but the repo forgot to ship
- `pip install -r requirements.txt` with no requirements.txt committed

## What it does

1. **Clones the committed state** into a temp dir, so `node_modules` and
   `.env` files can't hide the breakage. Non-git dirs get copied minus the
   usual ignored folders.
2. **Parses the README** for shell blocks in Install / Quickstart / Usage
   sections. Pasted example output and placeholder lines get filtered out.
3. **Static checks** against the clean clone: missing scripts, missing
   referenced files.
4. **Replays each command** in order. `export` and `cd` steps update the
   session for later steps, so "set this, then run that" sequences work.
   Dev servers get a 15s startup window and stay running so later steps can
   hit them. Steps that would mutate your machine (`sudo`, `brew install`, a
   global `npm i -g`) or that need interactive input are skipped with a note.
   A command that only failed because the tool isn't on this machine is
   reported as a skip, not a README failure.
   `git clone <this-repo>` at the top of a quickstart is a no-op - the clone
   is already staged - and `cd <repo>` re-enters it.
5. **Verdict**: PASSES, RUNS-with-flags, or BROKEN at the step where a new
   user hits the wall, with the last lines of real output.

```
coldstart - fresh-clone replay
repo: broken-quickstart   readme: README.md   staged: copy of working dir (not a git repo)   env: host shell

static checks (against the clean clone)
  flag  `npm run start` but package.json has no "start" script (has: build, test)  [line 7]

replay (3 steps)
   1 PASS   502ms npm install
   2 FAIL   200ms npm run start
   3 skip         npm run build  (after failure)

  last output lines:
    npm error
    npm error To see a list of scripts, run:
    npm error   npm run

verdict: BROKEN at step 2 - a new user following your README hits a wall there.
```

The report is colourised on a TTY and plain when piped, so it reads the same
in a log. The exit code is non-zero on BROKEN - and on flags in
`--only-static`, which makes that mode a usable gate: no commands executed,
just the checks.

## Example

`examples/broken-quickstart` ships a README that tells the user to
`npm run start` when the script is called `build`:

```
  flag  `npm run start` but package.json has no "start" script (has: build, test)

   1 PASS   507ms npm install
   2 FAIL   211ms npm run start
   3 skip         npm run build  (after failure)

verdict: BROKEN at step 2 - a new user following your README hits a wall there.
```

The static check caught it before a single command ran. The replay confirms
it with the real npm error.

## Development

```bash
npm run selfcheck     # fixture repos in a temp dir, real replays
```

`test/selfcheck.mjs` builds throwaway git repos whose READMEs break at a
known step, runs the CLI against them, and asserts the verdict, the failing
step, and the exit code. It is the same path a user takes - no mocking of
the runner.

## Options

```
--only-static   run the checks, skip executing anything
--keep-going    don't stop at the first failure
--json          machine-readable report
--quiet         just the verdict line
```

## Honest limits

- **Host replay shares your env.** Tools you have installed mask missing
  prerequisites a stranger wouldn't have. Host mode is the fast check.
- **POSIX shells only.** Commands run through `sh -c`; Windows READMEs with
  PowerShell blocks are detected but not replayed.
- **It replays what the README literally says.** A quickstart that works
  but is badly explained still passes; the docs-audit part is limited to
  the static checks.

MIT
