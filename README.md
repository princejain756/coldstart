# coldstart

**Does your repo pass a fresh clone?**

Every README makes a promise: run these commands and it works. coldstart
checks the promise. It copies your repo into a clean temp dir, then runs the
commands your README tells a stranger to run, in order.

```bash
npx coldstart-cli              # the repo in the current directory
npx coldstart-cli <path>       # a local repo
npx coldstart-cli <git-url>    # or straight from GitHub
```

## What it does

1. **Stages the committed state** into a temp dir, so `node_modules` and
   `.env` files can't hide the breakage. Git repos are cloned at depth 1;
   anything else is copied minus the usual build folders.
2. **Parses the README** for shell blocks, keeping the heading each step
   came from so the report can say where a command lives.
3. **Replays each command** in order, in the clone, and stops at the first
   one that exits non-zero.
4. **Verdict**: PASSES, or BROKEN at the step where a new user hits the wall,
   with the last lines of real output.

```
coldstart - fresh-clone replay
repo: /Users/princejain756/src/broken-quickstart   readme: README.md   staged: copy of working dir (not a git repo)

   1 ok     502ms npm install
   2 fail   200ms npm run start
   3 skip         npm run build  (after failure)

  last output lines:
    npm error
    npm error To see a list of scripts, run:
    npm error   npm run

verdict: BROKEN at step 2 - a new user following your README hits a wall there.
```

The exit code is non-zero when the replay breaks, so it drops into CI.

## Options

```
--keep-going   don't stop at the first failure
```

MIT
