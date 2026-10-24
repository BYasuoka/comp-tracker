# Comp Tracker

A project-based timesheet, compensation and reimbursement tracker with a GitHub Pages interface and private GitHub records. No separate hosted server is required.

## Hosted version

The public app repository contains code only. Records belong in a **separate private repository**. The browser calls the GitHub REST API directly; every save creates a commit in that private repository.

1. Open the published GitHub Pages URL.
2. Create a **fine-grained personal access token** at https://github.com/settings/personal-access-tokens/new.
3. Under Repository access choose **Only select repositories**, then select your private data repository.
4. Set **Repository permissions > Contents > Read and write**. Leave other permissions at their defaults. Choose an expiration date.
5. Enter the GitHub owner, private repository name, and token in the app.

The token stays in browser memory only. It is never committed, saved in browser storage, sent to the app repository, or sent to a third-party server. Closing or reloading the page requires signing in again. Use a limited token rather than your broad GitHub CLI token. Anyone with the token can read/write that private repository; never share it.

## Shared records and uploads

- Records are stored at `records/tracker.json` in the private repository.
- Original uploaded `.xlsm`/`.xlsx` files are archived at `workbooks/<content-hash>.<extension>` in the private repository.
- Upload completed timesheets through **Upload timesheets**. Files are parsed locally in the browser without executing VBA. Maximum file size is 12 MB, with decompression limits.
- **Refresh from GitHub** loads changes saved from another device. Refresh before editing when switching devices.
- A stale save is rejected instead of overwriting another device's changes. Refresh, review the current state and retry.
- **Settings & export** downloads backups or restores an existing tracker JSON backup. Restore replaces the shared records, with the previous version retained in Git history.
- Blank templates and exact duplicates are skipped. Changed workbooks become versions requiring selection in Review. Payments and manual assignments survive imports.

Do not put your data repository under GitHub Pages. Do not put your actual records, original workbooks, access keys, exports, screenshots, local analysis reports or logs in the public app repository. The checked-in `.gitignore` excludes these local artifacts, and the Pages build copies an explicit code-only allowlist.

## Tracking workflow

**Projects** holds dated rates per full project code. **Calculator** takes explicitly approved eligible hours or days and records confirmed compensation as manual claims. It does not infer overtime eligibility or customer policy. Keep amounts already present in imported claims from being entered twice.

**Overtime** estimates hours using a provisional 40-hour weekly requirement. Work and travel count as worked hours; PTO and holiday row credits help meet the requirement. Once 40 credited hours are reached, worked hours above 8 per day count as daily OT, with additional weekly OT above 40 after removing daily OT. Leave credits do not themselves become OT. Explicit sick-leave entries require review. Only selected workbook versions count. Date filters use week ending, and all projects are combined before calculation. This view does not create payment claims, apply pay multipliers, or infer banked holidays.

**Claims** tracks per diem, other employee reimbursements and compensation separately. Assign ambiguous records to a project. **Payments** supports partial receipts and allocations across several claims/projects, with void history. Company-paid costs and comp-time hours are informational and do not inflate cash owed.

**Timesheets** shows weekly entries, source-cell references, company-paid expenses and import notes. Exclude drafts from totals. **Review** lists missing project assignments, conflicts and unconfigured rules.

Saved Excel formula values may be stale. Recalculate/save the source workbook in Excel if needed, then upload the revised version. Service VBA calculations and a comp-time redemption ledger are not reproduced in this first version.

## Deploy the public app

The included `.github/workflows/pages.yml` tests the shared-record model, builds an explicit set of static files, and deploys to GitHub Pages. In the app repository choose **Settings > Pages > Source: GitHub Actions**. The workflow needs Pages/write and id-token/write permissions. It never accesses the private data repository and does not need a data-access token.

Build locally with Windows PowerShell or PowerShell 7:

```powershell
./Build-Pages.ps1
```

The output is `dist/`. Use a current Chrome, Edge or Firefox browser with Compression Streams support for workbook uploads. No external JavaScript libraries are loaded.

Model tests run with Node 20 or later:

```text
node --test tests/model.test.mjs
```

## Original local server

The original Windows PowerShell server remains available. Double-click `Start-Tracker.cmd`, open http://127.0.0.1:8765 and use the key in `data/access-key.txt`. `Stop-Tracker.cmd` stops it. The local server and GitHub workspace are independent stores; transfer a JSON backup through Settings to migrate, rather than assuming they synchronize automatically.

The local importer defaults to your home directory's `Documents/Timesheet`. Local records use `data/tracker.json`, atomic writes and timestamped backups. Environment variables `TRACKER_DATA`, `TRACKER_SOURCE`, `TRACKER_BIND`, `PORT` and `TRACKER_ACCESS_KEY` can override the defaults. Do not expose the local HTTP server directly to the public internet.

## Privacy and hosting limits

The app's JavaScript is public, while records require private-repository authorization. GitHub is the storage provider and receives the data you explicitly upload. Git history retains previous versions, including voided payments; deleting the latest file does not erase older commits. Repository owners and authorized collaborators can access this history. This is a personal tracker, not a multi-user accounting or payroll system.

GitHub Pages only hosts static files; the cloud version implements calculations and workbook reading in browser JavaScript. The local PowerShell application remains usable separately.
