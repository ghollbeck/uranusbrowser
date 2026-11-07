#!/bin/bash
# Publish an existing release to explicitly selected GitHub and R2 destinations.
# Use only with your own release credentials. Old objects are not deleted here.
# Usage: publish-release.sh <Uranus-Browser-version[-x64].dmg> [appcast folder]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <Uranus-Browser-<version>[-x64].dmg> [<folder>]" >&2
  exit 1
fi
dmg="$1"
release="${ANUS_RELEASE_DIR:-$release_out/anus-release}"
folder="${2:-$release/appcast}"
bucket="${ANUS_R2_BUCKET:?set the target R2 bucket}"
repo="${ANUS_GITHUB_REPO:?set the target GitHub owner/repository}"
prefix="${ANUS_DOWNLOAD_URL_PREFIX:?set the HTTPS download prefix ending in /}"
[[ "$prefix" = https://*/ ]] || { echo "error: expected an HTTPS prefix ending in /" >&2; exit 1; }
name="$(basename "$dmg")"
stable="Uranus-Browser$release_suffix.dmg"
feed="$folder/$release_feed"
if [ ! -f "$folder/$name" ] || [ ! -f "$feed" ]; then
  echo "error: no $folder/$name or $feed; run make-appcast.sh $dmg first" >&2
  exit 1
fi

# The files a feed links to under the configured prefix, one per line: the dmg and its deltas.
listed() {
  grep -o "url=\"${prefix}[^\"]*\"" | sed -e "s|^url=\"$prefix||" -e 's|"$||' | sort -u
}
new="$(listed <"$feed")"
if ! grep -qx "$name" <<<"$new"; then
  echo "error: $feed does not link to $prefix$name" >&2
  exit 1
fi

# GitHub first: its releases are the archive of every version, so a release is never on
# R2 only. The release v<version> is made if it isn't there yet, from the commit
# checked out here (which must be pushed), with the notes next to the dmg
# (Uranus-Browser-<version>.md) if there are any.
version="${name#Uranus-Browser-}"
version="${version%"$release_suffix.dmg"}"
tag="v$version"
sha256="$(shasum -a 256 "$folder/$name" | cut -d' ' -f1)"
if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  commit="$(git -C "$here" rev-parse HEAD)"
  if [ -z "$(git -C "$here" branch -r --contains "$commit")" ]; then
    echo "error: $commit, to tag $tag on, is not pushed" >&2
    exit 1
  fi
  notes="$folder/Uranus-Browser-$version.md"
  echo "== GitHub release $tag on $commit"
  if [ -f "$notes" ]; then
    gh release create "$tag" --repo "$repo" --target "$commit" --title "Uranus Browser $version" --notes-file "$notes"
  else
    gh release create "$tag" --repo "$repo" --target "$commit" --title "Uranus Browser $version" --generate-notes
  fi
fi
digest="$(gh release view "$tag" --repo "$repo" --json assets --jq ".assets[] | select(.name == \"$name\") | .digest")"
if [ -z "$digest" ]; then
  echo "== GitHub release $tag: $name"
  gh release upload "$tag" --repo "$repo" "$folder/$name"
elif [ "$digest" != "sha256:$sha256" ]; then
  echo "error: release $tag already has a different $name ($digest)" >&2
  exit 1
fi

r2() {
  npx --yes wrangler@4 r2 object "$@" --remote
}
put() { # <file> <key> <content type> <cache control>
  echo "== put $bucket/$2"
  r2 put "$bucket/$2" --file "$1" --content-type "$3" --cache-control "$4"
}

# A versioned file never changes; the stable name and the feed change with every release.
while read -r key; do
  case "$key" in
    *.dmg) type=application/x-apple-diskimage ;;
    *) type=application/octet-stream ;;
  esac
  put "$folder/$key" "$key" "$type" "public, max-age=31536000, immutable"
done <<<"$new"
put "$folder/$name" "$stable" application/x-apple-diskimage "public, max-age=300"
put "$feed" "$release_feed" application/xml "public, max-age=300"

echo "Published $name to $repo and $prefix"
