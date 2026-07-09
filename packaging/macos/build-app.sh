#!/usr/bin/env bash
# Builds dist/Crossbean.app and dist/crossbean-macos-<arch>.dmg from
# dist/crossbean-macos-<arch>/. Run on macOS after: bun run scripts/build-release.ts
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${VERSION:-0.1.0}"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
DIST="dist/crossbean-macos-$ARCH"
APP="dist/Crossbean.app"

[ -d "$DIST" ] || { echo "missing $DIST — run: bun run scripts/build-release.ts"; exit 1; }

rm -rf "$APP"
# Resources (ui/, dylibs) live next to the binary in Contents/MacOS — that is
# where the app resolves resourceDir (dirname of the executable).
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -r "$DIST"/. "$APP/Contents/MacOS/"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Crossbean</string>
  <key>CFBundleDisplayName</key><string>Crossbean</string>
  <key>CFBundleIdentifier</key><string>app.crossbean</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>crossbean</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
EOF

# Icon: generate .icns from assets/icon.svg if the toolchain is available.
if command -v sips >/dev/null && command -v iconutil >/dev/null && command -v qlmanage >/dev/null; then
  ICONSET="dist/icon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  qlmanage -t -s 1024 -o dist assets/icon.svg >/dev/null 2>&1 || true
  if [ -f dist/icon.svg.png ]; then
    for s in 16 32 64 128 256 512; do
      sips -z $s $s dist/icon.svg.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s*2)) $((s*2)) dist/icon.svg.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/crossbean.icns"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string crossbean" "$APP/Contents/Info.plist"
    rm -rf "$ICONSET" dist/icon.svg.png
  fi
fi

# Ad-hoc sign so Gatekeeper allows local running (release builds should use a
# real Developer ID + notarization).
codesign --force --deep -s - "$APP" 2>/dev/null || true

DMG="dist/crossbean-macos-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname Crossbean -srcfolder "$APP" -ov -format UDZO "$DMG"
echo "built $DMG"
