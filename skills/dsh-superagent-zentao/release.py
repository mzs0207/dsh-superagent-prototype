"""Copy one verified MR change to test; deploy through the repository's Jenkins CLI.

Only the sync command creates a local checkout. Publishing is a separate guarded
worker operation after tests pass in that checkout. No force pushes or resets.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

JOB = "web-community-backend-pipeline"


def git(repository, *args):
    result = subprocess.run(["git", "-C", str(repository), *args], text=True, capture_output=True, check=True)
    return result.stdout.strip()


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def sync(repository, commit, directory):
    if not re.fullmatch(r"[a-f0-9]{40,64}", commit):
        raise ValueError("A full merged commit SHA is required")
    namespace = hashlib.sha256(str(directory).encode()).hexdigest()[:20]
    common = Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    checkpoint = common / f"zentao-release-{namespace}.json"
    with checkpoint.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = json.loads(checkpoint.read_text()) if checkpoint.exists() else None
        if saved and saved["sourceCommit"] != commit:
            raise RuntimeError("Test worktree was reserved for another fix")
        if directory.exists():
            if not saved or not saved.get("testCommit"):
                raise RuntimeError("Interrupted test copy has no confirmed checkpoint; inspect it manually, do not adopt or reset it")
            if git(directory, "status", "--porcelain"):
                raise RuntimeError("Existing test worktree is dirty or conflicted; inspect it, do not reset it")
            if Path(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")) != common:
                raise RuntimeError("Test worktree belongs to another repository")
            if git(directory, "rev-parse", "HEAD") != saved["testCommit"] or git(directory, "rev-parse", "HEAD^") != saved["testBase"]:
                raise RuntimeError("Test worktree changed after the verified cherry-pick; do not adopt additional commits")
            return {key: saved[key] for key in ("testDirectory", "testCommit", "testBase")}
        if saved and saved.get("testCommit"):
            raise RuntimeError("Confirmed test worktree is missing; inspect the existing release before recreating it")
        refs = f"refs/dsh-superagent/zentao/{namespace}"
        git(repository, "fetch", "--no-tags", "--no-write-fetch-head", "origin",
            f"refs/heads/develop:{refs}/develop", f"refs/heads/test:{refs}/test")
        git(repository, "merge-base", "--is-ancestor", commit, f"{refs}/develop")
        base = saved["testBase"] if saved else git(repository, "rev-parse", f"{refs}/test")
        save(checkpoint, {"sourceCommit": commit, "testBase": base})
        parents = git(repository, "rev-list", "--parents", "-n", "1", commit).split()[1:]
        if len(parents) not in (1, 2):
            raise RuntimeError("Expected one squash commit or a two-parent MR merge")
        git(repository, "worktree", "add", "--detach", str(directory), base)
        identity = []
        if os.environ.get("DSH_SUPERAGENT_ACCOUNT") and os.environ.get("DSH_SUPERAGENT_COMMIT_EMAIL"):
            identity = ["-c", "user.name=" + os.environ["DSH_SUPERAGENT_ACCOUNT"], "-c", "user.email=" + os.environ["DSH_SUPERAGENT_COMMIT_EMAIL"]]
        git(directory, *identity, "cherry-pick", "-x", *(["-m", "1"] if len(parents) == 2 else []), commit)
        result = {"testDirectory": str(directory), "testCommit": git(directory, "rev-parse", "HEAD"), "testBase": base}
        save(checkpoint, {"sourceCommit": commit, **result})
        return result


def jenkins(repository):
    path = repository / "scripts" / "jenkins_build.py"
    spec = importlib.util.spec_from_file_location("zentao_jenkins_build", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Repository scripts/jenkins_build.py is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.JOB_NAME != JOB:
        raise RuntimeError("Only web-community-backend-pipeline is authorized")
    config = module.load_config()
    if config.get("job_name", JOB) != JOB:
        raise RuntimeError("Jenkins config names a different job")
    return module, config


def check(repository, commit=None, services=None):
    module, config = jenkins(repository)
    status, body, _ = module.request(config["base_url"], config["username"], config["api_token"], f"/job/{JOB}/api/json?tree=buildable")
    if status != 200 or json.loads(body).get("buildable") is not True:
        raise RuntimeError(f"Jenkins job is not available/buildable: HTTP {status}")
    if commit is not None or services is not None:
        if not commit or not services:
            raise ValueError("Commit and affected services must be supplied together")
        release_services(module, {"repository": str(repository), "mergeCommit": commit, "services": services})
    return {"job": JOB, "buildable": True, "services": list(module.ALLOWED_SERVICES)}


def verify_build(module, config, number, service, commit):
    path = f"/job/{JOB}/{int(number)}/api/json?tree=number,building,result,url,actions[parameters[name,value],lastBuiltRevision[SHA1]]"
    status, body, _ = module.request(config["base_url"], config["username"], config["api_token"], path)
    if status != 200:
        raise RuntimeError(f"Cannot verify Jenkins build {number}: HTTP {status}")
    build = json.loads(body)
    params = {item["name"]: item["value"] for action in build.get("actions", []) for item in action.get("parameters", [])}
    shas = {action.get("lastBuiltRevision", {}).get("SHA1") for action in build.get("actions", [])}
    if build.get("building") or build.get("result") != "SUCCESS":
        raise RuntimeError(f"Jenkins build {number} is not a completed SUCCESS")
    if params.get("GIT_BRANCH") != "test" or params.get("SERVICE_NAME") != service or str(params.get("DEPLOY")).lower() != "true":
        raise RuntimeError(f"Jenkins build {number} was not a test deployment of {service}")
    if commit not in shas:
        raise RuntimeError(f"Jenkins build {number} did not prove checkout of test commit {commit}")
    return {"service": service, "number": int(number), "url": build["url"], "commit": commit}


def release_services(module, receipt):
    requested = receipt["services"]
    if not requested or any(service not in module.ALLOWED_SERVICES for service in requested):
        raise RuntimeError("Select affected services from the repository Jenkins CLI allowlist")
    paths = git(receipt["repository"], "diff-tree", "--no-commit-id", "--name-only", "-r", receipt["mergeCommit"] + "^", receipt["mergeCommit"]).splitlines()
    affected = {path.split("/")[1] for path in paths if path.startswith("services/") and len(path.split("/")) > 2}
    unknown = affected - set(module.ALLOWED_SERVICES)
    if unknown:
        raise RuntimeError(f"Services need an explicit supported deployment mapping: {sorted(unknown)}")
    if "all" not in requested and not affected.issubset(set(requested)):
        raise RuntimeError(f"Deployment omits changed services: {sorted(affected - set(requested))}")
    # Shared runtime/build configuration changes can affect all services.
    shared = any(path.startswith(("shared/", "common/", "packages/", "libs/")) or path in ("pyproject.toml", "uv.lock", "Dockerfile", "Jenkinsfile", "docker-compose.yml") for path in paths)
    if shared and "all" not in requested:
        raise RuntimeError("Shared runtime/build changes require service=all or manual release review")
    return list(dict.fromkeys(requested))


def publish(repository, commit, directory, test_commit, path, services):
    """Reconcile publication under the same lock used by deployment; never erase a trigger receipt."""
    expected = {"repository": str(repository), "mergeCommit": commit, "testCommit": test_commit, "services": services}
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = json.loads(path.read_text()) if path.exists() else {**expected, "published": False, "builds": {}}
        if any(receipt.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Existing release receipt describes another revision or service plan; do not overwrite it")
        if receipt.get("published"):
            return {"published": True, "testCommit": test_commit, "receipt": str(path)}
        check(repository, commit, services)
        if git(directory, "rev-parse", "HEAD") != test_commit or git(directory, "status", "--porcelain"):
            raise RuntimeError("Test worktree changed after verification; do not publish it")
        save(path, receipt)
        git(directory, "push", "origin", f"{test_commit}:refs/heads/test")
        receipt["published"] = True
        save(path, receipt)
        return {"published": True, "testCommit": test_commit, "receipt": str(path)}


def deploy(path, verify_only=False):
    lock = path.with_suffix(".lock")
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        receipt = json.loads(path.read_text(encoding="utf-8"))
        try:
            return run_builds(path, receipt, verify_only)
        except Exception as error:
            receipt["failure"] = str(error)
            receipt["failureAt"] = str(time.time_ns())
            save(path, receipt)
            raise


def run_builds(path, receipt, verify_only):
    repository = Path(receipt["repository"])
    module, config = jenkins(repository)
    services = release_services(module, receipt)
    if not receipt.get("published"):
        raise RuntimeError("Verify and publish the cherry-picked test worktree before deployment")
    builds = receipt.setdefault("builds", {})
    verified = []
    for service in services:
        record = builds.get(service)
        if verify_only:
            if not record or not record.get("number"):
                raise RuntimeError(f"No build receipt for {service}")
        else:
            current = git(repository, "ls-remote", "origin", "refs/heads/test").split()[0]
            if current != receipt["testCommit"]:
                raise RuntimeError("Remote test moved; pause instead of deploying another revision")
            if record is None:
                # Persist intent before the external write. An ambiguous interruption is NOT an automatic retrigger.
                record = builds[service] = {"starting": True}
                save(path, receipt)
                number, queue = module.trigger_build(config, "test", service, True)
                record.update({"starting": False, "number": number, "queue": queue})
                save(path, receipt)
            if record.get("starting"):
                raise RuntimeError(f"Ambiguous trigger for {service}; inspect Jenkins manually, do not retrigger")
            if record.get("number") is None:
                if record.get("queue") is None:
                    raise RuntimeError("Jenkins returned no build or queue ID")
                record["number"] = module.wait_for_queue_item(config, record["queue"], 3600)
                save(path, receipt)
            state = module.wait_for_build(config, record["number"], 3600)
            if state.get("result") != "SUCCESS":
                record["result"] = state.get("result")
                raise RuntimeError(f"Build {record['number']} failed: {state.get('result')}; pause this bug")
        evidence = verify_build(module, config, record["number"], service, receipt["testCommit"])
        record["result"] = "SUCCESS"; record["url"] = evidence["url"]
        verified.append(evidence)
        save(path, receipt)
    receipt.pop("failure", None)
    receipt.pop("failureAt", None)
    save(path, receipt)
    return {"testCommit": receipt["testCommit"], "builds": verified}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    copy = commands.add_parser("sync")
    copy.add_argument("--repository", required=True, type=Path)
    copy.add_argument("--commit", required=True)
    copy.add_argument("--directory", required=True, type=Path)
    probe = commands.add_parser("check")
    probe.add_argument("--repository", required=True, type=Path)
    probe.add_argument("--commit")
    probe.add_argument("--services", nargs="+")
    publication = commands.add_parser("publish")
    publication.add_argument("--repository", required=True, type=Path)
    publication.add_argument("--commit", required=True)
    publication.add_argument("--directory", required=True, type=Path)
    publication.add_argument("--test-commit", required=True)
    publication.add_argument("--receipt", required=True, type=Path)
    publication.add_argument("--services", nargs="+", required=True)
    for name in ("deploy", "verify"):
        command = commands.add_parser(name)
        command.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "sync":
        result = sync(args.repository.resolve(), args.commit, args.directory.resolve())
    elif args.command == "check":
        result = check(args.repository.resolve(), args.commit, args.services)
    elif args.command == "publish":
        result = publish(args.repository.resolve(), args.commit, args.directory.resolve(), args.test_commit, args.receipt.resolve(), args.services)
    else:
        result = deploy(args.receipt.resolve(), verify_only=args.command == "verify")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        print(f"ZenTao release stopped: {detail}", file=sys.stderr)
        sys.exit(1)
