# Card sources

Each company declares where its cards come from in `sources:` of `company.yaml` (or `tenants.yaml`). What each type can do:

| Type            | How cards arrive                                    | Start by key                                     | Sub-task bases                       |
| --------------- | --------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `jira`          | periodic JQL search                                 | yes (`PF-123`)                                   | yes (`subtasks: branch-per-subtask`) |
| `businessmap`   | periodic read of the trigger column/tag (read-only) | yes (card id, `48816`), even outside the trigger | no                                   |
| `github-issues` | webhook                                             | no                                               | no                                   |
| `bitbucket`     | webhook (`/ai` comments on PRs)                     | no                                               | no                                   |

## Businessmap

Source `businessmap`, **read-only**: Guilda AI only makes `GET` calls to the API v2 and never moves, comments on or attaches anything to the board.

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
    repositoryField: 13 # custom field (link) holding the card's repository
    routeTags: { rule: feature, screen: screen } # board tag → route of the method
```

- **Trigger:** an open card of the board in the trigger column **or** with the tag. Closed/archived cards stay out. A card already taken stays in the column without creating another task.
- **Repository required:** the link in `repositoryField` picks the project (compared with each GitLab project's `repository`). Without a link, or with a repository no project has, the card is skipped (reason logged once) and comes in by itself once fixed.
- **Route by tag** (projects with a method): exactly one route tag. Without `routeTags`, a tag named as a route of the method is that route. Case and accents do not matter. With no route tag, or two, the card does not come in by itself: the route is never guessed. When nobody can create tags on the board, start the card by hand and state the route (below).
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
