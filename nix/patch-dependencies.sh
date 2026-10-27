# Lifecycle scripts are disabled to prevent sandboxed downloads. Apply only
# Paseo's dependency patches before building either web renderer.
npm run postinstall

# Metro consumes the source entry; other consumers use the compiled entries.
# A missing provider causes React error #130 when opening isolated sheets.
for entry in src/index.ts lib/module/index.js lib/commonjs/index.js; do
  if ! grep -q 'BottomSheetModalInternalProvider' "node_modules/@gorhom/bottom-sheet/$entry"; then
    echo "Paseo: missing patched BottomSheetModalInternalProvider in $entry" >&2
    exit 1
  fi
done
