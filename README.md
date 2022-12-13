# coldstart

**What does a fresh clone actually have to run?**

A README is a set of instructions, and the instructions rot. coldstart reads
your README, pulls out the shell commands it tells a stranger to type, and
prints them in order so you can see the list your project is really asking
for.

```bash
npx coldstart-cli          # the repo in the current directory
npx coldstart-cli <path>   # or any local checkout
```

Output for this repo's own example:

```
coldstart - README.md in /Users/princejain756/src/broken-quickstart

   1  npm install  (Install)
   2  npm run start  (Install)
   3  npm run build  (Install)

3 step(s) to run
```

## How it reads a README

- Every fenced block that is tagged as a shell (`bash`, `sh`, `console`,
  `shell`, `zsh`, `terminal`, or no language at all) is a candidate.
- Prompt characters (`$ `, `> `) are stripped, `#` comments are dropped.
- Lines that do not start with something that looks like a command are
  treated as pasted program output and left out.
- Each step keeps the heading it appeared under, so the report can say
  whether a command came from Install or from Contributing.

Nothing is executed yet. This is the map, not the drive.

## Why bother

Because the map is already wrong in most repos: a `npm run start` when the
script is called `build`, a `./scripts/setup.sh` nobody committed. Listing the
steps is the first step to catching that.

MIT
