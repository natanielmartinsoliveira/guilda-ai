# Card sources

Each company declares where its cards come from in `sources:` of `company.yaml` (or `tenants.yaml`). What each type can do:

| Type            | How cards arrive                        | Start by key                                     | Sub-task bases                       |
| --------------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `jira`          | periodic JQL search                     | yes (`PF-123`)                                   | yes (`subtasks: branch-per-subtask`) |
| `businessmap`   | periodic read of the trigger column/tag | yes (card id, `48816`), even outside the trigger | no                                   |
| `github-issues` | webhook                                 | no                                               | no                                   |
| `bitbucket`     | webhook (`/ai` comments on PRs)         | no                                               | no                                   |

## Businessmap

Source `businessmap`: Guilda AI reads the board through the API v2. Its only write is moving the card to the columns named in `moves` (none by default); it never comments on, tags or attaches anything.

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
```

- **Trigger:** an open card of the board in the trigger column **or** with the tag. Closed/archived cards stay out. A card already taken stays in the column without creating another task.
- **Repository required:** the link in `repositoryField` picks the project (compared with each GitLab project's `repository`). Without a link, or with a repository no project has, the card is skipped (reason logged once) and comes in by itself once fixed.
- **Route by tag** (projects with a method): exactly one route tag. Without `routeTags`, a tag named as a route of the method is that route. Case and accents do not matter. With two route tags the card does not come in; with none it comes in and the task asks the operator which route (the method's routes as options, also as Telegram buttons): the route is never guessed.
- **Card follows the task** (`moves`, optional): `gate` when a method phase marked `board: gate` starts (e.g. waiting for the operator's approval), `building` for `board: building`, `built` when the delivery is done (a rehearsal included), `review` when the PR opens. A refused move is logged; the task goes on.
- **Task:** key = card id, body = description (HTML → text) + titles of the parent/related cards. Card attachments are not read yet.

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
