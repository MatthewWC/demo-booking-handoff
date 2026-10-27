Demo booking handoff

To run it, double-click handoff (handoff.exe on Windows).

It reads the booking events and the Leads export in the starter_pack folder,
then writes three files to an output folder right here:

  updated_salesforce_leads.csv   the Leads after every booking event
  slack_notifications.txt        the messages the Sales team would get
  run_log.txt                    one line per event: what it did and why

To try different data, replace the files in starter_pack and run it again.
For options like the owners or the provider cutoff, run it from a terminal
with --help. --version shows which release this is.

Windows: the window stays open until you press Enter.

Mac: the first time, macOS says it can't verify the developer. Open System
Settings > Privacy & Security, scroll down and click Open Anyway.

Linux: if double-clicking doesn't run it, open a terminal in this folder and
run ./handoff

Source and full README: https://github.com/MatthewWC/demo-booking-handoff
