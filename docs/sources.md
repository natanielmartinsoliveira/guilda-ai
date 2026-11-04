# Card sources

Each company declares where its cards come from in `sources:` of `company.yaml` (or `tenants.yaml`). What each type can do:

| Type            | How cards arrive                        | Start by key                                     | Sub-task bases                       |
| --------------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `jira`          | periodic JQL search                     | yes (`PF-123`)                                   | yes (`subtasks: branch-per-subtask`) |
| `businessmap`   | periodic read of the trigger column/tag | yes (card id, `48816`), even outside the trigger | no                                   |
| `github-issues` | webhook                                 | no                                               | no                                   |
| `bitbucket`     | webhook (`/ai` comments on PRs)         | no                                               | no                                   |

## Businessmap

Source `businessmap`: Guilda AI reads the board through the API v2. Its only write on the board is moving the card to the columns named in `moves` and `review.approved`, and giving a reviewed card back to its owner (none by default); it never comments on, tags or attaches anything there.

```yaml
sources:
  - id: businessmap
    type: businessmap
    baseUrl: https://initech.kanbanize.com
    token: ${INITECH_BUSINESSMAP_TOKEN} # your user's API key (My Account → API)
    boardId: 79
    trigger:
      columns: [3170] # column(s) that trigger
      tag: ai-dev-team # or this tag, in any flow of the board
      owners: [291] # only cards of these users (ids); empty: anyone's
    repositoryField: 13 # custom field (link) holding the card's repository
    routeTags: { rule: feature, screen: screen } # board tag → route of the method
    moves: { gate: 3169, building: 3170, built: 3171, review: 3172 } # optional: column per step
    review: { columns: [3172], approved: 3173, reviewer: 291 } # optional: code review of the card's merge request
```

- **Trigger:** an open card of the board in the trigger column **or** with the tag. Closed/archived cards stay out. A card already taken stays in the column without creating another task.
- **Repository required:** the link in `repositoryField` picks the project (compared with each GitLab project's `repository`). Without a link, or with a repository no project has, the card is skipped (reason logged once) and comes in by itself once fixed.
- **Route by tag** (projects with a method): exactly one route tag. Without `routeTags`, a tag named as a route of the method is that route. Case and accents do not matter. With two route tags the card does not come in; with none it comes in and the task asks the operator which route (the method's routes as options, also as Telegram buttons): the route is never guessed.
- **Card follows the task** (`moves`, optional): `gate` when a method phase marked `board: gate` starts (e.g. waiting for the operator's approval), `building` for `board: building`, `built` when the delivery is done (a rehearsal included), `review` when the PR opens. A refused move is logged; the task goes on.
- **Task:** key = card id, body = description (HTML → text) + titles of the parent/related cards. Card attachments are not read yet.

### Code review of a card's merge request

With `review`, a card that enters one of its `columns` has its GitLab merge request reviewed, whoever owns the card (`owners` narrows it). No method takes part.

- **Which MR:** the first merge request link of the company's GitLab in `repositoryField`, else in the description. A card without one, or with a closed MR, is skipped (reason logged once).
- **The review:**
  - the MR's branch is cloned at its current commit and the target branch fetched for the diff;
  - the project's knowledge folders are copied in;
  - the project's `prepare` and `test` run, with no fixer;
  - the reviewer (the company's `reviewer` role, else its `coder`) reads the change read-only, with the card, the lessons and the knowledge. Card and MR text are fenced as untrusted.
- **The result:**
  - one comment goes to the merge request: verdict, problems (`file:line`), tests, commit;
  - the review shows on the task screen and is its own step in the metrics;
  - **approved** (the reviewer approves _and_ the tests pass) moves the card to `approved`; with changes the card stays.
  - **Failures that came before the MR:** when the tests fail, the same suite runs where the MR leaves its target branch. Failing there too, they do not count against the MR, and the reviewer gets both outputs to check the MR added none.
  - **Our environment, not the MR:** dependencies that do not install stop the review as an environment problem, before any comment, with a retry in the panel. A review whose tests never ran does not count: the same commit is reviewed again.
- **Whose review** (`reviewer`, optional): a card is reviewed only once that user took it (made it theirs on the board, which records it), so a colleague's card is never taken for them. One that was always theirs is not reviewed. With changes it goes back to the owner it had before (read from the card's versions); approved, it stays with them. A failed review of the same commit waits for Retry in the panel instead of starting again on each poll.
- **Again:** a new commit on the MR is reviewed again while the card is in the column; the same commit never twice. Nothing is committed or pushed, and the task folder is discarded after the comment.
- **Kept apart:** reviews live under their own issue (`<card>:review`), so the card's build task, its restart and its board steps never see them.

## Starting a card by its key

In the panel: **New task → Source card**. Pick the company, the source (when the company has more than one that starts cards) and the key in the source's format. The rules of the periodic read apply: the project by the card's repository field (Businessmap) or Jira project, the route by tag (projects with a method) or, on a Businessmap source, the **Route** you pick there (optional; a card's own route tag still counts, and a choice against it is refused), and a card that already has a task never creates another one.

Through the API:

```
GET  /api/tenants                                    → sources: [{ id, type, label, key, example, bases }]
POST /api/tenants/<company>/sources/<source>/start   { "key": "PF-123", "base": "feature/PF-1"?, "route": "fix"? }
GET  /api/tenants/<company>/sources/<source>/cards/<key>/bases
```

- `202` with `{ taskId }`, or `200` with `{ skipped, taskId? }` when the card does not become a task (with the reason).
- `400`: a key outside the source's format (the message has an example), or a `route` for a source that takes none (only Businessmap does). `404`: no such source in the company, or one that does not start cards / has no bases. `502`: the source or the code host failed (message without secrets).
- The old routes `POST /tasks/from-jira` and `GET /jira/<key>/bases` still work, using the company's first Jira source.
