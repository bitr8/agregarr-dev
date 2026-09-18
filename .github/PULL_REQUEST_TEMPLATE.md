#### Scope

Ref #XXXX (the issue where this was agreed; a one-line fix can skip this)

#### What changed

#### What an existing install sees on first sync

(Anything rewritten in Plex, how many times, and how a user opts out. "Nothing" is a valid answer.)

#### Verified against a live server

(What you ran it on and what you checked.)

#### Screenshot (if UI-related)

#### Checklist

- [ ] One concern, under ~400 lines net (or the series plan is in the description)
- [ ] Review changes go up as fixup commits, no force-push until the squash is asked for
- [ ] Tests cover the code that writes settings or calls Plex, and fail on the old code
- [ ] Comments are one short line, only where the why isn't obvious
- [ ] New behaviour has a config option; defaults don't change existing installs
- [ ] Type checking (`yarn typecheck`)
- [ ] Lint and format (`yarn lint`, `npx prettier --check .`)
- [ ] Tests (`yarn test`)
- [ ] Translation keys extracted (`yarn i18n:extract`) - if new user-facing strings added
- [ ] Database migration included - if schema changes required

See [CONTRIBUTING.md](https://github.com/bitr8/agregarr-dev/blob/develop/CONTRIBUTING.md).
