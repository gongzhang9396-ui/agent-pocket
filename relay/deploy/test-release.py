#!/usr/bin/env python3
"""Linux deployment fault tests. All state is disposable; systemctl is mocked."""
import hashlib, os, pathlib, shutil, subprocess, tarfile, tempfile

source = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='pocket-release-test-') as directory:
    root = pathlib.Path(directory)
    paths = ['/opt/agent-pocket-relay', '/var/lib/agent-pocket-relay', '/var/backups/agent-pocket-relay', '/etc/agent-pocket-relay', '/etc/systemd/system', '/usr/local/bin']
    for path in paths: (root / path[1:]).mkdir(parents=True)
    scripts = root / 'scripts'; scripts.mkdir()
    for name in ['release-state.sh', 'deploy-release.sh', 'rollback.sh']:
        text = (source / name).read_text()
        for path in paths: text = text.replace(path, str(root / path[1:]))
        (scripts / name).write_text(text)
        subprocess.run(['bash', '-n', str(scripts / name)], check=True)
    bindir = root / 'bin'; bindir.mkdir()
    def command(name, text):
        path = bindir / name; path.write_text('#!/usr/bin/env bash\nset -eu\n' + text); path.chmod(0o755)
    command('id', 'echo 0\n')
    command('npm', 'exit 0\n')
    command('sleep', 'exit 0\n')
    command('curl', '[[ "$(readlink "$TEST_ROOT/opt/agent-pocket-relay/current")" != *bad* ]] || exit 1\necho \'{"ok":true}\'\n')
    command('systemctl', '''state="$TEST_ROOT/service-state"
case "$1" in
stop) [[ ! -e "$TEST_ROOT/fail-stop" ]] || exit 1; echo stopped > "$state";;
show) [[ "$(cat "$state")" == stopped ]] && echo 0 || echo 999;;
is-active) [[ "$(cat "$state")" == active ]];;
daemon-reload) exit 0;;
start) [[ "$(readlink "$TEST_ROOT/opt/agent-pocket-relay/current")" != *bad-start ]] || exit 1; echo active > "$state"; if [[ "$(readlink "$TEST_ROOT/opt/agent-pocket-relay/current")" != *old ]]; then printf v3 > "$TEST_ROOT/var/lib/agent-pocket-relay/relay.db"; printf new-wal > "$TEST_ROOT/var/lib/agent-pocket-relay/relay.db-wal"; printf new-shm > "$TEST_ROOT/var/lib/agent-pocket-relay/relay.db-shm"; fi;;
*) exit 1;;
esac
''')
    env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], TEST_ROOT=str(root))
    releases = root / 'opt/agent-pocket-relay/releases'; old = releases / 'old'; (old / 'dist').mkdir(parents=True)
    (old / 'dist/cli.js').write_text('old')
    current = root / 'opt/agent-pocket-relay/current'; current.symlink_to(old)
    data = root / 'var/lib/agent-pocket-relay'; (data / 'relay.db').write_text('v2')
    (root / 'etc/agent-pocket-relay/relay.env').write_text('AGENT_POCKET_WEB_ENABLED=false\n')
    (root / 'etc/systemd/system/agent-pocket-relay.service').write_text('old-unit')
    (root / 'usr/local/bin/agent-pocket-register-update').write_text('old-helper')
    (root / 'service-state').write_text('active')
    package = root / 'package'; package.mkdir()
    for name in ['dist/cli.js', 'dist/register-update.js', 'admin/dist/index.html', 'web/dist/index.html', 'package-lock.json', 'deploy/agent-pocket-relay.service', 'deploy/register-update.sh', 'deploy/release-state.sh', 'deploy/rollback.sh', 'deploy/deploy-release.sh']:
        path = package / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}')
    artifact = root / 'release.tar.gz'
    with tarfile.open(artifact, 'w:gz') as archive:
        for path in package.iterdir(): archive.add(path, arcname=path.name)
    key = root / 'key.pem'; public = root / 'public.pem'; signature = root / 'signature'
    subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(key)], check=True, capture_output=True)
    subprocess.run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(public)], check=True, capture_output=True)
    subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin', '-in', str(artifact), '-out', str(signature)], check=True, capture_output=True)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    def deploy(version):
        return subprocess.run(['bash', str(scripts / 'deploy-release.sh'), str(artifact), version, digest, str(signature), str(public), '--enable-web'], env=env, capture_output=True, text=True)
    def old_restored():
        assert current.resolve() == old
        assert (data / 'relay.db').read_text() == 'v2'
        assert not (data / 'relay.db-wal').exists() and not (data / 'relay.db-shm').exists()
        assert (root / 'etc/agent-pocket-relay/relay.env').read_text() == 'AGENT_POCKET_WEB_ENABLED=false\n'
        assert (root / 'service-state').read_text().strip() == 'active'
    assert deploy('..').returncode != 0; old_restored()
    (root / 'fail-stop').touch(); failed = deploy('stop-failure'); assert failed.returncode != 0; old_restored(); (root / 'fail-stop').unlink()
    failed = deploy('bad-health'); assert failed.returncode != 0, failed.stdout + failed.stderr; old_restored()
    failed = deploy('bad-start'); assert failed.returncode != 0, failed.stdout + failed.stderr; old_restored()
    succeeded = deploy('good'); assert succeeded.returncode == 0, succeeded.stdout + succeeded.stderr
    assert (data / 'relay.db').read_text() == 'v3'
    backups = root / 'var/backups/agent-pocket-relay'
    backup = next(path for path in backups.iterdir() if '-good-' in path.name)
    # A corrupt backup is refused before stopping the current service.
    (backup / 'relay.db').write_text('corrupt')
    args = ['bash', str(scripts / 'rollback.sh'), 'old', str(backup)]
    assert subprocess.run(args, env=env, capture_output=True).returncode != 0
    assert (root / 'service-state').read_text().strip() == 'active'
    (backup / 'relay.db').write_text('v2')
    rolled_back = subprocess.run(args, env=env, capture_output=True, text=True)
    assert rolled_back.returncode == 0, rolled_back.stdout + rolled_back.stderr
    old_restored()
    print('PASS: traversal rejected; stop failure preserves live state; failed upgrade restores DB/WAL/SHM/config; checksum refusal; manual rollback')
