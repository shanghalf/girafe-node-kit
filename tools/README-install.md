# Checking the install by hand

Two things in the kit cannot be tested in CI, because they write outside the repository and need a
real desktop: the move to `~/GIRAFE kit` and the shortcut it leaves there. `test/install.test.js`
covers the decisions and the copying (with `GIRAFE_KIT_HOME` pointed at a temporary folder); what is
left is to see it happen once on each system, on an account that has never run the kit.

Do this after any change to `kit/install.js`, `tools/start.sh` or `tools/start.ps1`.

## Windows (a user account with no kit yet)

1. Download the release zip, unpack it in `Downloads`.
2. Double-click `Start GIRAFE kit (Windows).cmd`.
3. Expect: it says the kit now lives in `C:\Users\<you>\GIRAFE kit`, a **GIRAFE kit** shortcut
   appears on the desktop, the browser opens on the kit, and the window title says GIRAFE node kit.
4. In `Downloads`, the unpacked folder is still there, with `MOVED - read me.txt` and
   `.installed-from` in it. Nothing was deleted.
5. Close the kit. Double-click the desktop shortcut: the same kit starts, from the home folder.
6. In the kit: 🔗 Chain › **Start with the computer**. Sign out of Windows and back in: the kit is
   running (no window opens - it was started with `--no-open`); GIRAFE's Settings › Node kit ›
   "Open the kit" finds it. Turn it off again and check the item is gone from
   `shell:startup` (paste that in the Run box).
7. Unpack the same zip again somewhere else and start it: it says the home already holds a kit at
   least as new, and starts that one instead.

## macOS (a user account with no kit yet)

Same list, with `~/GIRAFE kit`, `~/Desktop/GIRAFE kit.command` and, for step 6, the LaunchAgent
`~/Library/LaunchAgents/live.girafe.kit.plist` (log out and back in). The first start of a
`.command` file needs right-click › Open.

## Linux

Same, with `~/GIRAFE kit`, `~/Desktop/girafe-kit.desktop` (mark it "Allow launching" in some file
managers) and `~/.config/autostart/girafe-kit.desktop`.

## What must never happen

- Anything in `~/GIRAFE kit workspace` (your nodes, keys, signing key, GitHub link) changed or lost.
- The folder you unpacked deleted, or its files changed other than the two notes.
- A git clone moved anywhere: in a clone, `node kit.js` and the launchers must run it where it is.
