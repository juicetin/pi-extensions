const mutateSchemaStrings = process.env.GUARDIAN_MUTATE_SCHEMA_STRINGS === "1"

export default {
  mutate: ["incremental-delivery-guardian/config.ts"],
  mutator: mutateSchemaStrings ? {} : {
    excludedMutations: ["StringLiteral"],
  },
  testRunner: "command",
  commandRunner: {
    command: "node --experimental-strip-types --test incremental-delivery-guardian/index.test.ts",
  },
  coverageAnalysis: "off",
  reporters: ["clear-text"],
  thresholds: {
    high: 90,
    low: 90,
    break: 90,
  },
  concurrency: 2,
  timeoutMS: 10000,
}
