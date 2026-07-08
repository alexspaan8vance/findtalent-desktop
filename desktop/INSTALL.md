# FindTalent Desktop — install & use

FindTalent as a Windows desktop app. Everything runs **locally on your PC** — a
local database, your own 8vance credentials, no server to manage.

## Install (the easy way — installer, auto-updates)
1. Download the latest **`FindTalent-Setup-x.y.z.exe`** from the
   [Releases page](https://github.com/alexspaan8vance/findtalent-desktop/releases).
2. Run it. (Windows may show a SmartScreen warning for an unsigned app → *More
   info → Run anyway*.)
3. On first launch a window pops up with your **one-time admin login**
   (email + password). Write it down.

New versions **auto-update** on launch (see below).

## Install (alternative — portable, no installer)
Prefer not to run an installer? Download **`FindTalent-x.y.z-win.zip`** from
Releases, unzip anywhere (e.g. your Desktop), and run **`FindTalent.exe`** inside.
Same first-run login. To update, download the newer zip and replace the folder
(your data lives elsewhere — see below — so it's kept).

## First-run setup (2 minutes)
1. Log in with the one-time credentials.
2. **Settings → change your password.**
3. **Admin → Talent pools → Add pool** → paste **your own 8vance**:
   - Client ID
   - Client Secret
   - Company ID
   Save. (These are stored **encrypted on your PC only** — never uploaded, never
   in this repo.)
4. **Candidates → Onboard candidate** → add a candidate (paste a CV or fill the
   form) → the app matches them to jobs and shows scores.

You're done.

## Updates (automatic)
When we publish a new version, the app **checks on launch**, downloads it in the
background, and asks to **restart to install** — one click. You can also just
download the newer `.exe` from Releases.

## Build it yourself (optional)
Requires Node 20+.
```bash
git clone https://github.com/alexspaan8vance/findtalent-desktop
cd findtalent-desktop
npm ci
npm run desktop:build      # → dist-desktop/FindTalent-Setup-x.y.z.exe
```

## Where your data lives
- Database + config: `%APPDATA%\FindTalent\` (`findtalent.db`, `config.json`).
- Delete that folder to reset the app completely.

## Notes
- **No secrets** ship in this app or repo. Encryption keys are generated on your
  PC on first run; your 8vance credentials are entered by you and stored
  encrypted locally.
- Single user (you = admin). Billing / email / sign-up features are off.
