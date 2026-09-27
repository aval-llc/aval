#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
DESKTOP_DIR="${SCRIPT_DIR:h}"
PROJECT_DIR="${DESKTOP_DIR:h}"
SOURCE_APP="${AVAL_ELECTRON_SOURCE_APP:-/Applications/Granola.app}"
OUTPUT_DIR="${DESKTOP_DIR}/dist"
APP_OUTPUT="${OUTPUT_DIR}/Aval.app"
APP_VERSION="$(/usr/bin/plutil -extract version raw "${DESKTOP_DIR}/package.json")"
DMG_OUTPUT="${OUTPUT_DIR}/Aval-${APP_VERSION}-arm64.dmg"
WORK_DIR="$(/usr/bin/mktemp -d /private/tmp/aval-offline-package.XXXXXX)"
STAGED_APP="${WORK_DIR}/Aval.app"
APP_SOURCE="${WORK_DIR}/app-source"
MOUNT_DIR="/Volumes/Aval"
BACKGROUND_1X="${DESKTOP_DIR}/assets/dmg-background.png"
BACKGROUND_2X="${DESKTOP_DIR}/assets/dmg-background@2x.png"
FINDER_LAYOUT_SCRIPT="${SCRIPT_DIR}/configure-dmg.applescript"
ASAR_PACKER="${SCRIPT_DIR}/create-asar.cjs"
MOUNT_ATTACHED=0

cleanup() {
  if (( MOUNT_ATTACHED )); then
    /usr/bin/hdiutil detach "${MOUNT_DIR}" -force >/dev/null 2>&1 || true
  fi
  /bin/rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

if [[ ! -d "${SOURCE_APP}/Contents/Frameworks/Electron Framework.framework" ]]; then
  print -u2 "No reusable Electron runtime found at ${SOURCE_APP}."
  print -u2 "Set AVAL_ELECTRON_SOURCE_APP to an installed Electron 44 application."
  exit 1
fi

for REQUIRED_ASSET in "${BACKGROUND_1X}" "${BACKGROUND_2X}" "${FINDER_LAYOUT_SCRIPT}" "${ASAR_PACKER}"; do
  if [[ ! -f "${REQUIRED_ASSET}" ]]; then
    print -u2 "Missing DMG packaging asset: ${REQUIRED_ASSET}"
    exit 1
  fi
done

if /usr/bin/hdiutil info | /usr/bin/grep -E '/Volumes/Aval([[:space:]][0-9]+)?([[:space:]]|$)' >/dev/null; then
  print -u2 "An Aval disk image is already mounted. Eject it before packaging."
  exit 1
fi

RUNTIME_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${SOURCE_APP}/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist")"
if [[ "${RUNTIME_VERSION}" != 44.* ]]; then
  print -u2 "Aval requires an Electron 44 runtime for this offline build; found ${RUNTIME_VERSION}."
  exit 1
fi

/bin/mkdir -p "${STAGED_APP}/Contents/MacOS" "${STAGED_APP}/Contents/Resources" "${APP_SOURCE}"
/usr/bin/ditto "${SOURCE_APP}/Contents/Frameworks" "${STAGED_APP}/Contents/Frameworks"
/bin/cp "${SOURCE_APP}/Contents/MacOS/Granola" "${STAGED_APP}/Contents/MacOS/Aval"
/bin/cp "${SOURCE_APP}/Contents/Info.plist" "${STAGED_APP}/Contents/Info.plist"
/bin/cp "${SOURCE_APP}/Contents/PkgInfo" "${STAGED_APP}/Contents/PkgInfo"

for ROLE in "" " (GPU)" " (Plugin)" " (Renderer)"; do
  OLD_APP="${STAGED_APP}/Contents/Frameworks/Granola Helper${ROLE}.app"
  NEW_APP="${STAGED_APP}/Contents/Frameworks/Aval Helper${ROLE}.app"
  /bin/mv "${OLD_APP}" "${NEW_APP}"
  /bin/mv "${NEW_APP}/Contents/MacOS/Granola Helper${ROLE}" "${NEW_APP}/Contents/MacOS/Aval Helper${ROLE}"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Aval Helper${ROLE}" "${NEW_APP}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Aval Helper${ROLE}" "${NEW_APP}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.evalxnder.aval.helper${ROLE//[ ()]/}" "${NEW_APP}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_VERSION}" "${NEW_APP}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "${NEW_APP}/Contents/Info.plist" 2>/dev/null || true
done

PLIST="${STAGED_APP}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Aval' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable Aval' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.evalxnder.aval' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Aval' "${PLIST}"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "${PLIST}"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_VERSION}" "${PLIST}"
/usr/libexec/PlistBuddy -c 'Set :LSApplicationCategoryType public.app-category.business' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Set :NSHumanReadableCopyright Copyright © 2026 Aval' "${PLIST}"
for KEY in CFBundleIconName CFBundleURLTypes ElectronAsarIntegrity GranolaManagedUpdateHandshakeVersion NSAppTransportSecurity NSAudioCaptureUsageDescription NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription NSCalendarsUsageDescription NSCameraUsageDescription NSContactsUsageDescription NSDockTilePlugIn NSMicrophoneUsageDescription NSScreenCaptureUsageDescription NSSystemExtensionUsageDescription; do
  /usr/libexec/PlistBuddy -c "Delete :${KEY}" "${PLIST}" 2>/dev/null || true
done

/bin/cp "${DESKTOP_DIR}/main.cjs" "${DESKTOP_DIR}/preload.cjs" "${DESKTOP_DIR}/codex-app-server.cjs" "${DESKTOP_DIR}/inference.cjs" "${DESKTOP_DIR}/chat-window.cjs" "${DESKTOP_DIR}/package.json" "${APP_SOURCE}/"
ASAR_HASH="$(node "${ASAR_PACKER}" "${APP_SOURCE}" "${STAGED_APP}/Contents/Resources/app.asar")"
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity dict' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity:Resources/app.asar dict' "${PLIST}"
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256' "${PLIST}"
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${ASAR_HASH}" "${PLIST}"
/bin/cp "${DESKTOP_DIR}/ELECTRON-LICENSE.txt" "${STAGED_APP}/Contents/Resources/"
if [[ -f /Applications/Cursor.app/Contents/Resources/LICENSES.chromium.html ]]; then
  /bin/cp /Applications/Cursor.app/Contents/Resources/LICENSES.chromium.html "${STAGED_APP}/Contents/Resources/"
fi

/usr/bin/sips -s format icns "${PROJECT_DIR}/public/icon-512.png" --out "${STAGED_APP}/Contents/Resources/icon.icns" >/dev/null

# Keep this development artifact compact and native to the current Apple
# silicon Mac. The normal electron-builder path remains the release route.
find "${STAGED_APP}" -type f -print0 | while IFS= read -r -d '' FILE_PATH; do
  if /usr/bin/file "${FILE_PATH}" | /usr/bin/grep -q 'universal binary'; then
    MODE="$(/usr/bin/stat -f '%Lp' "${FILE_PATH}")"
    /usr/bin/lipo "${FILE_PATH}" -thin arm64 -output "${FILE_PATH}.arm64"
    /bin/chmod "${MODE}" "${FILE_PATH}.arm64"
    /bin/mv "${FILE_PATH}.arm64" "${FILE_PATH}"
  fi
done
/bin/rm -f "${STAGED_APP}/Contents/Frameworks/Electron Framework.framework/Resources/v8_context_snapshot.x86_64.bin"

find "${STAGED_APP}" -name _CodeSignature -type d -prune -exec /bin/rm -rf -- {} +
/usr/bin/xattr -cr "${STAGED_APP}"
/usr/bin/codesign --force --deep --sign - --timestamp=none "${STAGED_APP}"
/usr/bin/codesign --verify --deep --strict --verbose=2 "${STAGED_APP}"
AVAL_DESKTOP_SMOKE_TEST=1 "${STAGED_APP}/Contents/MacOS/Aval"

/bin/mkdir -p "${OUTPUT_DIR}"
if [[ -e "${APP_OUTPUT}" ]]; then /bin/rm -rf -- "${APP_OUTPUT}"; fi
if [[ -e "${DMG_OUTPUT}" ]]; then /bin/rm -f -- "${DMG_OUTPUT}"; fi
/usr/bin/ditto "${STAGED_APP}" "${APP_OUTPUT}"

APP_SIZE_KB="$(/usr/bin/du -sk "${STAGED_APP}" | /usr/bin/awk '{print $1}')"
IMAGE_SIZE_KB="$(( APP_SIZE_KB + 131072 ))"
READ_WRITE_IMAGE="${WORK_DIR}/Aval-read-write.dmg"

/usr/bin/hdiutil create -size "${IMAGE_SIZE_KB}k" -fs HFS+ -volname Aval -type UDIF -ov "${READ_WRITE_IMAGE}"
/usr/bin/hdiutil attach -readwrite -noverify -noautoopen "${READ_WRITE_IMAGE}"
MOUNT_ATTACHED=1

if [[ ! -d "${MOUNT_DIR}" ]]; then
  print -u2 "Expected writable image at ${MOUNT_DIR}, but it was not mounted there."
  exit 1
fi

/usr/bin/ditto "${STAGED_APP}" "${MOUNT_DIR}/Aval.app"
/bin/ln -s /Applications "${MOUNT_DIR}/Applications"
/bin/mkdir -p "${MOUNT_DIR}/.background"
/bin/cp "${BACKGROUND_1X}" "${MOUNT_DIR}/.background/dmg-background.png"
/bin/cp "${BACKGROUND_2X}" "${MOUNT_DIR}/.background/dmg-background@2x.png"
/usr/bin/SetFile -a V "${MOUNT_DIR}/.background"

FINDER_DISK_READY=false
for ATTEMPT in 1 2 3 4 5 6 7 8 9 10; do
  if [[ "$(/usr/bin/osascript -e 'tell application "Finder" to exists disk "Aval"')" == "true" ]]; then
    FINDER_DISK_READY=true
    break
  fi
  /bin/sleep 1
done
if [[ "${FINDER_DISK_READY}" != "true" ]]; then
  print -u2 "Finder could not see the mounted Aval image."
  exit 1
fi

/usr/bin/osascript "${FINDER_LAYOUT_SCRIPT}" Aval
for ATTEMPT in 1 2 3 4 5; do
  [[ -f "${MOUNT_DIR}/.DS_Store" ]] && break
  /bin/sleep 1
done
if [[ ! -f "${MOUNT_DIR}/.DS_Store" ]]; then
  print -u2 "Finder did not write the DMG layout metadata."
  exit 1
fi

/usr/bin/stat -f 'Applications: %HT -> %Y' "${MOUNT_DIR}/Applications"
/usr/bin/codesign --verify --deep --strict --verbose=2 "${MOUNT_DIR}/Aval.app"
/bin/sync
/usr/bin/hdiutil detach "${MOUNT_DIR}"
MOUNT_ATTACHED=0

/usr/bin/hdiutil convert "${READ_WRITE_IMAGE}" -format UDZO -imagekey zlib-level=9 -o "${DMG_OUTPUT}"

/usr/bin/hdiutil verify "${DMG_OUTPUT}"

print "Created ${DMG_OUTPUT}"
print "Electron runtime ${RUNTIME_VERSION}; Apple silicon; ad-hoc signed development build."
