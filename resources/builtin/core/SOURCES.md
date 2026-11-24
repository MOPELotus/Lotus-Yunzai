# Core card assets

These are unmodified public template resources, read from fixed Git revisions rather than a production bot's runtime files. Account records, avatars, login credentials and user-generated images are not included.

- `passport/`: Lotus-ReFactor revision `6e374cd871283f70995bd609fe20566cf2f3d9c6`, original `resources/` paths. Shared login QR, profile and check-in receipt templates. The existing donation posters use the same original font pair. See `passport/SOURCES.json` for each original path, byte length and SHA256.
- `daily-note-reminder/`: `kissnavel/bujidaoRUN` revision `158ef95861fd05f7bc5bd519e9e28d2b69f621d3`, original `resources/` paths. Original backgrounds, stamina icons and fonts for the three games' group reminders. See `daily-note-reminder/SOURCES.json`.
- `rank-fonts/`: original Noto Sans CJK SC regular/bold faces used by the rank chart, from `notofonts/noto-cjk` revision `f8d157532fbfaeda587e826d4cd5b21a49186f7c`. The upstream font license is included.
- `fonts/`: unmodified Noto Color Emoji already distributed with the meme module from `MemeCrafters/meme-generator-rs` revision `9c0607407675a2a92d4d24b5fbbeaf0cc119db67`. Its OFL 1.1 license and copyright notice are included beside the font. See `fonts/SOURCES.json`.

Each default is repository-owned. Explicit operator-supplied resource directories remain supported; a missing default no longer requires copying a legacy plugin's resource directory.
