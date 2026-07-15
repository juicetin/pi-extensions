import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  AuditStoreError,
  SqliteAuditStore,
  decodeAuditEventInput,
  type AuditEventInput,
} from "./audit.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    streamId: "slice-1",
    eventType: "advisory_assessed",
    occurredAt: "2026-07-15T10:00:00Z",
    actorId: "session-1",
    correlationId: "correlation-1",
    causationId: "command-1",
    payloadRef: "guardian:event-payload-1",
    payloadHash: HASH_A,
    privacyFilterRef: "privacy-filter:v1",
    ...overrides,
  };
}

function withStore(run: (store: SqliteAuditStore, file: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "guardian-audit-"));
  const file = path.join(directory, "audit.sqlite");
  const store = new SqliteAuditStore(file);
  try {
    run(store, file);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectStoreError(action: () => unknown, code: AuditStoreError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AuditStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test("required appends form a deterministic verified hash chain", () => withStore((store) => {
  assert.equal(store.journalMode(), "wal");
  const first = store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] });
  assert.equal(first.previousEventHash, null);
  assert.match(first.eventHash, /^[a-f0-9]{64}$/);

  const second = store.appendRequired({
    event: event({ eventId: "event-2", occurredAt: "2026-07-15T10:01:00Z", payloadHash: HASH_B }),
    expectedPreviousEventHash: first.eventHash,
    uniquenessKeys: [],
  });
  assert.equal(second.previousEventHash, first.eventHash);
  assert.notEqual(second.eventHash, first.eventHash);
  assert.deepEqual(store.readStream("slice-1"), [first, second]);

  const compact = store.renderCompactEvidenceIndex("slice-1");
  assert.deepEqual(compact, [
    { eventId: "event-1", eventType: "advisory_assessed", occurredAt: "2026-07-15T10:00:00Z", payloadRef: "guardian:event-payload-1", payloadHash: HASH_A, eventHash: first.eventHash },
    { eventId: "event-2", eventType: "advisory_assessed", occurredAt: "2026-07-15T10:01:00Z", payloadRef: "guardian:event-payload-1", payloadHash: HASH_B, eventHash: second.eventHash },
  ]);
  assert.equal(JSON.stringify(compact).includes("session-1"), false);
}));

test("compare-and-append rejects stale heads without changing the stream", () => withStore((store) => {
  const first = store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] });
  expectStoreError(
    () => store.appendRequired({ event: event({ eventId: "event-2" }), expectedPreviousEventHash: null, uniquenessKeys: [] }),
    "conflict",
  );
  assert.deepEqual(store.readStream("slice-1"), [first]);
}));

test("event IDs and one-use keys are consumed atomically", () => withStore((store) => {
  const first = store.appendRequired({
    event: event({ eventType: "sensitive_action_consumed" }),
    expectedPreviousEventHash: null,
    uniquenessKeys: [
      { namespace: "authorization", key: "authorization-1" },
      { namespace: "nonce", key: "nonce-1" },
    ],
  });
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: first.eventHash, uniquenessKeys: [] }),
    "duplicate_event",
  );
  expectStoreError(
    () => store.appendRequired({
      event: event({ eventId: "event-2" }),
      expectedPreviousEventHash: first.eventHash,
      uniquenessKeys: [{ namespace: "nonce", key: "nonce-1" }],
    }),
    "uniqueness_conflict",
  );
  assert.deepEqual(store.readStream("slice-1"), [first]);
}));

test("advisory append success and failure preserve the mutation envelope", () => withStore((store) => {
  const mutation = Object.freeze({ operation: "edit", count: 1, exitCode: 0 });
  const persisted = store.appendAdvisory({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] }, mutation);
  assert.equal(persisted.status, "persisted");
  assert.equal(persisted.mutation, mutation);
  assert.equal(persisted.mutationEffect, "unchanged");

  store.close();
  const result = store.appendAdvisory({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] }, mutation);
  assert.equal(result.status, "non_persisted");
  assert.equal(result.code, "store_unavailable");
  assert.equal(result.mutationEffect, "unchanged");
  assert.equal(result.mutation, mutation);
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] }),
    "store_unavailable",
  );
}));

test("strict event decoding excludes raw payloads and malformed identity", () => {
  assert.deepEqual(decodeAuditEventInput(event()), event());
  assert.doesNotThrow(() => decodeAuditEventInput(event({ occurredAt: "2028-02-29T00:00:00Z" })));
  assert.throws(() => decodeAuditEventInput({ ...event(), payload: { secret: "raw" } }));
  assert.throws(() => decodeAuditEventInput({ ...event(), schemaVersion: 2 }));
  assert.throws(() => decodeAuditEventInput({ ...event(), payloadHash: "not-a-hash" }));
  assert.throws(() => decodeAuditEventInput({ ...event(), occurredAt: "2026-02-31T00:00:00Z" }));
  assert.throws(() => decodeAuditEventInput({ ...event(), payloadRef: "contains spaces" }));
  assert.throws(
    () => decodeAuditEventInput({ schemaVersion: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof AuditStoreError);
      assert.equal(error.details.length, 5);
      assert.ok(error.details.every((detail) => detail.startsWith("/") && detail.includes(":")));
      return true;
    },
  );
});

test("append validates stream heads, uniqueness keys, stream IDs, and storage errors", () => withStore((store) => {
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: "short", uniquenessKeys: [] }),
    "conflict",
  );
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: `${HASH_A}suffix`, uniquenessKeys: [] }),
    "conflict",
  );
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: `prefix${HASH_A}`, uniquenessKeys: [] }),
    "conflict",
  );
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [{ namespace: "bad space", key: "x" }] }),
    "invalid_uniqueness_key",
  );
  expectStoreError(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [{ namespace: "nonce", key: "x" }, { namespace: "nonce", key: "x" }] }),
    "invalid_uniqueness_key",
  );
  expectStoreError(() => store.readStream("bad stream"), "invalid_event");

  const database = (store as unknown as { database: Database.Database }).database;
  Object.defineProperty(database, "transaction", { value: () => { throw new Error("injected storage failure"); } });
  assert.throws(
    () => store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AuditStoreError);
      assert.equal(error.code, "storage_failure");
      assert.deepEqual(error.details, []);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
}));

test("read detects persisted hash and chain-link corruption", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "guardian-audit-corrupt-"));
  const file = path.join(directory, "audit.sqlite");
  const store = new SqliteAuditStore(file);
  store.appendRequired({ event: event(), expectedPreviousEventHash: null, uniquenessKeys: [] });
  store.close();

  const database = new Database(file);
  database.prepare("UPDATE audit_events SET event_hash = ? WHERE event_id = ?").run(HASH_B, "event-1");
  database.close();

  let reopened = new SqliteAuditStore(file);
  expectStoreError(() => reopened.readStream("slice-1"), "corrupt_stream");
  reopened.close();

  const repair = new Database(file);
  const linkedHash = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    eventId: "event-1",
    streamId: "slice-1",
    eventType: "advisory_assessed",
    occurredAt: "2026-07-15T10:00:00Z",
    actorId: "session-1",
    correlationId: "correlation-1",
    causationId: "command-1",
    payloadRef: "guardian:event-payload-1",
    payloadHash: HASH_A,
    privacyFilterRef: "privacy-filter:v1",
    previousEventHash: HASH_B,
  })).digest("hex");
  repair.prepare("UPDATE audit_events SET event_hash = ?, previous_event_hash = ? WHERE event_id = ?").run(linkedHash, HASH_B, "event-1");
  repair.close();
  reopened = new SqliteAuditStore(file);
  try {
    expectStoreError(() => reopened.readStream("slice-1"), "corrupt_stream");
    reopened.close();
    assert.doesNotThrow(() => reopened.close());
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
