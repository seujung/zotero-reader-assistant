#!/bin/sh
# Build the plugin into build/:
#   zotero-reader-assistant-<version>.xpi, zotero-reader-assistant.xpi, updates.json
#
# Environment:
#   REPOSITORY  GitHub "owner/name". Fills the update and homepage URLs.
#               Defaults to the "origin" git remote.
#   VERSION     Plugin version. Defaults to the version in src/manifest.json.
set -e
cd "$(dirname "$0")"

VERSION=${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src/manifest.json)}
ID=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' src/manifest.json)
if [ -z "$REPOSITORY" ]; then
	REPOSITORY=$(git remote get-url origin 2>/dev/null \
		| sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
fi
if [ -z "$REPOSITORY" ]; then
	echo "Set REPOSITORY=owner/name, or add a GitHub \"origin\" remote." >&2
	exit 1
fi

rm -rf build
mkdir -p build/stage
cp -R src/. build/stage/
sed -i.bak \
	-e "s#__REPOSITORY__#$REPOSITORY#g" \
	-e "s#\"version\": *\"[^\"]*\"#\"version\": \"$VERSION\"#" \
	build/stage/manifest.json
rm build/stage/manifest.json.bak

XPI="zotero-reader-assistant-$VERSION.xpi"
(cd build/stage && zip -r -q "../$XPI" . -x '*.DS_Store')
cp "build/$XPI" build/zotero-reader-assistant.xpi
rm -rf build/stage

cat > build/updates.json <<JSON
{
  "addons": {
    "$ID": {
      "updates": [
        {
          "version": "$VERSION",
          "update_link": "https://github.com/$REPOSITORY/releases/download/v$VERSION/$XPI",
          "applications": {
            "zotero": {
              "strict_min_version": "7.0"
            }
          }
        }
      ]
    }
  }
}
JSON

echo "Built build/$XPI for $REPOSITORY"
