# Demo Booking Handoff

Reads the scheduling tool's booking events in order, keeps the Salesforce Leads export up to date, and writes the Slack messages the Sales team would get.

The written answer (custom script, Zapier or Flow?) is in [WRITTEN_ANSWER.md](WRITTEN_ANSWER.md).

## Run it

You need Bun 1.4 or newer, which runs TypeScript directly, so there's nothing else to install. Check with `bun --version`, or install it:

- macOS or Linux: `curl -fsSL https://bun.sh/install | bash`
- Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`

Then:

```
git clone https://github.com/MatthewWC/demo-booking-handoff.git
cd demo-booking-handoff
bun handoff.ts
```

No git? On GitHub, click Code, then Download ZIP. Unzip it, open a terminal in that folder and run `bun handoff.ts`.

When it finishes, it prints a summary: `Processed 11 events: 1 created, 4 updated, 2 skipped, 4 flagged, 0 errors.`

Every option defaults to the brief's rules, so that one command is all you need. To change something, like a rep's name, the provider cutoff, the review channel, the time zone or the file paths, see `bun handoff.ts --help`.

It reads `starter_pack/` as-is and writes three files to `output/`:

| File | What's in it |
|---|---|
| `updated_salesforce_leads.csv` | The Leads after all 11 events, in the original column format |
| `slack_notifications.txt` | The messages the Sales team would get, in order |
| `run_log.txt` | One line per event file: the action taken and why |

Running it again rebuilds the outputs from the starter pack, so the results are the same every time.

Optional TypeScript check: `bun install`, then `bun run typecheck`.

## Build a single executable (optional)

Bun can bundle the script and its runtime into one file, so whoever runs it doesn't need Bun installed:

```
bun run build
```

That builds four files into `dist/`. Each is 90 to 115 MB, because the runtime is inside.

| File | For |
|---|---|
| `handoff-windows-x64.exe` | Windows |
| `handoff-macos-arm64` | Macs with Apple Silicon (M1 or newer) |
| `handoff-macos-x64` | Intel Macs |
| `handoff-linux-x64` | Linux |

Run one from the project folder with the same options, for example `./dist/handoff-macos-arm64 --help`. To build just one, use `bun run build:windows`, `build:mac`, `build:mac-intel` or `build:linux`.

The Mac builds aren't notarized by Apple. If macOS blocks a copy you downloaded, clear the download flag first: `xattr -d com.apple.quarantine handoff-macos-arm64`.

## Decisions beyond the written rules

- **Repeat deliveries:** the same event for the same booking is skipped (event_02).
- **Emails** match regardless of capital letters and extra spaces (event_03).
- **Reschedules** arrive as two events: a new booking that names the old one, and a cancel of the old slot. The new booking moves the demo time. The cancel half is skipped, so the demo is never marked canceled, whichever order the two arrive in (events 05 and 06).
- **Cancels** apply only when the canceled time matches the demo on the Lead, so an old or out-of-order cancel can't undo a newer booking. A cancel also clears Demo_Scheduled_At, so canceled demos don't show up in "demos this week" reports (event_09).
- **Flags change nothing in Salesforce.** They go to one review channel with the likely owner tagged, and say what's needed to resolve them. The script flags:
  - a provider count that could fall on either side of the 10-provider line (event_07)
  - a booking with no email or no last name (event_08)
  - a booking from a Converted Lead (event_10)
  - a new person at a practice that already belongs to a different rep than the size rule would pick (event_11)
  - a second booking while the person already has a different demo coming up
- **New Leads:** IDs continue the export's numbering (00Q008). Phone comes from the SMS reminder number. Last_Modified_Date is the date of the event, which keeps re-runs identical.
- **Times** are in Pacific Time (change it with `--timezone`), with the invitee's own time added when they're in another time zone.

## What changes in production

- **Routing moves into Salesforce.** The owners and the provider cutoff are options for now, so changing a rep doesn't need a code change, but it's still one owner per team. For real, the script would record the facts (provider count, team) and let Salesforce's assignment rules or the scheduling tool's round robin pick the rep, so Sales Ops can add or move reps on their own.
- **Each event is handled on its own.** Real webhooks arrive one at a time, days apart, so the script can't count on remembering earlier events from the same run. The key checks already look at the Lead itself. The booking ID would also be saved on the Salesforce record, so later events (like the cancel half of a reschedule) can find it and a repeat delivery never posts a second flag.
- **Lookups go to Salesforce, not a file.** Instead of loading every Lead, it would look people up by email and use Salesforce's duplicate rules to spot a practice that's already there.
