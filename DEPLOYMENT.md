# CIC Architect Update System

## Production files

- `code.js` contains the spreadsheet database layer, security, reporting, synchronization, email automation, and triggers.
- `Index.html` contains the approved architect-facing portal.
- `appsscript.json` sets the project time zone to Eastern and enables the V8 runtime.

## Install

1. Open the `ARCHITECT STATUS UPDATES` Google Sheet.
2. Select **Extensions > Apps Script**.
3. Replace the default Apps Script server file contents with the supplied `code.js`.
4. Add an HTML file named `Index` and paste in `Index.html`.
5. Open **Project Settings**, enable **Show appsscript.json**, and replace it with the supplied manifest.
6. Save all files.
7. Run `installSystem` from the Apps Script editor.
8. Approve the requested Google permissions.

`installSystem` performs these actions:

- Validates every required sheet and column.
- Creates the `CONFIG` tab.
- Creates the Control-tab email, response, and event sections.
- Generates permanent private-link credentials for each architect.
- Installs Monday request, Monday reminder, and nightly synchronization triggers.
- Rebuilds `CURRENT REPORT` using Google-native Apps Script logic.

## Deploy the web app

1. In Apps Script, select **Deploy > New deployment**.
2. Select **Web app**.
3. Set **Execute as** to **Me**.
4. Set access to **Anyone** or **Anyone with the link**, depending on the Workspace wording.
5. Deploy.
6. Copy the `/exec` deployment URL.
7. If `ScriptApp.getService().getUrl()` does not return that URL, paste it into `CONFIG > Portal URL Override`.

Do not use the `/dev` testing URL in emails. It works only for script editors.

## Required CONFIG values

Keep **Test Mode** set to `Yes` until the pilot passes.

| Setting | Required value |
|---|---|
| Test Mode | `Yes` during testing, then `No` for live delivery |
| Test Recipient Email | CIC staff address that receives every test email |
| Office Notification Email | `office@centerislandcontracting.com` |
| Source Sync Enabled | `No` until source mapping is confirmed |
| Source Spreadsheet ID | PRE-PRODUCTION spreadsheet URL or ID |
| Source Tab Name | Exact PRE-PRODUCTION tab name |
| Source Header Row | Row containing source headings |
| Source Client Name Header | Exact client-name heading |
| Source Assigned Architect Header | Exact architect heading |
| Source Project Type Header | Exact project-type heading or blank |
| Source Town Header | Exact town heading or blank |

## Prepare the database

1. Delete every row marked `[SAMPLE]` from `PROJECTS` and `UPDATE LOG`.
2. Delete the example.com row from `ARCHITECTS`.
3. Add one `ARCHITECTS` row for each individual architect.
4. Make each `Architect Name` exactly match the name stored in `PROJECTS > Assigned Architect`.
5. Fill the primary contact name, primary email, CC emails, and active status.
6. Enter proposal acceptance and milestone dates in `PROJECTS`.
7. Run **CIC Architect Updates > Install or Repair System** again after the architect list is entered.

The system blocks live email when an active architect still uses an `example.com` address.

## Closed pilot

1. Keep Test Mode set to `Yes`.
2. Enter a CIC-controlled Test Recipient Email.
3. Add one real architect and at least two assigned test projects.
4. Run `initializeArchitectLinks`.
5. Run `sendMondayRequests` manually.
6. Open the private link from the test email.
7. Confirm that the page shows only that architect's active projects.
8. Submit one written update and one No change response.
9. Confirm that one row per project appears in `UPDATE LOG`.
10. Confirm that `CURRENT REPORT` shows both projects as complete.
11. Submit a revision and confirm that the earlier rows remain in `UPDATE LOG`.
12. Confirm that the office notification arrives.
13. Run `sendOverdueReminders` and confirm that completed architects are skipped.
14. Rotate the pilot link with `rotateArchitectLink('Exact Architect Name')` and confirm that the old link stops working.

## Go live

1. Confirm the PRE-PRODUCTION source mapping.
2. Set `Source Sync Enabled` to `Yes`.
3. Run `syncProjectsFromSource` manually.
4. Resolve every unassigned or mismatched project on `CONTROL`.
5. Confirm all architect emails and CC addresses.
6. Set Test Mode to `No`.
7. Run `sendMondayRequests` manually for the first live week.
8. Review the system event log on `CONTROL`.

## Operating rules

- Never edit or delete historical rows in `UPDATE LOG`.
- Change an assignment in `PROJECTS` or the PRE-PRODUCTION source. The next portal load and email use the new assignment.
- Enter corrections to displayed updates in `MANUAL OVERRIDES`.
- A new written architect update automatically deactivates the active override.
- A No change response preserves the last substantive written update.
- Use **CIC Architect Updates > Refresh Current Report** whenever an immediate internal refresh is needed.
- Apps Script time triggers run near the configured time, not at an exact second.

## Deployment limitation

The supplied source is complete, but Google requires the script owner to authorize and deploy it from a CIC-controlled Workspace account. That authorization cannot be packaged into the files.
