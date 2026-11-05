# Notes for AI agents

## Installing the themes

Do not clone or build anything. Run this once, from any folder except a copy of
this repository (on Windows, use `npx.cmd`, which works in every shell):

```sh
npx -y @materialwebunofficial/antigravity-themes install
```

It takes a few seconds and checks its own result. `Done.` on the last line and
exit code 0 mean the themes are installed, applied and permanent, so stop there.
Otherwise the output says what is wrong and the exit code is 1.

Do not use `on` or `start` in its place; they are not permanent. Do not restart
Antigravity or change its settings or files.

If Node.js is missing or older than 22, install it (`winget install
OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS), then run the
command in a new shell.

## Changing the code

See the Development section of `README.md`.
