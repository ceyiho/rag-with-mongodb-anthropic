Last updated: September 2026. This guide covers Nimbus CLI version 3.2.

# Nimbus CLI Guide

Nimbus is a command-line tool that keeps a local folder in sync with a Nimbus cloud workspace. It runs on Windows and macOS, works offline, and uploads changes when the connection returns. This guide explains how to install it, configure it, and fix the most common problems.

## Installation

### Windows

Download the installer from the Nimbus releases page and run it. The installer adds `nimbus` to your PATH, so open a new terminal window afterwards. Run `nimbus --version` to confirm the install worked; it should print 3.2 or later.

### macOS

Install with Homebrew by running `brew install nimbus`. Apple silicon and Intel Macs use the same package. If Homebrew is not installed, download the .pkg file from the releases page instead.

## Configuration

Nimbus reads its settings from a file named `nimbus.toml` in your home folder. The file is created the first time you run `nimbus init`, with sensible defaults for every setting. You only need to edit it when the defaults do not suit you.

The most important setting is `workspace`, which names the cloud workspace to sync with. Each local folder can sync with exactly one workspace. If you need to sync several workspaces, create one local folder for each, and give each folder its own `nimbus.toml` file. Nimbus looks for a `nimbus.toml` in the current folder first and falls back to the one in your home folder.

Here is a typical configuration file:

```toml
# Which cloud workspace to sync with
workspace = "team-handbook"

# Folder to keep in sync, relative to this file
local_path = "./handbook"

# How often to check for remote changes, in seconds
poll_interval = 30

[upload]
max_file_size_mb = 250
exclude = ["*.tmp", ".DS_Store", "node_modules/"]
```

The `poll_interval` setting controls how often Nimbus asks the server for remote changes. Lower values make changes appear sooner but use more battery and bandwidth. The default of 30 seconds suits most people; values below 10 seconds are rejected with error NMB-2201.

The `exclude` list uses the same patterns as a .gitignore file. Excluded files are never uploaded, but they are not deleted from the workspace if they were uploaded before you added the pattern. To remove them from the workspace, delete them there and run `nimbus sync --prune`.

File size limits protect your storage quota. Files larger than `max_file_size_mb` are skipped with a warning rather than failing the whole sync. The hard limit is 2 GB per file regardless of this setting, because the server rejects larger uploads.

Changes to `nimbus.toml` take effect the next time Nimbus starts. If Nimbus is running as a background service, restart it with `nimbus service restart` so it picks up the new settings.

Settings can also be overridden for a single run with environment variables. Each setting has a matching variable with a NIMBUS_ prefix, such as NIMBUS_POLL_INTERVAL. Environment variables take priority over the file, which is useful for testing a setting before saving it.

## Sync behaviour

Nimbus compares the local folder with the workspace every time it polls, using a checksum for each file rather than its modification time. Checksums are slower to compute, but they avoid false changes when a file is copied or restored from a backup with a new timestamp. When a file changed only locally, Nimbus uploads it. When a file changed only in the workspace, Nimbus downloads it and replaces the local copy. When a file changed on both sides since the last sync, Nimbus cannot know which version you want, so it keeps both: the local file keeps its name and the workspace version is saved next to it with ".remote" added before the extension. This situation is reported as error NMB-4012 in the log, even though nothing was lost. Deleting a file locally deletes it from the workspace on the next sync, and the workspace keeps deleted files in its trash for 30 days, so an accidental delete can be undone from the web app. Renaming a file is treated as a delete followed by an upload, which means a renamed file loses its version history in the workspace. Large folders are synced in batches of 500 files, and Nimbus finishes each batch before starting the next, so a sync that is interrupted halfway can resume without starting over. Uploads use up to four parallel connections by default; you can change this with the `parallel_uploads` setting, but values above eight rarely help because the server limits each account's throughput. While a sync is running, Nimbus locks the folder against a second Nimbus process, and a second `nimbus sync` command waits for the first one to finish rather than failing. Symbolic links are never followed, because following them could upload files from outside the synced folder. Empty folders are synced too, so a folder structure you create locally appears in the workspace even before it contains any files. Finally, Nimbus never changes line endings or file encodings: every file is uploaded byte for byte, which keeps checksums stable across Windows and macOS.

## Advanced

#### Proxy settings

If your network requires a proxy, set the HTTPS_PROXY environment variable before running Nimbus. Nimbus does not read proxy settings from the system configuration on Windows.

## Troubleshooting

### Error codes

- NMB-1001: the workspace name in `nimbus.toml` does not exist, or you do not have access to it.
- NMB-2201: `poll_interval` is below the minimum of 10 seconds.
- NMB-4012: a file changed on both sides since the last sync, and Nimbus kept both copies.
- NMB-5003: the server is unavailable; Nimbus retries automatically with increasing delays.

### Offline mode

Nimbus keeps working without a connection. Changes are queued locally and uploaded in the order they were made once the connection returns.
