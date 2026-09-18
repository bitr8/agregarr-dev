# Contributing

Cheers for pitching in. One person maintains this fork in their spare time, so these rules make review manageable. They aren't gatekeeping. Agree on scope first, keep PRs small, prove the change works, and keep comments short.

## Before you write code

Open an issue, or comment on the existing one, with what you plan to change and roughly how you'll do it.

Skip this for a one-line fix. It's required for anything that adds a setting, source, or route, or changes what Agregarr writes to Plex. Most of the back-and-forth on past PRs came from scope that could've been settled in two comments before writing code.

## Size

Keep each PR to one concern. Aim for fewer than about 400 net lines changed. Anything over 800 gets a bot comment asking whether it can be split, and I'll read it after the smaller PRs.

Ship big features as a series. Start with the smallest working slice and the interfaces the rest will build on. Include the plan for the series in the first PR description so each part can be reviewed against it. Sort Titles 2.0 (#113, #114) is a worked example.

## What a PR needs

- **Tests for the code that writes state.** Pure helpers are easy to test and worth covering, but the bug usually sits in the function that saves settings or calls Plex. Test that function. The test should break on the old code for the same reason the fix exists.
- **Short comments where the reason isn't obvious.** One line. No narrative blocks, issue numbers, or comments that restate the next line. If the comment is longer than the code it explains, delete it. Put the story in the commit message and PR description.
- **A description of what changed and what an existing install will see.** Every install that pulls `develop` runs the change on its next sync. If the first run rewrites anything in Plex, including sort titles, labels, posters, or collections, say what it rewrites, how many times, and how users can opt out. Defaults must preserve existing behaviour.
- **A config option for new behaviour.** Anything that costs API calls or disk space, or changes what users see, needs a toggle or setting. Default it off unless it replaces something broken.
- **Verification against a real server.** Say what you ran it against and what you checked. "Tests pass" isn't verification. Run a sync on a library with the feature enabled.
- **Local gates passing:** `yarn typecheck`, `yarn lint`, `npx prettier --check .`, and `yarn test`. CI runs the same checks and will tell you, but running them locally is faster.

## AI-assisted code

That's fine, and most PRs here contain some. Two conditions: you've run it against a real Plex, and you understand every line well enough to answer "why is this here?" during review.

Generated code tends to arrive with long comments, defensive branches nothing reaches, and helpers with one caller. Trim those before opening the PR. They're what most of the review ends up covering.

## Process

- Branch from `develop` and rebase onto it before opening the PR. Once review starts, push fixup commits on top and leave the history alone. A force-push throws away the diff since the last review, so the whole PR gets read again from scratch. I'll ask for the squash at merge time.
- Reference issues with `Ref #N`, not `Fixes #N`. Issues close when the reporter confirms the fix, not when the code lands.
- Expect "merge with changes" rather than a plain approval. I run two independent reviews on every PR, then post the findings as questions with file and line references. Answer in the thread or with a commit, whichever suits.
- Blockers come first in my review. Anything under "smaller" can ride along or land in a follow-up. Your call.
- No drive-by changes. Open an issue or separate PR for anything unrelated.

## What won't merge

- A PR without a linked issue or scope discussion, unless it's a small, obvious fix.
- Anything that changes what existing installs write to Plex without an opt-out.
- Secrets, hostnames, or personal config in the diff.
- A file rewrite to match a different style. Match the file you're working in.
