# Dev loop

Build the package, load it into an n8n instance, and round-trip workflows without the UI.
Needs Docker and Python 3 on the host (no Node.js). Configure targets in `dev.env`
(copy `dev.env.example`; it is gitignored and holds API keys).

```bash
scripts/dev/build.sh                 # npm ci (first time), n8n-node build, eslint
scripts/dev/deploy.sh test           # restart the test instance (test/docker-compose.yml)
scripts/dev/deploy.sh prod --dry-run # show what a prod deploy would do
scripts/dev/wf.py test list Interaxo
scripts/dev/wf.py prod pull <id> some/workflow.json
scripts/dev/wf.py test push some/workflow.json      # create or update, records the id per target
scripts/dev/wf.py test activate <id>                # sub-workflows must be active to be called
scripts/dev/wf.py test run <id> out.json            # execute via the CLI, per-node item counts
```

## Targets

- **test** — the isolated instance from `test/`. It mounts `dist/` directly, so deploying is
  a restart. Anything goes.
- **prod** — your real n8n. The dev build is copied to `<data dir>/custom/n8n-nodes-interaxo`
  and loads *beside* the published community package as node type `CUSTOM.interaxo`, so
  existing workflows keep using the published version. Guards:
  - `deploy.sh prod` restarts n8n only when no execution is running (waits up to
    `--wait` minutes, default 30).
  - `wf.py` only pushes, activates or deactivates workflows whose name starts with
    `DEV_PREFIX` (default `DEV`), never overwrites an active workflow, and only activates
    workflows whose triggers are Execute Workflow / manual (nothing can start on its own).
  - Credentials are re-pinned on push from `<TARGET>_CRED_<type>` so the same JSON works on
    both instances.

## n8n 2.x notes

- `/healthz` answers before the API routes exist; the scripts wait for `/api/v1`.
- Execute Workflow refuses inactive sub-workflows — activate DEV sub-workflows to test them.
- `n8n execute` inside the container needs its own ports (`N8N_PORT`, task-runner broker)
  while the server is running; `wf.py run` sets them.
