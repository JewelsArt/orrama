# Installing Orrama

Orrama keeps your notes, projects, plans, people, mail and money on your own computer. Your notes
are plain text files (Markdown) in a folder you can open in Finder or File Explorer; Orrama keeps
everything else it knows beside them.

This guide covers the Mac (Apple silicon: any Mac from late 2020 on) and Windows 10 and 11.
Orrama isn't signed by Apple or Microsoft yet, so each asks you once whether to trust it. That is
expected, and the steps below get you past it.

- [On a Mac](#on-a-mac)
- [On Windows](#on-windows)
- [Your first minute](#your-first-minute)
- [Updating](#updating)
- [Backing up, and moving to a new computer](#backing-up-and-moving-to-a-new-computer)
- [Uninstalling](#uninstalling)
- [Where everything is](#where-everything-is)

## On a Mac

1. Download `Orrama_<version>_aarch64.dmg` from the release page.
2. Open it. The licence appears first (Orrama is free software under the GNU AGPL): choose
   **Agree**.
3. Drag **Orrama** onto **Applications**.
4. Open Orrama from Applications (or Launchpad).
5. The Mac says **"Orrama" Not Opened: Apple could not verify "Orrama" is free of malware…**
   Choose **Done**. (Not Move to Bin.)

   ![The Mac's first warning](install/mac-1-not-opened.png)

6. Open **System Settings → Privacy & Security** and scroll down to **Security**. It says
   **"Orrama" was blocked to protect your Mac.** Choose **Open Anyway**.

   ![Open Anyway in Privacy & Security](install/mac-2-open-anyway.png)

7. Type your Mac's password (or use Touch ID), then choose **Open Anyway** once more.

   ![The last question](install/mac-3-open.png)

You only do this once. Updates that Orrama installs itself don't ask again.

## On Windows

1. Download `Orrama_<version>_x64-setup.exe` from the release page.
2. Open it. If Windows says **Windows protected your PC**, choose **More info**, then
   **Run anyway**.

   ![SmartScreen: More info](install/win-1-smartscreen.png)
   ![SmartScreen: Run anyway](install/win-2-run-anyway.png)

3. The licence appears: choose **I Agree**. Orrama installs for you alone, so it doesn't ask for
   an administrator.
4. The last page offers to open Orrama. From then on it's in the Start menu.

### If Windows says Smart App Control blocked it

On a new Windows 11 PC, **Smart App Control** may block Orrama outright, with no Run anyway.

- To check: open **Windows Security → App & browser control → Smart App Control**. If it says
  **On**, it blocks apps that aren't signed, and Orrama isn't yet.
- What to do: tell Jules. Don't turn Smart App Control off for Orrama: on most PCs, once it's off,
  Windows won't turn it back on without a reset. The Microsoft Store version of Orrama, coming
  after the first round, gets round it.

## Your first minute

1. **Make your account**: your name, email and a password. It stays on this computer only.
2. **Where are your notes?** Start with an example (to try things on), start empty, or use a
   folder of notes you already keep. New notes go in a folder called **Orrama** in your home
   folder.
3. **How should Orr think?** Orr, Orrama's assistant, answers from your notes. Sign in with
   ChatGPT, paste a key from Anthropic or Google, or choose **Later**.

Already used Orrama on another computer? Choose **I have a backup** on the first screen instead
([below](#backing-up-and-moving-to-a-new-computer)).

## Updating

Orrama checks for a new version when it opens and every six hours. When there is one it asks
**Orrama X is ready.** with **Restart now** or **Later**. Your notes and your sign-in are kept,
and Orrama keeps a copy of its records before any update changes them.

## Backing up, and moving to a new computer

**Back up:** **Settings → Notes → Back up now**. Choose where the file goes (an external drive,
a cloud folder). Orrama makes one file, `Orrama backup <date>.zip`, with your notes and
everything Orrama keeps beside them: your account, settings, comments, each note's history. It
takes a few seconds, even for 10,000 notes. Orrama says the file's size and where it went.

Your notes are ordinary files inside it: unzip it and any text editor opens them.

**What stays behind:** the key that unlocks your mail password and Orr's AI. A lost or stolen
copy of the backup opens neither of them.

**Restore on a new computer:** install Orrama, and on the first screen choose
**I have a backup**. Pick the backup file and where your notes should go (the Orrama folder in
your home folder, unless you choose another). You sign in with the same email and password as
before. On a new computer, connect your mail and Orr's AI again in Settings: everything else comes
back as it was.

**Restore on this computer:** **Settings → Notes → Restore from a backup…** This replaces what
Orrama holds now with the backup's. The notes folder you use now stays as it is; Orrama keeps a
copy of the records it replaced.

Orrama never puts the restored notes into a folder that already has files in it unless you say
yes.

## Uninstalling

**Uninstalling never deletes your notes.** They stay in your Orrama folder (or the folder you
chose).

- **Mac:** quit Orrama and drag it from Applications to the Bin. Your notes and Orrama's records
  stay (see below), so installing it again picks up where you left off. To remove the records
  too, delete Orrama's folder in Library (below).
- **Windows:** **Settings → Apps → Installed apps → Orrama → Uninstall**. The uninstaller offers
  **Delete the application data**: ticked, Orrama's records and its saved secrets go as well;
  unticked, they stay for a reinstall. Your notes stay either way.

   ![The Windows uninstaller](install/win-3-uninstall.png)

Back up first if you might want Orrama's records again.

## Where everything is

| What | Mac | Windows |
|---|---|---|
| Your notes | `Orrama` in your home folder, or the folder you chose | `Orrama` in your user folder (`C:\Users\<you>\Orrama`), or the folder you chose |
| The app | `Applications/Orrama` | `C:\Users\<you>\AppData\Local\Orrama` |
| Orrama's records (account, settings, comments, history, log) | `Library/Application Support/com.orrama.desktop` in your home folder | `C:\Users\<you>\AppData\Local\com.orrama.desktop` |
| The key to your mail password and AI key | a file in Orrama's records, only you can read it | Windows Credential Manager, "server secrets.com.orrama.desktop" |
| Backups | wherever you saved them | wherever you saved them |

On a Mac, the Library folder is hidden: in Finder, choose **Go → Go to Folder…** and type
`~/Library/Application Support/com.orrama.desktop`. On Windows, type
`%LOCALAPPDATA%\com.orrama.desktop` in File Explorer's address bar.

Something wrong? The log is `logs/server.log` in Orrama's records. Send it to Jules.
