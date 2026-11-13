import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema } from '../src/config/schema.js';
import { createCli } from '../src/config/cli.js';

const documents = ['README.md', 'README_zh.md'].map(name => ({
  name,
  text: readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
}));

function defaultTable(text) {
  return Object.fromEntries([...text.matchAll(/^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|\s*`([^`]*)`\s*\|/gmu)]
    .map(([, key, value]) => [key, value]));
}

test('both README default tables match the authoritative configuration schema', () => {
  const defaults = configSchema.parse({});
  const expected = Object.fromEntries(Object.entries(defaults).flatMap(([section, values]) =>
    Object.entries(values).map(([key, value]) => [`${section}.${key}`, value === '' ? '""' : String(value)])));
  for (const { name, text } of documents) {
    assert.deepEqual(defaultTable(text), expected, `${name} must document every schema default`);
  }
});

test('both READMEs document every public CLI option', () => {
  for (const { name, text } of documents) {
    for (const option of createCli().options) {
      assert.ok(text.includes(option.long), `${name} is missing ${option.long}`);
    }
  }
});
