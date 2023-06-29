# coldstart

**Does your repo pass a fresh clone?**

Every README makes a promise: run these commands and it works. coldstart
checks the promise. It copies your repo into a clean temp dir, runs static
checks against what actually ships, then replays the commands your README
tells a stranger to run.

```bash
npx coldstart-cli              # the repo in the current directory
npx coldstart-cli <path>       # a local repo
npx coldstart-cli <git-url>    # or straight from GitHub
```

## What it catches

- `npm run build` when package.json has no `build` script (flagged before
  anything runs)
- `./scripts/setup.sh` that the README references but the repo forgot to ship
- `pip install -r requirements.txt` with no requirements.txt committed

## What it does

1. **Stages the committed state** into a temp dir, so `node_modules` and
   `.env` files can't hide the breakage. Git repos are cloned at depth 1;
   anything else is copied minus the usual build folders.
2. **Parses the README** for shell blocks, keeping the heading each step
   came from so the report can say where a command lives.
3. **Static checks** against the clean clone: missing scripts, missing
   referenced files.
4. **Replays each command** in order. `export` and `cd` steps update the
   session for later steps, so "set this, then run that" sequences work.
   Steps that would mutate your machine (`sudo`, `brew install`, a global
   `npm i -g`) or that need interactive input are skipped with a note.
5. **Verdict**: PASSES, RUNS-with-flags, or BROKEN at the step where a new
   user hits the wall, with the last lines of real output.

```
coldstart - fresh-clone replay
repo: broken-quickstart   readme: README.md   staged: copy of working dir (not a git repo)

static checks (against the clean clone)
  flag  `npm run start` but package.json has no "start" script (has: build, test)  [line 7]

replay (3 steps)
   1 PASS   502ms npm install
   2 FAIL   200ms npm run start
   3 skip         npm run build  (after failure)

verdict: BROKEN at step 2 - a new user following your README hits a wall there.
```

The exit code is non-zero on BROKEN - and on flags in `--only-static`, which
makes that mode a usable gate: no commands executed, just the checks.

## Options

```
--only-static   run the checks, skip executing anything
--keep-going    don't stop at the first failure
```

MIT
