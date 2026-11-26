import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// hermes-bot poller/messages.json at ebfbc9e, unchanged.
const hermes = read('./fixtures/hermes-poller-messages-ebfbc9e.json');
const bridge = read('../bakers-bridge/messages.json');

// The poller-only texts the spec drops (Q4): the heartbeat, the week-silent close and the reopened channel.
const DROPPED = ['stillWorking', 'abandoned', 'reopened'];

describe('fixed texts', () => {
  it.each(['de', 'en'])('%s keeps every Hermes text word for word, minus the dropped ones', (lang) => {
    const expected = Object.fromEntries(Object.entries(hermes[lang]).filter(([k]) => !DROPPED.includes(k)));
    expect(bridge[lang]).toEqual(expected);
  });
});
