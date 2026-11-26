# Auditing the English of Docs and JSDoc

This guide says how to audit the English writing in X1 Validator
Services: its Markdown docs, such as a README, an architecture doc or an
engineering reference, the help its command lines print, the messages
its programs show, the comments in its shell scripts, and its JSDoc, the
comment blocks in JavaScript files that describe a file, a function or a
value in a set form (`@param`, `@returns`, `@throws`). It gives the
standard each text must meet, how to check each text against the code,
how to write a fix, and the loop of fresh readers that checks an audit
before its fixes are made. Every audit of the project's English follows
it.

It's adapted from a hand-off the project's owner wrote from audits of
the owner's projects. LP Ranger, the owner's project whose conventions
this one follows, as [`CLAUDE.md`](../../CLAUDE.md) says, keeps that
hand-off as its own `docs/claude/CLAUDE-ENGLISH-AUDIT.md`. Here, most
examples are this project's own, and those in section 8 are findings
from its audits. The guide also adds the rules for text that `CLAUDE.md`
and the owner's rulings in those audits set.

## Table of Contents

- [1. What an Audit Covers](#1-what-an-audit-covers)
- [2. The Standard Every Text Meets](#2-the-standard-every-text-meets)
  - [Describe the System as It Is](#describe-the-system-as-it-is)
  - [Lead Each Topic With Its Context](#lead-each-topic-with-its-context)
  - [Introduce Each Tool Where It Is First Named](#introduce-each-tool-where-it-is-first-named)
    - [What Counts as a Tool](#what-counts-as-a-tool)
    - [The Four Parts of an Introduction](#the-four-parts-of-an-introduction)
    - [Where an Introduction Must Appear](#where-an-introduction-must-appear)
  - [Facts, Not Adjectives](#facts-not-adjectives)
  - [Leave Out No Step of the Logic](#leave-out-no-step-of-the-logic)
  - [One Word for One Thing](#one-word-for-one-thing)
  - [One Idea to a Sentence](#one-idea-to-a-sentence)
  - [Say Each Fact Once](#say-each-fact-once)
  - [Say What Can Change a Figure](#say-what-can-change-a-figure)
  - [Name the Clock and the Calendar](#name-the-clock-and-the-calendar)
  - [Quote Outputs and Names Exactly](#quote-outputs-and-names-exactly)
  - [Structure and Navigation](#structure-and-navigation)
- [3. JSDoc and Comments](#3-jsdoc-and-comments)
  - [File Headers](#file-headers)
  - [Function Docstrings](#function-docstrings)
  - [Constants and Variables](#constants-and-variables)
  - [Inline Comments](#inline-comments)
  - [Shell Scripts](#shell-scripts)
  - [Test Titles](#test-titles)
- [4. Checking Every Claim Against the Code](#4-checking-every-claim-against-the-code)
  - [What to Check](#what-to-check)
  - [How to Check It](#how-to-check-it)
  - [Where Docs Most Often Go Wrong](#where-docs-most-often-go-wrong)
  - [Keeping Every Text Saying the Same Thing](#keeping-every-text-saying-the-same-thing)
- [5. Significant and Minor Findings](#5-significant-and-minor-findings)
- [6. Writing a Fix](#6-writing-a-fix)
  - [Traps a Rewrite Falls Into](#traps-a-rewrite-falls-into)
- [7. The Fresh-Reader Loop](#7-the-fresh-reader-loop)
  - [Why Fresh Readers](#why-fresh-readers)
  - [The Files of the Loop](#the-files-of-the-loop)
  - [The Steps of the Loop](#the-steps-of-the-loop)
  - [The Full-Pass Brief](#the-full-pass-brief)
  - [The Efficient-Pass Brief](#the-efficient-pass-brief)
  - [The Rounds of an Audit](#the-rounds-of-an-audit)
- [8. Findings From Past Audits, Before and After](#8-findings-from-past-audits-before-and-after)
- [9. The Automated Checks](#9-the-automated-checks)
- [10. A Checklist for Each Text](#10-a-checklist-for-each-text)

## 1. What an Audit Covers

A doc is read by someone who doesn't have the code open: an operator
deciding how to run a feature on a validator, or a developer about to
change it. An audit makes sure that what they read is true of the code
as it stands, that a newcomer can follow it, and that it leaves out no
condition that changes what the code does. It covers every text a reader
meets:

- the Markdown docs: the root `README.md`, `CLAUDE.md`, and the docs in
  `docs/`; each feature's `README.md` and the docs in its own `docs/`,
  such as `architecture.md` (how the parts work), `engineering.md` (the
  files, the code and the tests) and `project-commands.md` (every
  command); and the READMEs of a feature's `examples/` and
  `app-config/user-configurable/` folders;
- the help each command line prints for `--help`: a feature's tool and
  each of its commands, each standalone tool in its `util/`, and each
  script in `scripts/`;
- the messages the programs print, the prompts and dialogs they show,
  and the alerts they send;
- the descriptions in a feature's settings schema and in `apply`'s
  dictionary of the changes it can make on the machine, and the notes
  under keys that start with `_` in that dictionary and in the shipped
  settings, such as the warning beside `hashedApiKeysPath`, all in its
  `app-config/`;
- the JSDoc of each file, function, method and constant, and the
  comments in the code;
- the comments in the shell scripts, and in the files a feature writes
  onto the validator, such as its `git` hook;
- the comments in `.env.example`, which an operator copies to `.env` and
  fills in, and in the project's configuration files and workflows, such
  as `.gitignore` and `.github/workflows/ci.yml`;
- the titles of the tests, which say what each test holds the code to.

## 2. The Standard Every Text Meets

### Describe the System as It Is

A doc says how the system works now. It tells no story of an old bug or
an old design: no "used to", "previously", "was fixed", "after the
change", "now" or "no longer" in a sense that tells how the project
changed, as in the Before below. A "now" or a "no longer" stays where it
tells of a moment or a change as the system runs, as in "Save them now,
off the validator" or "the rpc no longer answers on the validator's
address". A reader of the doc needs the rule, not how the rule came
about; the history belongs in commit messages and pull requests.

- Before: "Tests now stop after a minute; a test that hung used to hold
  CI open for hours."
- After: "A test still running after a minute fails, by name, and the
  rest of its file runs."

### Lead Each Topic With Its Context

Every topic and sub-topic opens with what a reader needs to follow it:
the situation it's about, and why it matters, before the rule. The
section on code-fuzzing in `docs/engineering.md` first says that tests
can all pass and still miss the bugs they're meant to catch, and only
then what the stage does about it. A section on a fallback first says
what the first source is and when it fails.

### Introduce Each Tool Where It Is First Named

#### What Counts as a Tool

A tool is anything a reader runs or a program uses: a feature's
commands, such as `apply` or `ensure`, its standalone tools in `util/`,
the launcher in its `bin/`, each `npm run` target and the script it
runs, a package, an outside program such as `x1console`, `nginx` or
`whiptail`, and an outside service such as Let's Encrypt or Cronitor.
Treat a technical term the same way: an http status such as 403, a hash,
a flag such as `--private-rpc`, a setting such as
`startScriptQuietSeconds`, a "UTC day". A name a reader hasn't met is a
gap in the text, however familiar it is to the writer.

#### The Four Parts of an Introduction

1. The big picture: what kind of thing it is.
2. A few words of context, or a scenario in which it's used.
3. Which codebase it comes from: this repo, another of the owner's, or
   an outside party.
4. What it does, in precise words, with no adjective standing in for an
   explanation.

For example: "`ensure`, a command of x1-validator-private-rpc, this
repo's tool, puts `--private-rpc` back into `x1console`'s start script
after an `x1console` update takes it out. The tool's `git` hook runs it
when the update's `git pull` brings new commits."

`CLAUDE.md`'s rule "Each tool introduced at its first mention" asks for
parts 1, 2 and 4 in every doc, help text and message. An audit asks for
part 3 too.

#### Where an Introduction Must Appear

- At the first mention in each doc: a reader may open any doc first. A
  doc that points to another for the details still introduces the tool
  itself.
- At the first mention in each part a reader can see alone, such as a
  command's `--help`, or a message the operator meets on its own.
- Before the text uses the name, not after: a sentence that names a tool
  above the paragraph that introduces it fails, even if the introduction
  is a few lines below. A reader knows only what the doc has said so
  far, plus what its audience knows.

### Facts, Not Adjectives

Replace each adjective or adverb that stands in for an explanation with
the fact it hides. Words to look for: robust, safe, secure, seamless,
powerful, efficient, simple, simply, just, easily, properly, correctly,
gracefully, "reads right", "works as expected", "best".

- Before: "The launcher runs the tool on the right Node.js."
- After: "The launcher runs the tool on the newest release `nvm` holds
  of the Node.js major that `engines` in `package.json` names."

Give each number its unit, and the one the code uses: seconds or
milliseconds, minutes or hours, days. The tests' time limit is "a
minute" in prose, and `--test-timeout=60000`, in milliseconds, in the
test runner's option.

### Leave Out No Step of the Logic

Every condition that changes the outcome is a turning point, and each
one is in the text: the order of the steps, each fallback, each case
that gives no result, each limit, each skip. For every "when X, then Y",
check what happens when X isn't so, and whether the text says it.

- A list of what a tool does in each case is complete only when every
  branch of the code is in it. Read the branches, then the list.
- A rule with an exception states the exception where the rule is
  stated, not three sections later.
- A sentence that says what a command does by default also covers the
  options that change it. "`apply` asks before each stage that changes
  something" needs `--yes`, which answers yes to each stage's question,
  and `--dry-run`, which prints every change and makes none.

### One Word for One Thing

Name each idea with one word through every text, and use the name the
code uses for a setting, a file, a command or a message. A text that
says "period" in one place and "window" in another makes the reader
wonder whether they are two things. Pick one, and change the other
everywhere it appears in the docs, the help and the JSDoc.

This project's choices include `apt`, never `apt-get` or `apt-cache`, as
`CLAUDE.md` says; "the validator's default `node`" for the Node.js
20.0.0 a bare `node` finds on a validator, which `x1console` installed
as the default and the tool never runs on; and "code-fuzzing" for the
gate's last stage.

### One Idea to a Sentence

A sentence that packs a cause, a fact and an instruction together can't
be followed, even when each part is true, as the second row of the table
in [section 8](#8-findings-from-past-audits-before-and-after) shows.

- Give each sentence one idea. Split a sentence that joins a cause, a
  fact and an instruction.
- Give each "it", "its", "this" or "both" one thing it can point at.
  When two things came before, write the name.
- Use the precise verb: the tool "stores" a hash on disk; it doesn't
  "keep" a key.
- An instruction says what to do, and why: what to copy, where to put
  it, and what is lost if you don't.

### Say Each Fact Once

A fact said twice in one text doesn't read as a reminder. It reads as a
second fact, so the reader stops to work out what changed, and finds
nothing. So each text states a fact once. A summary that restates facts
from the paragraphs above it is a defect too: cut the repeat, rather
than weigh it as a summary. This guide's checklist,
[section 10](#10-a-checklist-for-each-text), is the one exception: it
lists the rules again on purpose, as checks to run on each text. Each
brief in [section 7](#7-the-fresh-reader-loop), the instructions a fresh
reader gets for checking an audit, is a text of its own, since it
reaches the reader without this guide. A fact that two texts both state
is a different case, which
[Keeping Every Text Saying the Same Thing](#keeping-every-text-saying-the-same-thing)
covers.

### Say What Can Change a Figure

When a setting can change a number or a choice the doc states, say so
where the doc states it, "as shipped", and name the setting. A feature's
shipped settings are in its `app-config/app-defaults-for-user-configurable/`,
and the operator's overrides go in its `app-config/user-configurable/`.
Do the same for a default that a command-line option replaces. A rule
that rests on a setting names the setting it rests on, as the feature
README does for the password `apply` asks for, which needs "at least as
many characters as the `passwordMinLength` setting says". The
feature's `test/doc-figures.test.js` holds the figures its docs give
from the shipped settings to those settings, so a new figure of that
kind goes into that test too.

### Name the Clock and the Calendar

A day, a week or a month in the text is in a time zone, and a week
starts on a day. Say both wherever a reader acts on them. A `cron`
schedule runs on the validator's clock, in the validator's time zone: a
job that runs "every 2 hours, on the hour" runs on the hours of that
clock, which may not be the reader's. A reader in another time zone
counts a local day, and a reader in the United States counts weeks from
Sunday. Either can act too early on text that leaves the zone or the
first day out.

### Quote Outputs and Names Exactly

A message, a table's heading or a file name the code writes is quoted as
the code writes it, in a code span, with the same capitals, spaces and
punctuation, such as the code-fuzzing stage's `CAUGHT, AFTER TIMING
OUT`. Where the message holds a value, quote the fixed part and mark the
rest, as with the launcher's `x1-validator-private-rpc needs Node.js …,
which nvm, the Node.js version manager, doesn't hold yet. Add it with:
nvm install …`.

In a Markdown doc, each program's name goes in backticks, as it's typed
on the command line, in headings, tables and link text too, as
`CLAUDE.md`'s "Program names in backticks" says. A product's name in its
own spelling, a site and a service stay plain, and so does a feature's
own name, such as x1-validator-private-rpc, except as a command. A help
text or a message prints as plain text, so it puts no name in backticks.

### Structure and Navigation

- A doc with more than five `##` sections, not counting the table of
  contents itself, has a clickable table of contents, headed Table of
  Contents, that goes down at least three levels of sub-heading where
  the doc has them. It comes before the doc's other sections, except in
  a README, where it follows the Overview.
- Every heading is unique in its doc, so that each link to it has one
  target; a heading names its topic.
- Every link resolves: to a file the repo keeps, or to a heading that
  exists. A link to a heading uses the anchor GitHub makes from it: the
  heading in lower case, each space made a hyphen, and every character
  but a letter, a digit, a hyphen or an underscore removed, backticks
  included. So the heading After an `x1console` Update is
  `#after-an-x1console-update`, and the heading The Pre-Commit Hook and
  CI, in `docs/engineering.md`, keeps its hyphen:
  `#the-pre-commit-hook-and-ci`.
- Link text says where the link goes, never "here".
- A table is used when the reader compares rows; prose when the reader
  follows steps.

## 3. JSDoc and Comments

JSDoc is what a developer reads before changing the code, and it's held
to the same standard as the docs: true of the code, complete at each
turning point, with each name introduced.

### File Headers

Each JavaScript file opens with a JSDoc block, after its `#!` line if it
has one. The block holds `@file` and the file's path from the project's
root, then `@description`, then prose that answers three questions, in
this order, and nothing else:

- What: what the file does, and the situation it serves. The first
  sentence names the job in plain words, with no identifier in it when
  that can be helped.
- How: how it does it, step by step, at the level a reader needs before
  reading the code.
- Fit: which other files use it, and why it's a file of its own. A
  module several programs share, in a feature's `src/lib/` or among the
  scripts' helpers, whose names start with an underscore, says which
  programs use it.

A header says where the rest of the story is told, such as the feature's
`docs/architecture.md`. The story of the bug that led to the code
belongs in the commit message, not the header.

### Function Docstrings

- The first sentence says what the function gives or does, in the terms
  of its caller.
- Each `@param` gives the type, the unit, the values it takes, and what
  a missing value means, or the stand-in value the code uses for none,
  such as `""` for a string or -1 for a number.
- `@returns` names every case: "the hashes, or an empty list when the
  file holds none".
- `@throws` says when, and why the function throws rather than going
  on.
- The docstring matches the order of the code. A docstring that says a
  function "waits while `git` works in `x1console`'s folder, then edits
  the start script" is wrong if the code edits first, and the difference
  decides whether an update's `git pull` can fail.
- A docstring says why a step is there when the code alone doesn't show
  it, and doesn't restate the code line by line.
- The shape of the thing comes first. Mechanics come after it: where a
  value is read from, what an input the code doesn't know does, then the
  tags.

### Constants and Variables

A constant's doc block, or a module-level variable's, says what the
value stands for, its unit, and where it comes from: a setting, a
standard, a measurement or a choice, with the reason when the value
isn't obvious. For example: `/** How often the cron job runs ensure, in
seconds: every minute. */`.

### Inline Comments

- A comment says why, not what; it tells no history.
- It follows the project's form, which is LP Ranger's. A comment of more
  than one line is a `/*-` … `*/` block, with each marker on a line of
  its own and the text between them. A one-line comment takes `//`. A
  comment directly above a function is its doc block, and takes `/**`.
- A comment beside code that the audit changes is read again: a comment
  that described the old behavior is now a wrong fact.
- Each name a comment gives, a function, a file, a setting or a flag, is
  a claim. Search for it, and check that it exists and does what the
  comment says.

### Shell Scripts

A shell script the project keeps, such as the launcher in a feature's
`bin/`, opens with `#` comments under its `#!` line. They answer the
same three questions as a JavaScript file's header: what it does, how,
and how it fits. The project's pre-commit hook, `.husky/pre-commit`, is
left as it is: `test/repo-rules.test.js` holds it to its one line,
`npm run lint`.

The files a feature writes onto the validator, such as its `git` hook,
carry comments the tool writes from its JavaScript. The feature's
`examples/` folder shows each such file. The examples of `nginx`'s
configuration and list of hashes, the `systemd` drop-in and the two
`apt` files must be exactly what the tool writes for their placeholders,
as the feature's `test/examples.test.js` checks, so a fix to one of
their comments goes into the code and into the example. The examples of
the `cron` lines and the `git` hook add comments of their own, on how to
install them by hand. Audit each comment where it's written: in the
code, for what the tool writes, and in the example, for the rest.

The two comment lines the tool writes into its `git` hook can't be
reworded as text alone. To uninstall the tool, its `undo-apply` command
takes back what `apply` changed, though it leaves `nginx` installed.
`apply` and `undo-apply` take a hook as the tool's only when the hook's
whole text, those two lines included, is what the tool writes for the
paths the hook names. So rewording them makes each
hook an earlier `apply` installed count as another program's: the next
`apply` leaves it in place, and `undo-apply` leaves it behind. No test
holds a hook an earlier version wrote, so the gate doesn't catch this.
An audit reports a fault in those lines as a change to the code, not as
a wording fix.

### Test Titles

A test's title is a claim about the code. When a fix changes what a test
expects, the title of the test and of its group are read again. A title
such as "the pre-commit hook runs the lint and nothing else" is wrong
once the hook runs anything more.

## 4. Checking Every Claim Against the Code

### What to Check

Check each of these against the code, not against another doc:

- every number: times, counts, limits, ports, file modes, retries;
- every name: settings, files, folders, options, environment variables,
  functions, messages;
- the order of the steps;
- each condition, its boundary included: "after" or "at or after", "more
  than" or "at least", "less than a day" or "a day or less";
- each default, and where it lives: in the code, in the shipped
  settings, or in the operator's overrides, which `git` ignores;
- each help: that it lists every option its program takes, and gives a
  usage example of each common use, as `CLAUDE.md`'s "Complete help"
  says;
- each path and link.

### How to Check It

1. Read the code path end to end, from the entry point the doc describes
   to the output it names; don't stop at the first function that seems
   to match.
2. For a claim that turns on several branches, write a small script that
   runs the code with a stand-in for each service, and check each case
   the text names. The code reaches the system only through its host, an
   object it receives as an argument, so a script passes it a fake host
   from the feature's `test/helpers/`, as the tests do. Keep such scripts
   in `tmp/`. A script worth keeping goes into the tests, so the next
   audit reuses it.
3. A claim about how a system program behaves, such as what `nginx` does
   to the connections a removed key holds open, is checked against the
   system test's own checks, which run the tool on a real Ubuntu system
   in an LXD container. The unit tests use a fake host, so they prove
   nothing about the real program. A claim that no check covers, such as
   one of `nginx`'s defaults, is checked against the program's own
   documentation or code, such as nginx.org's documentation or
   `x1console`'s scripts. A claim about an outside service, such as
   Let's Encrypt's limits, is checked against the service's own
   documentation.
4. Search the whole repo for each fact the audit changes (`git grep`),
   and read every place it appears.
5. Record each fact confirmed, with its file and line, so that the next
   reader can skip it.

### Where Docs Most Often Go Wrong

- What is stored: what a file holds, who can read it, and what is never
  stored, such as the api keys themselves, of which the tool stores only
  hashes.
- Fallbacks: the case in which the fallback itself is never reached,
  such as a flag that stops the run before it.
- Outputs: a doc that says a command prints something it prints only in
  some cases, such as under `ensure`'s `--quiet`, which prints only what
  changed and its alerts.

### Keeping Every Text Saying the Same Thing

A fact is often stated in several places: the feature's README, its
`docs/project-commands.md`, its architecture doc, a command's `--help`,
a file header, a function's docstring, a test's title. An audit that
changes one changes all, and checks that none now says the same fact
twice in one text, or says it two ways. Where two texts must say the
same thing, a test can hold them to it, as this project's tests do: the
feature's `test/cli.test.js` fails `docs/project-commands.md` unless the
doc has a row for each command and standalone tool, and no other row,
and the Options column of each command's row names exactly the options
the command declares, short forms such as `-y` for `--yes` included.
And `test/disclaimer.test.js` fails the feature's README when its
disclaimer differs from the one the dialog shows.

## 5. Significant and Minor Findings

A finding is significant when it is:

- a wrong fact, in a doc or in a proposed fix;
- a missing turning point, or a missing step of reasoning;
- a sentence that would mislead a reader into acting wrongly;
- a name or tool used before it is introduced;
- a fact said twice in one text;
- any other break of a rule in sections 2 and 3, such as a story of an
  old bug or design, a topic that doesn't open with its context, an
  adjective in place of a fact, or a program's name out of backticks in
  a Markdown doc;
- a fix that would leave a file wrong, unclear or repeating itself;
- a change that would break a test or the project's checks.

Wording that is only a matter of taste is minor, and an audit doesn't
report it.

The project's owner has also ruled two kinds of finding out, so an
audit doesn't report them either:

- text or code that doesn't cover a non-standard installation. A setting
  changed from its shipped value is still in scope, but not a change
  that makes the setup non-standard, such as `nginx`'s certificate
  folder moved out of `nginx`'s own place, or a path setting that puts
  one of the tool's files inside the feature's own `app-data/`, `logs/`
  or `tmp/`, which `undo-apply` removes whole. A command run between a
  setting's change and the `apply` that puts it in place is the
  operator's error: the docs warn of it, and the code doesn't guard it;
- the layout of a feature README's sections: `## Run` opens with the
  command that runs the feature, `apply` here, and `### Usage` sits
  under it.

## 6. Writing a Fix

- Name the file, and the line or heading.
- Quote the whole text the fix replaces, a sentence or a paragraph, and
  give the whole new text. An editor then can't apply it in the wrong
  place, or leave half of the old text behind.
- Check the new text against the code as hard as the old: a fix can
  bring in a wrong fact of its own.
- Make the smallest fix that works. An audit runs in rounds, which
  [The Rounds of an Audit](#the-rounds-of-an-audit) describes, and a
  round can find faults in the rewrites of the round before. So a
  passage whose wording an earlier round chose is left alone unless a
  significant finding holds against it.

### Traps a Rewrite Falls Into

The feature README's writing audits found these again and again in the
rewrites of the rounds before them. Check each new text for them:

- a pointer that could point at either of two things, or an "it" and an
  "its" in one sentence that point at different things, which
  [One Idea to a Sentence](#one-idea-to-a-sentence) warns of;
- a name used before its introduction, because the rewrite moved it
  above the sentence that introduces it;
- a colon whose sentence doesn't describe the list or block after it;
- "before X or Y", "until X or Y" or "after X or Y", which a reader can
  take as complete at X, reading "or Y" as a new thought rather than as
  part of the same condition;
- a sentence that opens with "Or", whose alternative is unclear;
- a reason repeated from the line before.

## 7. The Fresh-Reader Loop

### Why Fresh Readers

An audit report, or a large rewrite of the docs, is checked by fresh
readers before its fixes are made. A fresh reader is an agent that knows
nothing of the project but its brief, so the text must make sense to a
newcomer, which is the reader the docs are for. Each reader reports only
significant findings; the editor fixes those, and sends the next reader,
until one finds no significant issue.

A reader that checks every fact repeats the work of every reader before
it. So only the first reader does a full pass. Every later reader also
gets the facts earlier readers confirmed, and a diff of what changed
since the last pass: it checks the changed text hardest, and skips a
confirmed fact unless the report now words that fact differently, or the
fact reads as wrong.

### The Files of the Loop

Keep them in one folder beside the report, such as `tmp/<audit>/`, which
`git` ignores:

- `report.md`: the live report, edited after each pass.
- `report-pass-N.md`: a copy of the report exactly as reader N checked
  it.
- `changes-since-pass-N.diff`: what changed after reader N's pass, made
  with `diff report-pass-N.md report-pass-M.md`, where M is the next
  pass.
- `confirmed-facts.md`: every fact a reader confirmed against the
  repository, each with its evidence (file and line), under a heading
  for the reader who confirmed it.

### The Steps of the Loop

1. Copy the report to `report-pass-1.md`, and send reader 1 with the
   full-pass brief.
2. When a reader reports, check each finding against the files and the
   code yourself before fixing anything: a reader can be wrong, and a
   fix it suggests can bring in a wrong fact.
3. Fix each finding that holds, in `report.md`, and add the facts the
   reader confirmed to `confirmed-facts.md`, under its name.
4. Copy `report.md` to the next pass's file, and make the diff from the
   two copies.
5. Send the next reader, a new agent, with the efficient-pass brief.
   Repeat steps 2 to 5 until a reader finds no significant issue; then
   make the fixes.

If a pass is cut off and its copy is missing, rebuild the copy by undoing
the edits made since, then make the diff.

### The Full-Pass Brief

Fill in each part in angle brackets.

```text
You're a fresh reader checking an audit report before anyone acts on it. You know nothing of this project yet, and that's the point: the report must make sense to a reader like you.

The report is <path to report.md>. It audits <what it audits>, and proposes a fix for each problem. Once the report passes, each fix will be made as written, so a wrong fix would go straight into <the files it changes>.

First read the report once, alone, top to bottom. Note every passage you can't follow, every name it uses before saying what it is, and every step of reasoning it skips. Then check it against its sources:
- each item's diagnosis against the files it cites
- each fix's facts against the code it cites, which is in <code paths>, with the tests in <test paths>
- each fix against the report's own rules
- the fixes against each other: whether two now say the same fact twice, contradict each other, or one breaks another
- whether each fix says plainly what it replaces, so that an editor can't apply it wrongly
- whether any change would break a test or the project's checks

Report only significant issues:
- a wrong fact, in a diagnosis or in a fix
- a fix that would leave a file wrong, unclear, or repeating itself
- a missing step of reasoning
- a name or tool the report uses before it's introduced
- anything that would mislead, or break a test

Wording that is only a matter of taste isn't significant. <The project's own exclusions, such as rulings the owner has made.> For each issue, give the item number, what's wrong, the evidence (file and line), and the fix. If you find no significant issue, say so plainly, in one line.

End with a list of the facts you confirmed against the repository, each with its evidence (file and line), so the next reader can skip them.

Change no file. Return your findings as your final message.
```

### The Efficient-Pass Brief

Fill in each part in angle brackets, with N the number of readers so
far.

```text
You're a fresh reader checking an audit report before anyone acts on it. You know nothing of this project yet, and that's the point: the report must make sense to a reader like you.

The report is <path to report.md>. It audits <what it audits>, and proposes a fix for each problem. Once the report passes, each fix will be made as written, so a wrong fix would go straight into <the files it changes>.

<N> readers have already checked the report, and each problem they found has been fixed. Two files save you from repeating their work:
- <path to confirmed-facts.md> lists the facts they confirmed against the repository, each with its evidence. Skip a fact listed there unless the report now words it differently, or it reads as wrong to you.
- <path to changes-since-pass-N.diff> shows what changed in the report since the last reader.

Read the whole report once, alone, top to bottom, as a newcomer: note every passage you can't follow, every name it uses before saying what it is, and every step of reasoning it skips. Then check the changed text hardest. Check against the files and the code each fact you don't skip. The code is in <code paths>, the tests in <test paths>. Also check:
- each fix against the report's own rules
- the fixes against each other: whether two now say the same fact twice, contradict each other, or one breaks another
- whether each fix says plainly what it replaces, so that an editor can't apply it wrongly
- whether any change would break a test or the project's checks

Report only significant issues:
- a wrong fact, in a diagnosis or in a fix
- a fix that would leave a file wrong, unclear, or repeating itself
- a missing step of reasoning
- a name or tool the report uses before it's introduced
- anything that would mislead, or break a test

Wording that is only a matter of taste isn't significant. <The project's own exclusions.> For each issue, give the item number, what's wrong, the evidence (file and line), and the fix. If you find no significant issue, say so plainly, in one line.

End with a list of the facts you confirmed against the repository that the confirmed-facts file doesn't already list, each with its evidence (file and line), so the next reader can skip them.

Change no file. Return your findings as your final message.
```

The same briefs serve for a set of docs with no report, such as a large
rewrite, with the docs named in place of the report, and the code they
describe. Each brief then drops what only a report has: the fixes it
proposes, the sentence that says they'll be made as written, and the
checks of each item's diagnosis and fix. Since the full-pass brief names
the code only in one of those checks, it asks instead for each fact in
the docs to be checked against the code, which is in `<code paths>`,
with the tests in `<test paths>`. In the brief's list of significant
issues, "a wrong fact in the docs" and "a break of the standard in
sections 2 and 3 of `docs/claude/CLAUDE-ENGLISH-AUDIT.md`, such as an
unclear passage or a fact said twice in one doc" take the place of the
two items on diagnoses and fixes, and each issue gives its section in
place of an item number. The loop's copies and diffs are then of the
docs, and each finding that holds is fixed in the docs themselves.

### The Rounds of an Audit

A round is one cycle of the audit: the findings of its auditors, the
report built from them, the readers who check the report, and the fixes.
Once the readers pass the report, its fixes are made, and the gate,
`npm run check`, runs on the newest release of each Node.js major CI
tests, code-fuzzing included. When the fixes change a feature's code, the system test runs
too. The fixes then reach `main` through a pull request, as every change
does.

The next round starts with new auditors, and the rounds go on until one
finds no significant issue: a round that finds only a few, or only small
ones, isn't the last.

## 8. Findings From Past Audits, Before and After

Each row below is a finding from this project's audits, and the text
that fixed it.

| Before | Why it failed | After |
| --- | --- | --- |
| The feature README's Overview, in its first bullet: "`apply` adds `--private-rpc` to `x1console`'s start script" | Named `apply` before anything said the tool has commands. | How It Works opens with "The tool's `apply` command sets everything up, in stages, asking before each one that changes something." |
| "Since the tool keeps no key, it shows each key once, when it's made: save it then." | A vague verb, "keeps" for stores; two "it"s for two things; and a cause, a fact and an order in one sentence, which didn't say what to save. | "The tool stores only a hash of each key, never the key itself, and a hash can't be turned back into its key. So the tool can show you a key only once, when it makes the key." The order moved to Run apply, where `apply` prints the key's urls: "**Save them now, off the validator**: the client needs them, and so do you, to remove the key later, since no command can show the key again." |
| "with more than `certificateWarningDays` left" | The code checks `daysLeft >= warningDays`, so exactly that many days left passes. | "with at least `certificateWarningDays` left" |
| `ensure`'s row in `docs/project-commands.md` gave `--from-git-hook`, which "skips that wait", at its end, after the alerts. | The exception sat far from the rule it changes. | The sentence right after the wait gives `--from-git-hook`, which has `ensure` put the flag back at once. |

## 9. The Automated Checks

The gate, `npm run check`, which must pass before every commit, runs
these checks of text:

- The Markdown lint, `markdownlint-cli2`, which checks the form of each
  Markdown file `MARKDOWN_TARGETS` in `scripts/lint-targets.js` lists,
  with the settings in `.markdownlint-cli2.jsonc`. `MD041` makes each
  file open with a heading. `MD024`, set to `siblings_only`, lets a
  heading repeat only under different parents. `MD033` fails inline
  HTML. `MD051` fails a link to a heading the same file doesn't have,
  and `MD059` fails link text such as "here". `MD013`, the rule on line
  length, is off.
- The help checks. `test/script-help.test.js` checks that each script
  run by its path answers `--help` and `-h` with help that gives usage
  examples. The feature's `test/cli.test.js` checks the tool's own help
  and each command's, and its tests of the standalone tools check
  theirs. Each of these tests also fails a help when an option it lists,
  other than `--help` and `--version`, is in none of its examples, by
  its long or its short form, and when an example uses an option that
  the help of the command it runs doesn't list. A script's example that runs
  an `npm run` target counts as the command the target runs, from
  `package.json`. An example in the tool's own help runs one of its
  commands, so the help of that command must list the example's
  options. `test/helpers/help-options.js` makes the comparison.
- The checks that hold docs to the code. In the feature's tests:
  `doc-figures.test.js`, which
  [Say What Can Change a Figure](#say-what-can-change-a-figure)
  describes; `cli.test.js` and `disclaimer.test.js`, which
  [Keeping Every Text Saying the Same Thing](#keeping-every-text-saying-the-same-thing)
  describes; and `examples.test.js`, which
  [Shell Scripts](#shell-scripts) describes, and which also fails the
  examples' README when its list leaves out an example. In the
  project's own tests, `repo-rules.test.js` fails a file that gives a
  minimum Node.js other than the one `engines` names, or names an older
  major than that one, other than `x1console`'s 20.
- The checks that quote the code's text. A test can hold the words of a
  help text or a message. And each entry in a feature's list of
  code-fuzzing changes, its `test/code-fuzzing.json`, finds the code it
  changes by quoting that code, which can be a help text, a message or
  a comment. When the text an entry quotes isn't in the entry's file
  exactly once, the project's `test/code-fuzzing.test.js` fails, and so
  does code-fuzzing. So a fix that rewords such text also changes each
  test and each entry that quotes the old words.
- Prettier, a program that formats code, for the JavaScript, json and
  yaml; and ESLint, which checks JavaScript against rules, whose
  `max-lines` limit doesn't count comments.

No check yet follows a link to another file, or to a heading in another
file. None holds `docs/npm-project-commands.md` to the targets in
`package.json`, or the list of test helpers and fixtures in the
feature's `docs/engineering.md` to its `test/` folder. The help checks
compare a help's examples with its options, so they can't tell whether
a common use that has no option of its own, such as running `ensure` by
hand before the validator's restart, has an example. So an audit checks
each of these itself. The checks above catch form, and the few facts the
tests hold docs to; only a reader catches any other wrong fact.

## 10. A Checklist for Each Text

- [ ] Says how the system works now; tells no history.
- [ ] Each topic and sub-topic opens with its context.
- [ ] Each tool and term is introduced at its first mention in this
      text, in four parts.
- [ ] No adjective stands in for a fact; each number has its unit.
- [ ] Every branch of the code that changes the outcome is in the text,
      each exception beside its rule.
- [ ] One word for each idea, and the code's names for settings, files,
      commands and messages.
- [ ] One idea to a sentence; each "it" or "its" points at one thing.
- [ ] Each fact said once in this text.
- [ ] Each figure a setting can change says so, and names the setting.
- [ ] Each day, week or month names its time zone, and each week its
      first day.
- [ ] Each message and output is quoted exactly; in a Markdown doc, each
      program's name is in backticks, and a feature's own name only as a
      command.
- [ ] A clickable table of contents, three levels deep, in a doc of
      more than five `##` sections besides the table of contents;
      unique headings; every link resolves.
- [ ] Each JSDoc block matches its code's order and every return case.
- [ ] Each test title still matches what its test holds the code to.
- [ ] Each help lists every option its program takes, and gives a usage
      example of each common use.
- [ ] Every other text that states the same fact says it the same way.
- [ ] Each fix quotes the whole text it replaces and gives the whole new
      text.
