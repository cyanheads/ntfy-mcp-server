---
name: ntfy-guide
description: Gates and identifier rules for the ntfy_* tools — choosing the topic, carrying one sequence id through a notification's updates, clear, and delete, scheduling, moving, and cancelling reminders, and reading fetched topic history without miscounting. Use when sending, updating, dismissing, or checking push notifications with ntfy_publish_message, ntfy_fetch_messages, or ntfy_manage_message.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

ntfy pushes notifications to the phones and desktops subscribed to a topic. Use it to reach the user outside the chat: a long task finished or failed, a checkpoint, a reminder at a set time. Use `ntfy_fetch_messages` (or the `ntfy://{topic}` snapshot) to look back at what a topic received.

- The server watches nothing. "Notify me when the build finishes" means you publish when the work you are running ends.
- Fetching polls the server's message cache. It is not a subscription: you cannot wait for a reply, and a tapped action button reports nothing back here.
- Only cached messages can be fetched. ntfy.sh keeps them about 12 hours; a self-hosted server sets its own window. An empty result for an older period does not mean nothing was sent.
- Leave `base_url` out to use the configured server. Credentials go only to a URL that matches a configured server (a trailing `/` aside), so another spelling of the same host (`localhost` for `127.0.0.1`, an uppercase scheme) is sent without them.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| Topic | The user, who must be subscribed to it, or the server's configured default | Every tool; fetch also takes a comma-separated list |
| Message `id` | The publish result; each fetch row | Fetch's `id` filter (full body) or `since` (only messages after it) |
| Sequence id | The `id` of the notification's first message, or a name you chose on that first publish | `sequence_id` on every update, and on clear or delete |
| `event_id` | The clear or delete result | Nothing. It names the event, not the notification |

A notification keeps one sequence id for its whole life:

- Each update gets a new `id` of its own. To update again, or to clear or delete, pass the original sequence id, never the latest result's `id`. A new `id` passed as `sequence_id` starts a separate notification, and the phone shows two.
- In a fetch row, the sequence id is the row's `sequence_id` when present, else its `id`. Rows whose `event` is `message_clear` or `message_delete` point at a sequence through their `sequence_id`; their own `id` targets nothing.
- Easiest: choose the sequence id yourself on the first publish (`build-1234`, `deploy-api`; letters, digits, `-` and `_`, up to 64 characters) and reuse it. Nothing needs capturing from the result.

## Gates

1. **Never invent a topic.** If the user named none, publish without `topic` so the configured default applies. If that fails because no default is configured, ask the user which topic their app subscribes to. ntfy accepts any topic name and reports the publish as sent whether or not anyone is subscribed, so a guessed or mistyped topic fails silently. The topic works as a password: keep it out of commits, issues, logs, and anything else you write that others can read.
2. **Confirm the sequence id before a clear or delete.** ntfy.sh accepts any `sequence_id`, including one never published, and reports success. A wrong id dismisses nothing and raises no error. Take the id from a publish result in this conversation or from a fetch row, per Identifiers.
3. **An update replaces the notification; it does not merge into it.** Resend every field the notification should keep (title, tags, priority, click URL, buttons). The update carries only what that call sets.
4. **The publish result is the receipt.** A successful publish means the server accepted the message. A fetch made right after it can come back empty for a few seconds before the message shows up. That is not a lost message or a wrong topic, and resending delivers a duplicate. Fetch to confirm only when a publish failed in a way that says it may have gone out, and wait a few seconds first.
5. **Prompted actions need a client that can prompt.** A clear, a delete, or a publish that sends email, places a call, or carries a broadcast or `http` button asks the user to confirm through the client. A failure saying the client did not declare the elicitation capability (`client_capability_missing`, or JSON-RPC error `-32021` with `requiredCapabilities`) means this client cannot show that prompt. Tell the user the action is unavailable here and don't retry it. A plain notification, a `view` or `copy` button, and a `click` URL never prompt.
6. **Every update counts against the quota.** Each update, clear, and delete is a message against the server's daily per-visitor limit, which is low on public ntfy.sh. Update a progress notification at milestones, not on every step.

## Workflows

**Task finished, then mark it done.** When the work ends, publish with a sequence id you chose. When the user says it's handled, clear that sequence id.

**Progress notification.** Publish the first state with a chosen sequence id. At each milestone, publish again with the same sequence id and the full field set (Gate 3). Finish with a final update or a clear.

**Reminders.** Publish with `delay` and a chosen sequence id.

- Move it: publish again with the same sequence id and the new `delay` while the first is still pending. The pending one is replaced rather than joined by a second reminder. Give a reschedule a few seconds after the publish it replaces; two sent back to back can both stay queued.
- Cancel it: delete that sequence id before it fires. It is removed and never delivered.
- Check what is queued: pending reminders appear in a fetch only with `scheduled: true`.

**What arrived on a topic.** Fetch with a `since` that covers the period. For "since this morning", use that moment as a Unix timestamp in seconds. Durations stop at hours (`24h`, not `1d`). One call returns at most `limit` rows (20 by default, 100 at most); while a result has `truncated: true`, call again with `cursor` set to its `nextCursor`, keeping `topic` and `since` the same. Then reduce all the rows:

1. Set aside `message_clear` and `message_delete` rows. Each one means the notification named by its `sequence_id` was dismissed or removed. A clear or delete with no message row in the window points at a notification sent before the window, or a reminder cancelled before it fired.
2. Group the remaining rows by sequence id and report each notification's latest row once, not every intermediate update.
3. Note which notifications were later cleared or deleted.

If the period reaches past the cache window, say so rather than reporting the topic as quiet.

**Clearing one you didn't just send.** Fetch with `since: all`, paging with `cursor` as above until `truncated` is false, to read the whole cache; find the notification by title or body, take its sequence id per Identifiers, then clear or delete it. If it has left the cache and its sequence id isn't already in this conversation, it cannot be targeted. Tell the user.
