/**
 * @fileoverview Tests for `shapeMessage`, the one normalizer behind
 * `ntfy_fetch_messages` rows and `ntfy://{topic}` rows: the body cap counted in
 * UTF-16 code units, which backs off a code unit rather than split a surrogate
 * pair, and the opt-out that returns a body whole.
 * @module tests/services/ntfy/message-shape
 */

import { describe, expect, it } from 'vitest';

import { MESSAGE_TRUNCATE_AT, shapeMessage } from '@/services/ntfy/message-shape.js';
import type { NtfyMessage } from '@/services/ntfy/types.js';

/** A `message` envelope as ntfy polls it; `extra` overrides or adds fields. */
function row(extra: Partial<NtfyMessage> = {}): NtfyMessage {
  return { id: 'm1', time: 1_700_000_000, event: 'message', topic: 'alerts', ...extra };
}

/** U+1F680 ROCKET — two UTF-16 code units, `🚀`. */
const ROCKET = '🚀';

describe('shapeMessage body cap', () => {
  it('caps at 500 code units', () => {
    expect(MESSAGE_TRUNCATE_AT).toBe(500);
  });

  it('cuts an ASCII body at the cap and counts the dropped code units', () => {
    const shaped = shapeMessage(row({ message: 'a'.repeat(700) }));
    expect(shaped.message).toBe('a'.repeat(500));
    expect(shaped.messageTruncated).toBe(200);
  });

  it('returns a body exactly at the cap whole, with no count', () => {
    const shaped = shapeMessage(row({ message: 'a'.repeat(500) }));
    expect(shaped.message).toBe('a'.repeat(500));
    expect(shaped.messageTruncated).toBeUndefined();
  });

  it('returns a long body whole, with no count, when truncation is skipped', () => {
    const body = `${'a'.repeat(499)}${ROCKET}${'b'.repeat(20)}`;
    const shaped = shapeMessage(row({ message: body }), { truncateBody: false });
    expect(shaped.message).toBe(body);
    expect(shaped.messageTruncated).toBeUndefined();
  });

  it('leaves a row with no body without one', () => {
    const shaped = shapeMessage(row({ event: 'message_delete' }));
    expect(shaped.message).toBeUndefined();
    expect(shaped.messageTruncated).toBeUndefined();
  });

  it.each([
    {
      name: 'a surrogate pair the cut would split keeps 499 units and counts the pair as dropped',
      body: `${'a'.repeat(499)}${ROCKET}${'b'.repeat(20)}`,
      kept: 'a'.repeat(499),
      dropped: 22,
    },
    {
      name: 'a surrogate pair ending exactly at the cap stays whole',
      body: `${'a'.repeat(498)}${ROCKET}${'b'.repeat(20)}`,
      kept: `${'a'.repeat(498)}${ROCKET}`,
      dropped: 20,
    },
    {
      name: 'a surrogate pair starting right after the cap is dropped whole',
      body: `${'a'.repeat(500)}${ROCKET}${'b'.repeat(20)}`,
      kept: 'a'.repeat(500),
      dropped: 22,
    },
    {
      name: 'consecutive astral characters across the cut back off by one unit only',
      // `a` first, so every pair starts on an odd index and one straddles the cut.
      body: `a${ROCKET.repeat(300)}`,
      kept: `a${ROCKET.repeat(249)}`,
      dropped: 102,
    },
  ])('$name', ({ body, kept, dropped }) => {
    const shaped = shapeMessage(row({ message: body }));
    expect(shaped.message).toBe(kept);
    expect(shaped.messageTruncated).toBe(dropped);
    expect(shaped.message?.isWellFormed()).toBe(true);
    // The count is in the same unit as `message.length`, so the two add back up.
    expect((shaped.message?.length ?? 0) + (shaped.messageTruncated ?? 0)).toBe(body.length);
  });

  it('keeps a cut that already falls on a code-point boundary, even after a lone surrogate', () => {
    // A high surrogate with no low half is a code point of its own; cutting after it splits nothing.
    const body = `${'a'.repeat(499)}\uD83D${'b'.repeat(20)}`;
    const shaped = shapeMessage(row({ message: body }));
    expect(shaped.message).toBe(`${'a'.repeat(499)}\uD83D`);
    expect(shaped.messageTruncated).toBe(20);
  });
});

describe('shapeMessage carries ntfy fields through (#49)', () => {
  /** A row as ntfy.sh polled it, with an icon and an action carrying ntfy's own `id`. */
  const POLLED = row({
    id: 'Z4MeYFR5eSYs',
    time: 1_794_636_448,
    title: 'icon raw',
    message: 'icon probe raw',
    click: 'https://example.com/click',
    icon: 'https://example.com/icon.png',
    actions: [
      {
        id: 'DAaFWDY6Vc',
        action: 'view',
        label: 'Open',
        clear: false,
        url: 'https://example.com/view',
      },
    ],
  });

  it('copies `icon` and each action `id` exactly as ntfy sent them', () => {
    const shaped = shapeMessage(POLLED);
    expect(shaped.icon).toBe('https://example.com/icon.png');
    expect(shaped.actions).toEqual([
      {
        id: 'DAaFWDY6Vc',
        action: 'view',
        label: 'Open',
        clear: false,
        url: 'https://example.com/view',
      },
    ]);
  });

  it('copies `encoding: "base64"`, leaving the base64 body as ntfy sent it', () => {
    const shaped = shapeMessage(row({ message: 'AAECAwQ=', encoding: 'base64' }));
    expect(shaped).toMatchObject({ message: 'AAECAwQ=', encoding: 'base64' });
  });

  it('leaves `icon`, `encoding`, and `scheduled` absent when nothing sets them (sparse row)', () => {
    const serialized = JSON.parse(JSON.stringify(shapeMessage(row({ message: 'plain' }))));
    expect(serialized).toEqual({
      id: 'm1',
      time: '2023-11-14T22:13:20.000Z',
      event: 'message',
      topic: 'alerts',
      message: 'plain',
    });
  });
});

describe('shapeMessage marks rows still queued for delivery (#51)', () => {
  /** ntfy's `Date` on a `scheduled=1` poll of ntfy.sh: Sat, 14 Nov 2026 06:08:39 GMT. */
  const NTFY_NOW = 1_794_636_519;

  it.each([
    { name: 'a row due after the clock is marked', time: NTFY_NOW + 14, scheduled: true },
    { name: 'a row due exactly at the clock is not', time: NTFY_NOW, scheduled: undefined },
    { name: 'a row due before the clock is not', time: NTFY_NOW - 73, scheduled: undefined },
  ])('$name', ({ time, scheduled }) => {
    const shaped = shapeMessage(row({ time, message: 'reminder' }), {
      scheduledAsOfSeconds: NTFY_NOW,
    });
    expect(shaped.scheduled).toBe(scheduled);
    // `time` stays the delivery time either way.
    expect(shaped.time).toBe(new Date(time * 1000).toISOString());
  });

  it('marks nothing when no clock is given, however late the row', () => {
    const shaped = shapeMessage(row({ time: NTFY_NOW + 3600, message: 'reminder' }));
    expect(shaped.scheduled).toBeUndefined();
  });
});
