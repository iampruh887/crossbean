#!/usr/bin/env bash
# Builds dist/crossbean_<version>_amd64.deb from dist/crossbean-linux-x64/.
# Run on Linux after: bun run scripts/build-release.ts
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${VERSION:-0.1.0}"
ARCH="${ARCH:-amd64}"
DIST="dist/crossbean-linux-x64"
STAGE="dist/deb-stage"

[ -d "$DIST" ] || { echo "missing $DIST — run: bun run scripts/build-release.ts"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/crossbean" "$STAGE/usr/bin" \
         "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/scalable/apps"

cp -r "$DIST"/. "$STAGE/opt/crossbean/"
ln -s /opt/crossbean/crossbean "$STAGE/usr/bin/crossbean"
cp packaging/linux/crossbean.desktop "$STAGE/usr/share/applications/"
cp assets/icon.svg "$STAGE/usr/share/icons/hicolor/scalable/apps/crossbean.svg"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: crossbean
Version: $VERSION
Section: editors
Priority: optional
Architecture: $ARCH
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Maintainer: crossbean contributors
Description: Local-first notes with an AI-powered knowledge graph
 Markdown notes stored in a vector database (sqlite-vec). Connections
 between notes are made by hand with wikilinks or discovered automatically
 via embedding cosine similarity, and drawn as an interactive graph.
EOF

dpkg-deb --build --root-owner-group "$STAGE" "dist/crossbean_${VERSION}_${ARCH}.deb"
rm -rf "$STAGE"
echo "built dist/crossbean_${VERSION}_${ARCH}.deb"
