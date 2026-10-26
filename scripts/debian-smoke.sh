#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Run ONLY in a disposable Debian container: this installs and removes packages.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
test "${MIRA_DISPOSABLE_DEBIAN_TEST:-}" = 1
test "$(id -u)" = 0
test -f /.dockerenv
artifacts=/artifacts
output=/results
mkdir -p "$output"
packages=("$artifacts"/Mira-Graphical-*-amd64.deb)
test "${#packages[@]}" = 1
package=${packages[0]}
test -f "$package"
test "$(dpkg-deb -f "$package" Package)" = mira-graphical
test "$(dpkg-deb -f "$package" Architecture)" = amd64
version=$(dpkg-deb -f "$package" Version)
apt-get update
apt-get install -y --no-install-recommends ca-certificates xvfb xauth dbus-x11 desktop-file-utils unzip python3
useradd --create-home --shell /bin/bash mira-test
install -d -m 700 -o mira-test -g mira-test /home/mira-test/runtime
apt-get install -y --no-install-recommends "$package"
test "$(dpkg-query -W -f='${Version}' mira-graphical)" = "$version"
binary=$(readlink -f /usr/bin/mira-graphical)
test -x "$binary"
application=$(dirname "$binary")
test -f "$application/resources/companion/mira-graphical.vsix"
test -f "$application/resources/Mira-Graphical-Source.zip"
unzip -t "$application/resources/companion/mira-graphical.vsix"
desktop-file-validate /usr/share/applications/mira-graphical.desktop
! grep -q -- '--no-sandbox' /usr/share/applications/mira-graphical.desktop
dpkg -L mira-graphical | grep '/icons/.*mira-graphical.png$'
check() {
  local phase=$1
  local workspace="/home/mira-test/project with spaces/$phase"
  install -d -o mira-test -g mira-test "$workspace"
  runuser -u mira-test -- env HOME=/home/mira-test XDG_RUNTIME_DIR=/home/mira-test/runtime \
    dbus-run-session -- xvfb-run -a "$binary" --package-check "--workspace=$workspace" \
    > "$output/$phase.log" 2>&1
  python3 - "$workspace/package-check.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert all(r[k] is True for k in ['passed','packaged','renderer','preloadIPC','simulation','clockedSimulation','clockedHierarchy','clockedVhdl'])
PY
  cp "$workspace/package-check.json" "$output/$phase.json"
}
check installed
# A version-only fixture exercises dpkg replacement; it is not a historical release.
dpkg-deb --raw-extract "$package" /tmp/mira-upgrade-fixture
sed -i 's/^Version: .*/Version: 0.0.0/' /tmp/mira-upgrade-fixture/DEBIAN/control
dpkg-deb --build --root-owner-group /tmp/mira-upgrade-fixture /tmp/mira-old.deb
dpkg -i /tmp/mira-old.deb
test "$(dpkg-query -W -f='${Version}' mira-graphical)" = 0.0.0
apt-get install -y --no-install-recommends "$package"
test "$(dpkg-query -W -f='${Version}' mira-graphical)" = "$version"
check upgraded
apt-get install -y --reinstall --no-install-recommends "$package"
check reinstalled
printf 'keep project data\n' > '/home/mira-test/project with spaces/keep.sv'
apt-get purge -y mira-graphical
test ! -e "$binary"
test ! -e /usr/share/applications/mira-graphical.desktop
test -f '/home/mira-test/project with spaces/keep.sv'
test -d '/home/mira-test/project with spaces/installed/.hdlgraph'
find '/home/mira-test/project with spaces/installed/.hdlgraph' -name 'checkpoint-*.json' -print -quit | grep -q .
python3 - "$version" "$output/debian-smoke.json" <<'PY'
import json,sys
release=dict(line.strip().split('=',1) for line in open('/etc/os-release') if '=' in line)
json.dump(dict(passed=True,version=sys.argv[1],debian=release['VERSION_ID'].strip('"'),architecture='amd64',installed=True,upgraded=True,reinstalled=True,removed=True,projectDataPreserved=True,sandboxDisabled=False,display='X11 via Xvfb',upgradeFixture='version-only package metadata'),open(sys.argv[2],'w'),indent=2)
PY
