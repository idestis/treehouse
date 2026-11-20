#!/bin/sh
# Build Tauri bundle icons from the full-bleed 1024 px artwork in brand/icon.
#   macOS (.icns + PNGs): padded onto Apple's icon grid (824/1024 rounded square,
#     soft shadow) so it matches other apps in the Dock and ⌘Tab.
#   Windows (.ico, Square*Logo): the full-bleed artwork, which reads better at 16-32 px.
set -eu
SRC="${1:-brand/icon/AppIcon.appiconset/icon-512@2x.png}"
OUT="${2:-desktop/src-tauri/icons}"
# Mark size inside the tile (1 = as drawn in the artwork).
MARK_SCALE="${MARK_SCALE:-0.9}"

# Windows first: tauri icon writes every format, the macOS ones are replaced below.
npm --prefix desktop exec tauri -- icon "$PWD/$SRC" -o "$PWD/$OUT" >/dev/null
rm -rf "$OUT/android" "$OUT/ios"

dir=$(mktemp -d)
set_="$dir/AppIcon.iconset"
mkdir -p "$set_"
swift scripts/pad-icon.swift "$SRC" "$dir/1024.png" 1024 "$MARK_SCALE"
for s in 16 32 64 128 256 512 1024; do
  sips -z $s $s "$dir/1024.png" --out "$dir/$s.png" >/dev/null
done
for s in 16 32 128 256 512; do
  cp "$dir/$s.png" "$set_/icon_${s}x${s}.png"
  cp "$dir/$((s * 2)).png" "$set_/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_" -o "$OUT/icon.icns"
cp "$dir/32.png" "$OUT/32x32.png"
cp "$dir/64.png" "$OUT/64x64.png"
cp "$dir/128.png" "$OUT/128x128.png"
cp "$dir/256.png" "$OUT/128x128@2x.png"
cp "$dir/1024.png" "$OUT/icon.png"
rm -rf "$dir"
echo "icons → $OUT"
