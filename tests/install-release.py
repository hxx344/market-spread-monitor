"""Real CI archive installation on disposable GitHub Actions systemd runners."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.geteuid() == 0
kind = sys.argv[1]
assert kind in ('monitor', 'asset')
name = 'market-spread-monitor' if kind == 'monitor' else 'asset-ledger'
root = Path('/opt') / name
data = Path('/var/lib') / name
config = Path('/etc/market-spread-monitor.env') if kind == 'monitor' else data / 'config.json'
installer = Path('deploy/install.sh' if kind == 'monitor' else 'install.sh').resolve()
output = Path('release-output').resolve()
manifest = json.loads((output / 'release-manifest.json').read_text())
architecture = 'linux-arm64' if os.uname().machine in ('aarch64', 'arm64') else 'linux-x64'
artifact = manifest['artifacts'][architecture]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs).stdout.strip()

def pid():
    return run('systemctl', 'show', '--property=MainPID', '--value', name)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

with tempfile.TemporaryDirectory(prefix=name + '-ci-fixture-') as temporary:
    fixture = Path(temporary)
    shutil.copy2(output / artifact['file'], fixture / artifact['file'])
    manifest_path = fixture / 'release-manifest.json'
    def save(value):
        manifest_path.write_text(json.dumps(value))
    save(manifest)
    wrapper = fixture / 'install.sh'
    wrapper.write_text('''curl() {
  local argument previous='' url='' destination=''
  for argument in "$@"; do
    [[ $previous != -o ]] || destination=$argument
    [[ $argument != https://github.com/*/releases/* ]] || url=$argument
    previous=$argument
  done
  if [[ -n $url ]]; then
    [[ -n $destination ]] || return 1
    printf '%s\\n' "$url" >> "$RELEASE_FIXTURE/downloads"
    cp -- "$RELEASE_FIXTURE/${url##*/}" "$destination"
  else command curl "$@"; fi
}
''' + installer.read_text())
    environment = {**os.environ, 'RELEASE_FIXTURE': str(fixture)}
    environment.pop('PROJECT_DEPLOY_MODE', None)
    environment.pop('PROJECT_DEPLOY_MANIFEST_FILE', None)
    def install(success=True):
        result = subprocess.run(['bash', str(wrapper), '--port', '31877' if kind == 'monitor' else '3179'], env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print(result.stdout, flush=True)
        assert (result.returncode == 0) == success, result.stdout
    previous = (root / 'current').resolve() if (root / 'current').exists() else None
    config_before = digest(config) if config.exists() else None
    install()
    current = (root / 'current').resolve()
    assert (current / '.release-application-key').read_text().strip() == artifact['application_key']
    if previous:
        assert current != previous, 'Source installation must migrate to an immutable CI runtime'
        assert digest(config) == config_before, 'Configuration must survive source migration'
    configuration = digest(config)
    sentinel = data / 'ci-preservation-fixture'
    sentinel.write_text('preserve-data')
    original_pid = pid()
    assert int(original_pid) > 0
    downloads = (fixture / 'downloads').read_text().count('.tar.gz')
    # The hub preflight hands its exact root-owned manifest to the installer.
    environment['PROJECT_DEPLOY_MANIFEST_FILE'] = str(manifest_path)
    manifest_downloads = (fixture / 'downloads').read_text().count('release-manifest.json')
    install()
    assert pid() == original_pid and (root / 'current').resolve() == current
    assert (fixture / 'downloads').read_text().count('.tar.gz') == downloads
    # A documentation-only commit has new identity but the same application key.
    docs = json.loads(json.dumps(manifest))
    docs['commit'] = 'a' * 40
    docs['tag'] = 'deploy-' + docs['commit']
    save(docs)
    install()
    assert pid() == original_pid and (root / 'current').resolve() == current
    assert (fixture / 'downloads').read_text().count('.tar.gz') == downloads
    # Corrupt bytes cannot reach the active service, configuration or data.
    damaged = json.loads(json.dumps(manifest))
    damaged['artifacts'][architecture]['sha256'] = '0' * 64
    damaged['artifacts'][architecture]['application_key'] = 'b' * 64
    save(damaged)
    install(False)
    assert pid() == original_pid and (root / 'current').resolve() == current
    # A fully checksummed package that fails startup exercises real rollback.
    staged = fixture / 'broken'
    staged.mkdir()
    with tarfile.open(output / artifact['file']) as archive:
        archive.extractall(staged)
    failed = json.loads(json.dumps(manifest))
    failed['commit'] = 'c' * 40
    failed['tag'] = 'deploy-' + failed['commit']
    failed_artifact = failed['artifacts'][architecture]
    failed_artifact['application_key'] = 'd' * 64
    failed_artifact['file'] = 'failed-runtime.tar.gz'
    (staged / '.release-commit').write_text(failed['commit'] + '\n')
    (staged / '.release-application-key').write_text(failed_artifact['application_key'] + '\n')
    entry = staged / ('server/linux.mjs' if kind == 'monitor' else '.next/standalone/server.js')
    entry.write_text('throw new Error("intentional CI startup failure");\n')
    archive_path = fixture / failed_artifact['file']
    with tarfile.open(archive_path, 'w:gz') as archive:
        archive.add(staged, arcname='.')
    failed_artifact['sha256'] = digest(archive_path)
    save(failed)
    install(False)
    assert (root / 'current').resolve() == current
    run('systemctl', 'is-active', '--quiet', name)
    assert digest(config) == configuration
    assert sentinel.read_text() == 'preserve-data'
    assert (fixture / 'downloads').read_text().count('release-manifest.json') == manifest_downloads
    if kind == 'monitor':
        runtime = current / '.runtime/bin/node'
        run('systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--property=EnvironmentFile=' + str(config), str(runtime), str(current / 'deploy/check-install.mjs'), '--quiet')
    else:
        health = run('curl', '--fail', '--silent', '--retry', '10', '--retry-connrefused', '--retry-delay', '1', 'http://127.0.0.1:3179/api/health')
        assert json.loads(health)['release'] == manifest['commit']
    sentinel.unlink()
    print('CI installation passed: migration/fresh install, no-op, same-content commit, checksum rejection, startup rollback and data/config preservation.')
