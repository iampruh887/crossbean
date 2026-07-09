#!/usr/bin/env bash
# Builds dist/crossbean-<version>.x86_64.rpm from dist/crossbean-linux-x64/.
# Run on Linux (needs rpmbuild: apt install rpm / dnf install rpm-build)
# after: bun run scripts/build-release.ts
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${VERSION:-0.1.0}"
DIST="$(pwd)/dist/crossbean-linux-x64"
TOP="$(pwd)/dist/rpm-top"

[ -d "$DIST" ] || { echo "missing $DIST — run: bun run scripts/build-release.ts"; exit 1; }

rm -rf "$TOP"
mkdir -p "$TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

cat > "$TOP/SPECS/crossbean.spec" <<EOF
Name:           crossbean
Version:        $VERSION
Release:        1
Summary:        Local-first notes with an AI-powered knowledge graph
License:        MIT
BuildArch:      x86_64
Requires:       gtk3, webkit2gtk4.1
AutoReqProv:    no

%description
Markdown notes stored in a vector database (sqlite-vec). Connections between
notes are made by hand with wikilinks or discovered automatically via
embedding cosine similarity, and drawn as an interactive graph.

%install
mkdir -p %{buildroot}/opt/crossbean %{buildroot}%{_bindir} \\
         %{buildroot}%{_datadir}/applications \\
         %{buildroot}%{_datadir}/icons/hicolor/scalable/apps
cp -r $DIST/. %{buildroot}/opt/crossbean/
ln -s /opt/crossbean/crossbean %{buildroot}%{_bindir}/crossbean
cp $(pwd)/packaging/linux/crossbean.desktop %{buildroot}%{_datadir}/applications/
cp $(pwd)/assets/icon.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/crossbean.svg

%files
/opt/crossbean
%{_bindir}/crossbean
%{_datadir}/applications/crossbean.desktop
%{_datadir}/icons/hicolor/scalable/apps/crossbean.svg
EOF

rpmbuild --define "_topdir $TOP" -bb "$TOP/SPECS/crossbean.spec"
cp "$TOP"/RPMS/x86_64/crossbean-*.rpm dist/
rm -rf "$TOP"
echo "built $(ls dist/crossbean-*.rpm)"
