#!/usr/bin/env bun
// Demo booking handoff.
//
// Reads the scheduling tool's webhook events in the order they arrived, keeps the
// Salesforce Leads export up to date, and writes the Slack messages the Sales team
// would get, plus a run log with one line per event.
//
// Run with Bun, which runs TypeScript directly:
//   bun handoff.ts           the brief's rules on the starter pack
//   bun handoff.ts --help    every option, like the owners or the provider cutoff
// Or build a single executable (bun run build) and run that the same way.

import { basename, join, resolve } from "path";
import { parseArgs } from "util";

// ---------- Options ----------

// The brief's rules and the starter pack's layout. Each one can be changed with an option.
const DEFAULTS = {
  events: "starter_pack/events",
  leads: "starter_pack/salesforce_leads.csv",
  out: "output",
  smbOwner: "Jordan Lee",
  midMarketOwner: "Priya Shah",
  midMarketMin: 10, // 1 to 9 providers is SMB, 10 or more is Mid-Market
  leadSource: "Scheduling Tool - Demo",
  reviewChannel: "#demo-handoff-review", // one shared channel, so flagged bookings don't sit in one rep's DMs
  timezone: "America/Los_Angeles",
};

// How it was started, for the help text: "bun handoff.ts", or the executable's own name once it's built.
const EXECUTABLE = basename(process.execPath);
const COMMAND = EXECUTABLE.replace(/\.exe$/i, "") === "bun" ? "bun handoff.ts" : EXECUTABLE;

const HELP = [
  "Demo booking handoff",
  "",
  "Reads booking events in order, updates the Salesforce Leads export, and writes",
  "the Slack messages and a run log to the output folder.",
  "",
  `Usage: ${COMMAND} [options]`,
  "Paths are relative to the folder you run it from.",
  "",
  "Options:",
  ...[
    ["--events <folder>", "Booking event JSON files", DEFAULTS.events],
    ["--leads <file>", "Salesforce Leads CSV export", DEFAULTS.leads],
    ["-o, --out <folder>", "Where the three output files go", DEFAULTS.out],
    ["--smb-owner <name>", "Owner for new SMB practices", DEFAULTS.smbOwner],
    ["--mid-market-owner <name>", "Owner for new Mid-Market practices", DEFAULTS.midMarketOwner],
    ["--mid-market-min <number>", "Provider count where Mid-Market starts", String(DEFAULTS.midMarketMin)],
    ["--lead-source <text>", "Lead_Source on new Leads", DEFAULTS.leadSource],
    ["--review-channel <name>", "Slack channel for flagged bookings", DEFAULTS.reviewChannel],
    ["--timezone <zone>", "Time zone for demo times", DEFAULTS.timezone],
    ["-h, --help", "Show this help", ""],
  ].map(([option, what, fallback]) => `  ${option.padEnd(28)}${what.padEnd(40)}${fallback ? `default: ${fallback}` : ""}`.trimEnd()),
  "",
  "Examples:",
  `  ${COMMAND}`,
  `  ${COMMAND} --smb-owner "Sam Rivera" --mid-market-min 15`,
  `  ${COMMAND} --leads exports/leads.csv --out runs/latest`,
].join("\n");

const {
  eventsDir: EVENTS_DIR,
  leadsFile: LEADS_FILE,
  outputDir: OUTPUT_DIR,
  smbOwner: SMB_OWNER,
  midMarketOwner: MID_MARKET_OWNER,
  midMarketMin: MID_MARKET_MIN,
  leadSource: LEAD_SOURCE,
  reviewChannel: REVIEW_CHANNEL,
  timezone: TIMEZONE,
} = await readOptions();

// A gmail.com address says nothing about which practice someone works at.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com",
  "me.com", "live.com", "msn.com", "proton.me", "protonmail.com",
]);
// Front-desk style inboxes are shared by several people at a practice.
const SHARED_INBOX = /^(office|info|admin|frontdesk|front\.desk|reception|contact|hello|scheduling|billing|team|support)@/;

const COLUMNS = [
  "Lead_ID", "First_Name", "Last_Name", "Email", "Company", "Phone", "Number_of_Providers",
  "Lead_Source", "Status", "Owner", "Demo_Scheduled_At", "Last_Modified_Date",
] as const;
type Lead = Record<(typeof COLUMNS)[number], string>;

// The parts of a scheduling-tool webhook this script uses.
interface WebhookEvent {
  event: string; // "invitee.created" (booked) or "invitee.canceled"
  created_at: string;
  payload: {
    uri: string; // unique ID of this booking
    email?: string | null;
    name?: string;
    first_name?: string;
    last_name?: string;
    rescheduled?: boolean; // on a cancel: true when it's the old half of a reschedule
    old_invitee?: string | null; // on a booking: the booking it replaces, when it's a reschedule
    new_invitee?: string | null; // on a cancel: the booking that replaced it
    timezone?: string;
    text_reminder_number?: string | null;
    questions_and_answers?: { question: string; answer: string }[];
    scheduled_event?: { start_time?: string };
    cancellation?: { reason?: string } | null;
  };
}
type Payload = WebhookEvent["payload"];

type Action = "CREATED" | "UPDATED" | "SKIPPED" | "FLAGGED" | "ERROR";
interface Result {
  action: Action;
  reason: string; // the rest of the run log line
  slack?: string[]; // lines of the Slack message, when the event deserves one
}
// Something that stops the script from acting on its own, and how a person can fix it.
interface Problem {
  what: string;
  fix: string;
}

// ---------- State for this run ----------

const { header, leads } = await readLeads(LEADS_FILE);
const leadsByEmail = new Map(leads.filter((l) => l.Email).map((l) => [cleanEmail(l.Email), l]));
// The export's IDs are simple placeholders (00Q001...). In Salesforce, the system assigns the ID.
let lastLeadNumber = Math.max(0, ...leads.map((l) => Number(l.Lead_ID.replace(/\D/g, "")) || 0));
// "<event type> <booking ID>" -> the event file that first had it, to catch repeat deliveries
const seen = new Map<string, string>();
// booking ID -> the booking this run applied, to connect the two halves of a reschedule
const applied = new Map<string, { file: string; start: string; lead: Lead }>();

// ---------- Main ----------

const eventFiles = listEventFiles(EVENTS_DIR);

const runLog: string[] = [];
const slackMessages: string[] = [];
const counts: Record<Action, number> = { CREATED: 0, UPDATED: 0, SKIPPED: 0, FLAGGED: 0, ERROR: 0 };

for (const fileName of eventFiles) {
  const file = fileName.replace(/\.json$/, "");
  let result: Result;
  try {
    result = processEvent(file, await Bun.file(join(EVENTS_DIR, fileName)).text());
  } catch (err) {
    result = { action: "ERROR", reason: `couldn't be processed (${(err as Error).message})` };
  }
  counts[result.action]++;
  runLog.push(`${file}: ${result.action} ${result.reason}`);
  if (result.slack) slackMessages.push([...result.slack, `Source: ${file}`].join("\n"));
}

// Bun.write creates the output folder if it isn't there yet.
const rows = leads.map((lead) => header.map((column) => (lead as Record<string, string>)[column] ?? ""));
await Bun.write(join(OUTPUT_DIR, "updated_salesforce_leads.csv"), toCsv([header, ...rows]));
await Bun.write(join(OUTPUT_DIR, "slack_notifications.txt"), slackMessages.join("\n\n") + "\n");
await Bun.write(join(OUTPUT_DIR, "run_log.txt"), runLog.join("\n") + "\n");

console.log(
  `Processed ${eventFiles.length} events: ${counts.CREATED} created, ${counts.UPDATED} updated, ` +
    `${counts.SKIPPED} skipped, ${counts.FLAGGED} flagged, ${counts.ERROR} errors.`,
);
console.log(`Wrote updated_salesforce_leads.csv, slack_notifications.txt and run_log.txt to ${OUTPUT_DIR}`);

// ---------- One event ----------

function processEvent(file: string, raw: string): Result {
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw) as WebhookEvent;
  } catch {
    return { action: "ERROR", reason: "the file isn't valid JSON, so it couldn't be read" };
  }
  const p = event?.payload;
  if (!p?.uri) return { action: "ERROR", reason: "the event has no booking details, so there was nothing to act on" };

  // Webhooks can be delivered more than once. The same event for the same booking is a repeat.
  const key = `${event.event} ${p.uri}`;
  const firstFile = seen.get(key);
  if (firstFile) {
    const what = event.event === "invitee.canceled" ? "cancellation" : "booking";
    return { action: "SKIPPED", reason: `duplicate of ${firstFile}: the scheduling tool sent ${nameOf(p)}'s ${what} twice, so nothing changed` };
  }
  seen.set(key, file);

  if (event.event === "invitee.created") return handleBooking(file, event);
  if (event.event === "invitee.canceled") return handleCancel(event);
  return { action: "SKIPPED", reason: `"${event.event}" isn't a booking or a cancellation, so there was nothing to update` };
}

function handleBooking(file: string, event: WebhookEvent): Result {
  const p = event.payload;
  const start = p.scheduled_event?.start_time ?? "";
  if (Number.isNaN(toDate(start).getTime())) {
    return { action: "ERROR", reason: `${nameOf(p)}'s booking has no readable demo time, so it couldn't be applied` };
  }
  const email = cleanEmail(p.email);
  const lead = email ? leadsByEmail.get(email) : undefined;
  return lead ? bookExistingLead(file, event, lead, start) : bookNewLead(file, event, start);
}

// Rule 1: someone already in Salesforce books. Update their Lead; they keep their owner.
function bookExistingLead(file: string, event: WebhookEvent, lead: Lead, start: string): Result {
  const p = event.payload;
  const person = `${lead.First_Name} ${lead.Last_Name}`;
  const when = demoTime(start, p.timezone);

  // A Converted Lead has already become an Account and Contact. Changing it would be a guess.
  if (lead.Status === "Converted") {
    return flag(event, `${person} at ${lead.Company}`, when, [lead.Owner], [{
      what: `Lead ${lead.Lead_ID} is already Converted (it's now an Account and Contact)`,
      fix: "check the Account and any open Opportunity, decide if this is new business (like another location) or a repeat booking, and log the demo there",
    }]);
  }

  const current = lead.Demo_Scheduled_At;
  if (!p.old_invitee && lead.Status === "Demo Scheduled" && current) {
    if (sameTime(current, start)) {
      return { action: "SKIPPED", reason: `${person} (${lead.Lead_ID}) already has this demo on record for ${teamTime(start)}, so nothing changed` };
    }
    // A second booking while another demo is still coming up: ask which one is real.
    if (toDate(current) > toDate(event.created_at)) {
      return flag(event, `${person} at ${lead.Company}`, when, [lead.Owner], [{
        what: `${person} already has a different demo coming up on ${teamTime(current)}`,
        fix: "check which time is right and cancel the other booking",
      }]);
    }
  }

  const before = lead.Status;
  // On a reschedule, the old time comes from the booking it replaces.
  const oldTime = p.old_invitee ? (applied.get(p.old_invitee)?.start ?? current) : "";
  scheduleDemo(lead, start, event.created_at);
  applied.set(p.uri, { file, start, lead });

  const card = `${person}, ${lead.Company} (${lead.Number_of_Providers} providers)`;
  if (p.old_invitee) {
    return {
      action: "UPDATED",
      reason: `${person} (${lead.Lead_ID}), demo rescheduled ${oldTime ? `from ${teamTime(oldTime)} ` : ""}to ${teamTime(start)}`,
      slack: [
        `To: @${lead.Owner}`,
        `Demo rescheduled: ${card}`,
        `New time: ${when}${oldTime ? ` (was ${teamTime(oldTime)})` : ""}`,
        `Lead ${lead.Lead_ID} updated with the new time.`,
      ],
    };
  }
  const change = before === "Demo Scheduled" ? "new demo time set" : `status changed from ${before || "blank"} to Demo Scheduled`;
  return {
    action: "UPDATED",
    reason: `${person} (${lead.Lead_ID}), ${change} for ${teamTime(start)}${emailNote(p.email)}`,
    slack: [`To: @${lead.Owner}`, `Demo booked: ${card}`, `When: ${when}`, `Lead ${lead.Lead_ID}: ${change}.`],
  };
}

// Rules 2 and 4: someone new books. Create a Lead and pick the owner, unless it needs a person's judgment.
function bookNewLead(file: string, event: WebhookEvent, start: string): Result {
  const p = event.payload;
  const person = nameOf(p);
  const email = cleanEmail(p.email);
  const practice = answerTo(p, /practice name/i);
  const providers = answerTo(p, /how many providers/i);
  const when = demoTime(start, p.timezone);
  const size = ownerBySize(providers);

  const problems: Problem[] = [];
  const notes: string[] = [];
  if (!email) {
    problems.push({
      what: "no email address, so the booking can't be matched to Salesforce",
      fix: "get their email from the booking in the scheduling tool and check Salesforce for an existing Lead",
    });
  }
  if (!p.last_name?.trim()) problems.push({ what: "no last name (Salesforce requires one on a Lead)", fix: "add their last name" });
  if (!practice) problems.push({ what: "no practice name (Salesforce requires a Company on a Lead)", fix: "add the practice name" });
  if ("problem" in size) problems.push(size.problem);

  // Someone new at a practice Salesforce already has: the size rule could hand it to a second rep.
  const colleagues = leads.filter((l) => samePractice(l, email, practice));
  const owners = unique(colleagues.map((l) => l.Owner));
  const conflict = "owner" in size && owners.some((o) => o !== size.owner);
  if ("owner" in size && conflict) {
    const onFile = unique(colleagues.map((l) => l.Number_of_Providers).filter(Boolean)).join(" or ");
    const existing = owners.filter((o) => o !== size.owner);
    problems.push({
      what:
        `the practice already has ${plural(colleagues.length, "Lead")} owned by ${owners.join(" and ")}` +
        `${onFile ? ` (${onFile} providers on file)` : ""}, but ${providers} providers would assign ${size.owner}`,
      fix:
        `confirm whether ${p.first_name?.trim() || person} works at the same location. ` +
        `If so, ${existing.join(" or ")} keeps the practice; if it's a separate location, create the Lead for ${size.owner}`,
    });
  }
  if (colleagues.length) {
    const list = colleagues.map((l) => {
      const demo = l.Status === "Demo Scheduled" && l.Demo_Scheduled_At ? `, demo ${teamTime(l.Demo_Scheduled_At)}` : "";
      return `${l.First_Name} ${l.Last_Name} (${l.Lead_ID}, ${l.Owner}${demo})`;
    });
    notes.push(`Already in Salesforce at this practice: ${list.join("; ")}.`);
  }
  if (SHARED_INBOX.test(email)) notes.push(`${email} looks like a shared inbox, so later bookings from it may be a different person.`);

  if (problems.length || !("owner" in size)) {
    if ("owner" in size && !conflict) notes.push(`By size (${providers} providers) it would go to ${size.owner}.`);
    const cc = [...owners, ...("owner" in size ? [size.owner] : [SMB_OWNER, MID_MARKET_OWNER])];
    return flag(event, practice ? `${person} at ${practice}` : person, when, cc, problems, notes);
  }

  lastLeadNumber++;
  const lead: Lead = {
    Lead_ID: `00Q${String(lastLeadNumber).padStart(3, "0")}`,
    First_Name: p.first_name?.trim() ?? "",
    Last_Name: p.last_name?.trim() ?? "",
    Email: email,
    Company: practice,
    Phone: formatPhone(p.text_reminder_number),
    Number_of_Providers: size.count,
    Lead_Source: LEAD_SOURCE,
    Status: "",
    Owner: size.owner,
    Demo_Scheduled_At: "",
    Last_Modified_Date: "",
  };
  scheduleDemo(lead, start, event.created_at);
  leads.push(lead);
  leadsByEmail.set(email, lead);
  applied.set(p.uri, { file, start, lead });

  const team = size.owner === SMB_OWNER ? `SMB team, 1 to ${MID_MARKET_MIN - 1} providers` : `Mid-Market team, ${MID_MARKET_MIN}+ providers`;
  const count = size.count ? `${size.count} providers` : `provider count "${providers}"`;
  return {
    action: "CREATED",
    reason: `new Lead ${lead.Lead_ID} for ${person} at ${practice} (${count}, assigned to ${size.owner}), demo ${teamTime(start)}`,
    slack: [
      `To: @${size.owner}`,
      `New demo booked: ${person}, ${practice} (${count})`,
      `When: ${when}`,
      `New Lead ${lead.Lead_ID} created and assigned to you (${team}).`,
      ...notes,
    ],
  };
}

// Rule 3: a canceled demo means Demo Canceled.
function handleCancel(event: WebhookEvent): Result {
  const p = event.payload;
  const name = nameOf(p);
  const start = p.scheduled_event?.start_time ?? "";
  const slot = start ? teamTime(start) : "unknown time";

  // A reschedule sends a new booking plus a cancel of the old slot. The new booking does the work,
  // so this half must not mark the demo canceled, whichever order the two arrive in.
  if (p.rescheduled) {
    const replacement = p.new_invitee ? applied.get(p.new_invitee) : undefined;
    return {
      action: "SKIPPED",
      reason: replacement
        ? `cancellation of ${name}'s ${slot} slot: it's the old half of a reschedule that ${replacement.file} already applied ` +
          `(this cancel arrived after the new booking), so the demo stays ${teamTime(replacement.start)}`
        : `cancellation of ${name}'s ${slot} slot: it's the old half of a reschedule, so the Lead stays as is until the new booking arrives`,
    };
  }

  const email = cleanEmail(p.email);
  const lead = (email ? leadsByEmail.get(email) : undefined) ?? applied.get(p.uri)?.lead;
  if (!lead) {
    return { action: "SKIPPED", reason: `cancellation for ${name}${email ? ` (${email})` : ""}: no matching Lead in Salesforce, so there was nothing to cancel` };
  }
  const person = `${lead.First_Name} ${lead.Last_Name}`;
  // Only cancel the demo the Lead actually has. An old or out-of-order cancel leaves it alone.
  if (!start || !lead.Demo_Scheduled_At || !sameTime(lead.Demo_Scheduled_At, start)) {
    const onLead = lead.Demo_Scheduled_At ? teamTime(lead.Demo_Scheduled_At) : "none on record";
    return { action: "SKIPPED", reason: `cancellation of ${person}'s ${slot} slot doesn't match the demo on Lead ${lead.Lead_ID} (${onLead}), so the Lead was left as is` };
  }

  const before = lead.Status;
  cancelDemo(lead, event.created_at);
  const given = p.cancellation?.reason?.trim();
  return {
    action: "UPDATED",
    reason: `${person} (${lead.Lead_ID}), status changed from ${before} to Demo Canceled and the demo time cleared (was ${slot})${given ? `. Reason given: "${given}"` : ""}`,
    slack: [
      `To: @${lead.Owner}`,
      `Demo canceled: ${person}, ${lead.Company} (${lead.Number_of_Providers} providers)`,
      `Was: ${slot}`,
      ...(given ? [`Reason given: "${given}"`] : []),
      `Lead ${lead.Lead_ID} moved to Demo Canceled.`,
    ],
  };
}

// Rule 6: when the right action isn't clear, change nothing and hand a person what they need to decide.
function flag(event: WebhookEvent, who: string, when: string, cc: string[], problems: Problem[], notes: string[] = []): Result {
  const p = event.payload;
  return {
    action: "FLAGGED",
    reason: `${who}: ${problems.map((x) => x.what).join("; ")}. Sent for review; nothing changed in Salesforce`,
    slack: [
      `To: ${REVIEW_CHANNEL} (cc ${unique(cc).map((name) => `@${name}`).join(", ")})`,
      `Needs review: ${who}`,
      `Demo: ${when}`,
      ...problems.map((x) => `Problem: ${sentence(x.what)}`),
      ...notes,
      ...unique(problems.map((x) => x.fix)).map((fix) => `To resolve: ${sentence(fix)}`),
      "Nothing was changed in Salesforce.",
      `Booking: ${cleanEmail(p.email) || "no email given"} | ${p.uri}`,
    ],
  };
}

// Rule 4: 1 to 9 providers goes to SMB, 10 or more to Mid-Market. Only a clear answer picks an owner.
function ownerBySize(answer: string): { owner: string; count: string } | { problem: Problem } {
  const numbers = (answer.match(/\d+/g) ?? []).map(Number);
  const owners = unique(numbers.map((n) => (n >= MID_MARKET_MIN ? MID_MARKET_OWNER : SMB_OWNER)));
  if (owners.length === 1 && numbers.every((n) => n >= 1)) {
    // Store the count only when it's one number ("4"), not a range ("3-5").
    return { owner: owners[0], count: numbers.length === 1 ? String(numbers[0]) : "" };
  }
  const what = !answer
    ? "no provider count, so the owner is unclear"
    : owners.length > 1
      ? `provider count "${answer}" straddles the ${MID_MARKET_MIN}-provider line between ${SMB_OWNER} and ${MID_MARKET_OWNER}, so the owner is unclear`
      : `provider count "${answer}" isn't a usable number, so the owner is unclear`;
  return { problem: { what, fix: "confirm the provider count (or pick an owner), then create the Lead" } };
}

// ---------- Helpers ----------

function nameOf(p: Payload): string {
  return p.name?.trim() || [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "an unnamed invitee";
}

function answerTo(p: Payload, question: RegExp): string {
  return p.questions_and_answers?.find((qa) => question.test(qa.question))?.answer?.trim() ?? "";
}

function cleanEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function emailNote(raw: string | null | undefined): string {
  if (!raw) return "";
  const fixes: string[] = [];
  if (raw !== raw.toLowerCase()) fixes.push("capital letters");
  if (raw !== raw.trim()) fixes.push("extra spaces");
  return fixes.length ? ` (matched by email after ignoring ${fixes.join(" and ")})` : "";
}

function samePractice(lead: Lead, email: string, practice: string): boolean {
  const domain = email.split("@")[1];
  if (domain && !PERSONAL_EMAIL_DOMAINS.has(domain) && cleanEmail(lead.Email).endsWith(`@${domain}`)) return true;
  return practice !== "" && simplify(lead.Company) === simplify(practice);
}

function simplify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scheduleDemo(lead: Lead, start: string, changedAt: string): void {
  lead.Status = "Demo Scheduled";
  lead.Demo_Scheduled_At = toDate(start).toISOString().replace(".000Z", "Z"); // same format as the export
  lead.Last_Modified_Date = toDate(changedAt).toISOString().slice(0, 10);
}

function cancelDemo(lead: Lead, changedAt: string): void {
  lead.Status = "Demo Canceled";
  lead.Demo_Scheduled_At = ""; // so "demos this week" reports don't count a canceled demo
  lead.Last_Modified_Date = toDate(changedAt).toISOString().slice(0, 10);
}

// The events carry microseconds ("...00.000000Z"). Trim to milliseconds so every runtime parses them.
function toDate(iso: string): Date {
  return new Date(iso.replace(/(\.\d{3})\d+/, "$1"));
}

function sameTime(a: string, b: string): boolean {
  return toDate(a).getTime() === toDate(b).getTime();
}

// The team's time, like the example in the brief: "Thu Oct 8, 9:00 AM PT".
function teamTime(iso: string): string {
  const t = dateParts(iso, TIMEZONE, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortGeneric",
  });
  return `${t.weekday} ${t.month} ${t.day}, ${t.hour}:${t.minute} ${t.dayPeriod} ${t.timeZoneName}`;
}

// The team's time, plus the invitee's own time when they're elsewhere: "... PT (2:00 PM EDT their time)".
function demoTime(iso: string, timeZone?: string): string {
  if (!timeZone || timeZone === TIMEZONE) return teamTime(iso);
  try {
    const t = dateParts(iso, timeZone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `${teamTime(iso)} (${t.hour}:${t.minute} ${t.dayPeriod} ${t.timeZoneName} their time)`;
  } catch {
    return teamTime(iso); // unknown time zone name
  }
}

function dateParts(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, ...options }).formatToParts(toDate(iso));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

// "+15035550188" -> "(503) 555-0188", the format the export uses.
function formatPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10 ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}` : (raw ?? "").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sentence(text: string): string {
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return s.endsWith(".") ? s : `${s}.`;
}

// ---------- Reading the options ----------

async function readOptions() {
  const flags = parseOptions();
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }

  const midMarketMin = Number(flags["mid-market-min"] ?? DEFAULTS.midMarketMin);
  if (!Number.isInteger(midMarketMin) || midMarketMin < 2) fail("--mid-market-min must be a whole number, 2 or more");
  const timezone = flags.timezone ?? DEFAULTS.timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    fail(`--timezone "${timezone}" isn't a time zone name. Try one like America/Los_Angeles`);
  }

  const options = {
    eventsDir: pathOption(flags.events, DEFAULTS.events),
    leadsFile: pathOption(flags.leads, DEFAULTS.leads),
    outputDir: pathOption(flags.out, DEFAULTS.out),
    smbOwner: textOption("smb-owner", flags["smb-owner"], DEFAULTS.smbOwner),
    midMarketOwner: textOption("mid-market-owner", flags["mid-market-owner"], DEFAULTS.midMarketOwner),
    midMarketMin,
    leadSource: textOption("lead-source", flags["lead-source"], DEFAULTS.leadSource),
    reviewChannel: textOption("review-channel", flags["review-channel"], DEFAULTS.reviewChannel),
    timezone,
  };
  const where = "Run it from the project folder, or point to it with";
  if (!listEventFiles(options.eventsDir).length) fail(`can't find any event files in ${options.eventsDir}. ${where} --events`);
  if (!(await Bun.file(options.leadsFile).exists())) fail(`can't find the Leads file ${options.leadsFile}. ${where} --leads`);
  return options;
}

// The .json files in a folder, in arrival order (event_02 before event_10). None if the folder is missing.
function listEventFiles(folder: string): string[] {
  try {
    return [...new Bun.Glob("*.json").scanSync({ cwd: folder })].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch {
    return [];
  }
}

function parseOptions() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        events: { type: "string" },
        leads: { type: "string" },
        out: { type: "string", short: "o" },
        "smb-owner": { type: "string" },
        "mid-market-owner": { type: "string" },
        "mid-market-min": { type: "string" },
        "lead-source": { type: "string" },
        "review-channel": { type: "string" },
        timezone: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (err) {
    return fail((err as Error).message);
  }
}

// Paths, defaults included, are relative to the folder you run the command from. That way the
// script and a built executable behave the same (an executable has no script folder to start from).
function pathOption(value: string | undefined, fallback: string): string {
  return resolve(value || fallback);
}

function textOption(option: string, value: string | undefined, fallback: string): string {
  const result = (value ?? fallback).trim();
  if (!result) fail(`--${option} can't be empty`);
  return result;
}

function fail(message: string): never {
  console.error(`Error: ${message}\nRun "${COMMAND} --help" to see the options.`);
  process.exit(1);
}

// ---------- CSV ----------

// Bun.file().text() also drops the byte-order mark that Excel-style exports often start with.
async function readLeads(path: string): Promise<{ header: string[]; leads: Lead[] }> {
  const [header, ...rows] = parseCsv(await Bun.file(path).text());
  const missing = COLUMNS.filter((c) => !header?.includes(c));
  if (!header || missing.length) throw new Error(`${path} is missing columns: ${missing.join(", ")}`);
  const leads = rows
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row) => Object.fromEntries(header.map((column, i) => [column, row[i] ?? ""])) as Lead);
  return { header, leads };
}

// Handles quoted fields, so a company like "Smith, Jones & Co" survives the round trip.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}
