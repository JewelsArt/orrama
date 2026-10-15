#!/usr/bin/env python3
"""
R13 switch-over: the settings outside the repo still say BASALT_*, and the renamed code reads
only ORRAMA_*. This script moves them, in two phases, for the integrator to run at ship time
with Jules's OK (changes/R13.md has the order).

    python3 changes/R13-switchover.py                      # phase add, dry run: says what it would do
    python3 changes/R13-switchover.py --apply              # phase add: an ORRAMA_ twin beside every BASALT_
    python3 changes/R13-switchover.py --phase drop --apply # after ship is confirmed: drop the BASALT_ ones
    ... --vault-mcp                                        # also ~/Obsidian Vault/.mcp.json (Jules's yes first)
    ... --only launch                                      # one file at a time: plist, claude-json, vault-mcp, launch

Phase add writes ORRAMA_X with the same value beside every BASALT_X and changes nothing else.
Old code reads BASALT_X, new code reads ORRAMA_X (and is satisfied, since the twin is there),
so after this phase either build runs. Phase drop removes each BASALT_X whose ORRAMA_X twin
holds the same value; it leaves ~/.claude/launch.json alone, because pre-R13 worktrees still
read the old names there.

Files: ~/Library/LaunchAgents/dev.basalt.server.plist (EnvironmentVariables), ~/.claude.json
(every MCP server running apps/mcp/dist/index.js), ~/.claude/launch.json (every
"BASALT_X=value" in runtimeArgs), and with --vault-mcp the vault's .mcp.json.

Safety: never prints a value, only variable names; dry run unless --apply; before writing, each
file is copied to ~/.orrama-switchover-backup/<time>-<phase>-<pid>/ (folders 700, files 600: they hold
secrets); writes are atomic (temp file in the same folder, same mode, rename) and read back.
--home points every path at another folder, for trying it on copies.
"""
import argparse
import json
import os
import plistlib
import shutil
import stat
import sys
import tempfile
import time

OLD, NEW = "BASALT_", "ORRAMA_"


def twin(name):
    return NEW + name[len(OLD):]


def plan_env(env, phase):
    """The changes for one name -> value mapping: [(action, name)], and the new mapping."""
    out, changes = dict(env), []
    for name in list(env):
        if not name.startswith(OLD):
            continue
        if phase == "add" and twin(name) not in env:
            out[twin(name)] = env[name]
            changes.append(("add", twin(name)))
        elif phase == "drop":
            if env.get(twin(name)) == env[name]:
                del out[name]
                changes.append(("drop", name))
            else:
                changes.append(("KEEP (no twin with the same value)", name))
    return changes, out


def write_atomic(path, data: bytes):
    mode = stat.S_IMODE(os.stat(path).st_mode)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".r13-")
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.close(fd)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def backup(path, folder, home):
    for d in (os.path.dirname(folder), folder):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    dest = os.path.join(folder, os.path.relpath(path, home).replace("/", "__"))
    if os.path.exists(dest):
        raise SystemExit(f"refusing to overwrite the backup {dest}")
    shutil.copy2(path, dest)
    os.chmod(dest, 0o600)
    return dest


def plist_target(path, phase):
    with open(path, "rb") as f:
        data = plistlib.load(f)
    env = data.get("EnvironmentVariables", {})
    changes, new_env = plan_env(env, phase)

    def render():
        data["EnvironmentVariables"] = dict(sorted(new_env.items()))
        return plistlib.dumps(data, fmt=plistlib.FMT_XML)

    def check():
        with open(path, "rb") as f:
            back = plistlib.load(f).get("EnvironmentVariables", {})
        return back == new_env

    return changes, render, check


def json_target(path, phase, pick):
    """pick(doc) yields the env dicts to change (and creates nothing)."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    changes, plans = [], []
    for where, env in pick(doc):
        c, new_env = plan_env(env, phase)
        changes += [(a, f"{n}  ({where})") for a, n in c]
        plans.append((env, new_env))

    def render():
        for env, new_env in plans:
            env.clear()
            env.update(new_env)
        return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

    def check():
        with open(path, encoding="utf-8") as f:
            back = json.load(f)
        return [sorted(e.items()) for _, e in pick(back)] == [sorted(n.items()) for _, n in plans]

    return changes, render, check


def mcp_servers(doc, prefix=""):
    """Every MCP server entry in a ~/.claude.json or .mcp.json that runs this repo's MCP server."""
    if isinstance(doc, dict):
        for key, value in doc.items():
            if key == "mcpServers" and isinstance(value, dict):
                for name, server in value.items():
                    args = " ".join(map(str, server.get("args") or []))
                    env = server.get("env")
                    if isinstance(env, dict) and ("apps/mcp/dist/index.js" in args or any(k.startswith(OLD) for k in env)):
                        yield f"{prefix}mcpServers.{name}", env
            else:
                yield from mcp_servers(value, f"{prefix}{key[:48]}.")


def launch_target(path, phase):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    changes, edits = [], []
    for conf in doc.get("configurations", []):
        args = conf.get("runtimeArgs") or []
        pairs = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in args if isinstance(a, str) and "=" in a and a.split("=", 1)[0].isupper()}
        c, new_env = plan_env(pairs, "add") if phase == "add" else ([], pairs)
        if not c:
            continue
        new_args = []
        for a in args:
            new_args.append(a)
            name = a.split("=", 1)[0] if isinstance(a, str) and "=" in a else None
            if name and name.startswith(OLD) and twin(name) not in pairs:
                new_args.append(f"{twin(name)}={new_env[twin(name)]}")
        changes += [(act, f"{n}  ({conf.get('name')})") for act, n in c]
        edits.append((conf, new_args))

    def render():
        for conf, new_args in edits:
            conf["runtimeArgs"] = new_args
        return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

    def check():
        with open(path, encoding="utf-8") as f:
            back = json.load(f)
        by_name = {c.get("name"): c.get("runtimeArgs") for c in back.get("configurations", [])}
        return all(by_name.get(conf.get("name")) == new_args for conf, new_args in edits)

    return changes, render, check


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", choices=["add", "drop"], default="add")
    ap.add_argument("--apply", action="store_true", help="write the files (default: dry run)")
    ap.add_argument("--vault-mcp", action="store_true", help="also the vault's .mcp.json (Jules's yes first)")
    ap.add_argument("--home", default=os.path.expanduser("~"), help="another home folder, to try it on copies")
    ap.add_argument("--only", action="append", choices=["plist", "claude-json", "vault-mcp", "launch"], help="just this file (repeatable)")
    a = ap.parse_args()
    home = a.home
    targets = [
        ("plist", "launchd plist", os.path.join(home, "Library/LaunchAgents/dev.basalt.server.plist"), lambda p: plist_target(p, a.phase)),
        ("claude-json", "~/.claude.json", os.path.join(home, ".claude.json"), lambda p: json_target(p, a.phase, mcp_servers)),
    ]
    if a.vault_mcp:
        targets.append(("vault-mcp", "vault .mcp.json", os.path.join(home, "Obsidian Vault/.mcp.json"), lambda p: json_target(p, a.phase, mcp_servers)))
    if a.phase == "add":
        targets.append(("launch", "~/.claude/launch.json", os.path.join(home, ".claude/launch.json"), lambda p: launch_target(p, a.phase)))
    if a.only:
        if "vault-mcp" in a.only and not a.vault_mcp:
            raise SystemExit("--only vault-mcp needs --vault-mcp too (Jules's yes first)")
        targets = [t for t in targets if t[0] in a.only]

    folder = os.path.join(home, ".orrama-switchover-backup", f"{time.strftime('%Y%m%d-%H%M%S')}-{a.phase}-{os.getpid()}")
    print(f"R13 switch-over, phase {a.phase}, {'APPLY' if a.apply else 'dry run'}")
    failed = False
    for _, label, path, make in targets:
        if not os.path.exists(path):
            print(f"\n{label}: {path} — not found, skipped")
            continue
        changes, render, check = make(path)
        print(f"\n{label}: {path}")
        if not changes:
            print("  nothing to change")
            continue
        for action, name in changes:
            print(f"  {action}: {name}")
        if not a.apply or not any(act in ("add", "drop") for act, _ in changes):
            continue
        saved = backup(path, folder, home)
        write_atomic(path, render())
        ok = check()
        failed |= not ok
        print(f"  written; backup {saved}; read back {'matches' if ok else 'DOES NOT MATCH — restore the backup'}")
    if a.apply and a.phase == "add" and any(t[0] == "plist" for t in targets):
        print("\nNext: reload the agent so it runs with the twins (changes/R13.md, step 3).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
