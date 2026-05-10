# ntfy upstream docs — mirror

These files are a verbatim copy of the [`binwiederhier/ntfy`](https://github.com/binwiederhier/ntfy) docs, vendored for offline reference and to pin the API surface this MCP server targets.

## Pinned

| Field | Value |
|:------|:------|
| Repo | [`binwiederhier/ntfy`](https://github.com/binwiederhier/ntfy) |
| Commit | [`802c0a4c`](https://github.com/binwiederhier/ntfy/commit/802c0a4c303d76db911d5f83c17320651efdf84d) |
| Date | 2026-04-27 |
| Mirrored | 2026-05-08 |

## Files

| Path | Upstream | Purpose |
|:-----|:---------|:--------|
| `index.md` | `docs/index.md` | Overview |
| `publish.md` | `docs/publish.md` | HTTP publish API — params, headers, priority, tags, attachments, scheduling |
| `subscribe/api.md` | `docs/subscribe/api.md` | JSON / SSE subscribe API |
| `emojis.md` | `docs/emojis.md` | Tag → emoji reference (the `tags` param) |
| `examples.md` | `docs/examples.md` | Curl / HTTP usage examples |

## Refresh

```bash
SHA=$(curl -s https://api.github.com/repos/binwiederhier/ntfy/commits/main \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['sha'][:8])")
BASE="https://raw.githubusercontent.com/binwiederhier/ntfy/main/docs"
cd docs/ntfy
for f in index.md publish.md emojis.md examples.md subscribe/api.md; do
  curl -fsSLo "$f" "$BASE/$f"
done
echo "refreshed to $SHA — update SOURCES.md commit/date"
```

After refreshing, update the **Commit**, **Date**, and **Mirrored** rows above.
