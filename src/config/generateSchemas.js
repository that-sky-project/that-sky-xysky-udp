import { writeFileSync } from 'node:fs';
import { z } from 'zod/v4';
import { configSchema, debugFileSchema } from './schema.js';

// Native Zod conversion keeps object strictness, defaults, bounds and descriptions
// synchronized. URL superRefine checks remain authoritative at runtime and are
// explained in the emitted descriptions (JSON Schema cannot serialize callbacks).
for (const [schema, name] of [[configSchema, 'config.schema.json'], [debugFileSchema, 'debug.schema.json']]) {
  const target = new URL(`../../${name}`, import.meta.url);
  writeFileSync(target, `${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2)}\n`);
  console.log(`Generated ${target.pathname}`);
}
