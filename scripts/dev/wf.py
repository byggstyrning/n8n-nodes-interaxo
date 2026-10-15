#!/usr/bin/env python3
"""Workflow round-trips for the dev loop (stdlib only).

  wf.py <target> list [filter]           id, active flag and name of matching workflows
  wf.py <target> pull <id> <file.json>   save a workflow (name, nodes, connections, settings)
  wf.py <target> push <file.json>        create or update; writes the target id back into the
                                         file under "ids": {"<target>": "<id>"}
  wf.py <target> activate <id>           publish a sub-workflow so Execute Workflow can call it
                                         (n8n 2.x refuses inactive sub-workflows). Only allowed
                                         when every trigger is Execute Workflow / manual, so an
                                         activated workflow can never start on its own
  wf.py <target> deactivate <id>
  wf.py <target> replace <id> <file.json> --confirm <id>
                                         swap the nodes/connections of an existing (possibly
                                         ACTIVE, non-DEV) workflow, keeping its id, name and
                                         settings: backs up the full workflow first, PUTs the
                                         new draft, publishes it if the workflow was active and
                                         checks the published version is the new one
  wf.py <target> restore <backup.json> --confirm <id>
                                         put a backup's nodes/connections back the same way
  wf.py <target> run <id> [out.json]     execute via the n8n CLI inside the container and
                                         print a per-node summary (full result to out.json)

Guards for target "prod": push/activate/deactivate only touch workflows whose name starts
with DEV_PREFIX; push refuses to overwrite an active workflow (deactivate it first).
Credentials are re-pinned on push from <TARGET>_CRED_<type>="<id>:<name>" in dev.env.
"""
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DEV_DIR = os.path.dirname(os.path.abspath(__file__))


def load_env():
    env = {}
    path = os.path.join(DEV_DIR, 'dev.env')
    if not os.path.exists(path):
        sys.exit(f'missing {path} (copy dev.env.example)')
    for line in open(path, encoding='utf8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


ENV = load_env()
PREFIX = ENV.get('DEV_PREFIX') or 'DEV'
# settings keys the public API accepts on create/update
SETTINGS_KEYS = {'executionOrder', 'callerPolicy', 'callerIds', 'timezone', 'errorWorkflow',
                 'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions',
                 'saveExecutionProgress', 'executionTimeout', 'availableInMCP'}


def tvar(target, name):
    return ENV.get(f'{target.upper()}_{name}', '')


def api(target, method, path, body=None):
    req = urllib.request.Request(
        f"{tvar(target, 'URL').rstrip('/')}/api/v1{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'X-N8N-API-KEY': tvar(target, 'API_KEY'), 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path} → HTTP {e.code}: {e.read().decode(errors="replace")[:500]}')


def cmd_list(target, needle=''):
    cursor, rows = None, []
    while True:
        page = api(target, 'GET', '/workflows?limit=250' + (f'&cursor={cursor}' if cursor else ''))
        rows += page.get('data', [])
        cursor = page.get('nextCursor')
        if not cursor:
            break
    for w in sorted(rows, key=lambda w: w['name']):
        if needle.lower() in w['name'].lower():
            print(f"{w['id']}  {'ACTIVE' if w.get('active') else '      '}  {w['name']}")


def cmd_pull(target, wid, path):
    w = api(target, 'GET', f'/workflows/{wid}')
    out = {k: w[k] for k in ('name', 'nodes', 'connections', 'settings') if k in w}
    out['ids'] = {target: wid}
    with open(path, 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"pulled {w['name']} ({len(w['nodes'])} nodes) → {path}")


def pin_credentials(target, nodes):
    for node in nodes:
        for ctype in list((node.get('credentials') or {}).keys()):
            pin = tvar(target, f'CRED_{ctype}')
            if pin:
                cid, _, cname = pin.partition(':')
                node['credentials'][ctype] = {'id': cid, 'name': cname or ctype}


def cmd_push(target, path):
    with open(path, encoding='utf8') as f:
        doc = json.load(f)
    name = doc['name']
    if target == 'prod' and not name.startswith(PREFIX):
        sys.exit(f'refusing: prod pushes need a name starting with "{PREFIX}" (got "{name}")')
    nodes = doc['nodes']
    pin_credentials(target, nodes)
    body = {
        'name': name,
        'nodes': nodes,
        'connections': doc['connections'],
        'settings': {k: v for k, v in (doc.get('settings') or {}).items() if k in SETTINGS_KEYS},
    }
    wid = (doc.get('ids') or {}).get(target)
    existing = None
    if wid:
        try:
            existing = api(target, 'GET', f'/workflows/{wid}')
        except SystemExit:
            existing = None
    if existing:
        if existing.get('active'):
            sys.exit(f'refusing: {wid} "{existing["name"]}" is active on {target}')
        if target == 'prod' and not existing['name'].startswith(PREFIX):
            sys.exit(f'refusing: {wid} "{existing["name"]}" on prod is not a {PREFIX} workflow')
        api(target, 'PUT', f'/workflows/{wid}', body)
        print(f'updated {target} {wid} "{name}"')
    else:
        created = api(target, 'POST', '/workflows', body)
        wid = created['id']
        print(f'created {target} {wid} "{name}"')
    doc.setdefault('ids', {})[target] = wid
    with open(path, 'w', encoding='utf8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)


PASSIVE_TRIGGERS = {'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.manualTrigger'}


def guarded(target, wid):
    w = api(target, 'GET', f'/workflows/{wid}')
    if target == 'prod' and not w['name'].startswith(PREFIX):
        sys.exit(f'refusing: "{w["name"]}" on prod is not a {PREFIX} workflow')
    return w


def cmd_activate(target, wid):
    w = guarded(target, wid)
    triggers = [n['type'] for n in w['nodes']
                if n['type'].endswith('Trigger') or n['type'].endswith('.webhook') or 'trigger' in n['type'].lower()]
    active = [t for t in triggers if t not in PASSIVE_TRIGGERS]
    if active:
        sys.exit(f'refusing: "{w["name"]}" has triggers that would fire on their own: {active}')
    api(target, 'POST', f'/workflows/{wid}/activate')
    print(f'activated {target} {wid} "{w["name"]}"')


def cmd_deactivate(target, wid):
    w = guarded(target, wid)
    api(target, 'POST', f'/workflows/{wid}/deactivate')
    print(f'deactivated {target} {wid} "{w["name"]}"')


BACKUP_DIR = os.path.join(DEV_DIR, 'backups')


def _require_confirm(wid, args):
    if args[-2:] != ['--confirm', wid]:
        sys.exit(f'refusing: pass --confirm {wid} to modify workflow {wid}')


def _swap(target, wid, nodes, connections, label):
    current = api(target, 'GET', f'/workflows/{wid}')
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = os.path.join(BACKUP_DIR, f'{target}-{wid}-before-{label}-{stamp}.json')
    # 'x': never overwrite an earlier backup
    with open(backup, 'x', encoding='utf8') as f:
        json.dump(current, f, ensure_ascii=False, indent=1)
    print(f'backup → {backup}')
    was_active = bool(current.get('active'))
    pin_credentials(target, nodes)
    before_settings = current.get('settings') or {}
    # the public API rejects some UI-only keys (binaryMode, timeSavedMode); send the rest
    body = {'name': current['name'], 'nodes': nodes, 'connections': connections,
            'settings': {k: v for k, v in before_settings.items() if k in SETTINGS_KEYS}}
    api(target, 'PUT', f'/workflows/{wid}', body)
    if was_active:
        # n8n 2.x: PUT only changes the draft; activating publishes it
        api(target, 'POST', f'/workflows/{wid}/activate')
    after = api(target, 'GET', f'/workflows/{wid}')
    published = after.get('activeVersion') or {}
    names_now = sorted(n['name'] for n in (published.get('nodes') if was_active else after['nodes']))
    names_want = sorted(n['name'] for n in nodes)
    lost = {k: v for k, v in before_settings.items() if after.get('settings', {}).get(k) != v}
    if lost:
        print(f'WARNING: settings changed by the update: {lost} → now {after.get("settings")}')
    ok = not lost and names_now == names_want and (not was_active or after.get('activeVersionId') == after.get('versionId'))
    print(f"{label}d {target} {wid} \"{after['name']}\": active={after.get('active')} "
          f"published={after.get('activeVersionId')} draft={after.get('versionId')} nodes={names_now}")
    if not ok:
        sys.exit(f'VERIFY FAILED — published nodes {names_now} != expected {names_want}; restore from {backup}')


def cmd_replace(target, wid, path, *args):
    _require_confirm(wid, list(args))
    with open(path, encoding='utf8') as f:
        doc = json.load(f)
    _swap(target, wid, doc['nodes'], doc['connections'], 'replace')


def cmd_restore(target, path, *args):
    with open(path, encoding='utf8') as f:
        doc = json.load(f)
    wid = doc['id']
    _require_confirm(wid, list(args))
    _swap(target, wid, doc['nodes'], doc['connections'], 'restore')


def cmd_run(target, wid, out_path=None):
    container = tvar(target, 'CONTAINER')
    # the CLI starts a second n8n process in the container: give it its own ports and
    # skip the task runner so it doesn't collide with the server already running there
    proc = subprocess.run(
        ['docker', 'exec', '-e', 'N8N_RUNNERS_ENABLED=false', '-e', 'N8N_RUNNERS_BROKER_PORT=5699',
         '-e', 'N8N_PORT=5698', container, 'n8n', 'execute', '--id', wid, '--rawOutput'],
        capture_output=True, text=True,
    )
    raw = proc.stdout
    # the result is the first top-level JSON object; log lines may precede or follow it
    start = raw.find('\n{') + 1 if not raw.startswith('{') else 0
    if start <= 0 and not raw.startswith('{'):
        sys.exit(f'no execution result (rc={proc.returncode}):\n{proc.stderr[-2000:]}')
    result, _ = json.JSONDecoder().raw_decode(raw[start:])
    if out_path:
        with open(out_path, 'w', encoding='utf8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
    run_data = result.get('data', {}).get('resultData', {}).get('runData', {})
    error = result.get('data', {}).get('resultData', {}).get('error')
    for node, runs in run_data.items():
        for run in runs:
            main = ((run.get('data') or {}).get('main') or [])
            counts = [len(o or []) for o in main]
            err = (run.get('error') or {}).get('message')
            print(f"{node:<45} items={counts} {'ERROR: ' + err if err else ''}")
    if error:
        print(f"WORKFLOW ERROR: {error.get('message')}")
        sys.exit(1)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('test', 'prod'):
        sys.exit(__doc__)
    target, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    if not tvar(target, 'URL'):
        sys.exit(f'{target.upper()}_URL not set in dev.env')
    handlers = {'list': cmd_list, 'pull': cmd_pull, 'push': cmd_push, 'run': cmd_run,
                'activate': cmd_activate, 'deactivate': cmd_deactivate,
                'replace': cmd_replace, 'restore': cmd_restore}
    if cmd not in handlers:
        sys.exit(__doc__)
    handlers[cmd](target, *args)


if __name__ == '__main__':
    main()
