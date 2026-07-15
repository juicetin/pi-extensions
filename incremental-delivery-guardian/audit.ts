import { createHash } from "node:crypto";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Database from "better-sqlite3";

import { GUARDIAN_SCHEMA_VERSION } from "./schemas.ts";

const Strict = { additionalProperties: false } as const;
const OpaqueReference = () => Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const Sha256 = () => Type.String({ pattern: "^[a-f0-9]{64}$" });
const Rfc3339 = () => Type.String({
  pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$",
});

export const AuditEventInputSchema = Type.Object({
  schemaVersion: Type.Literal(GUARDIAN_SCHEMA_VERSION),
  eventId: OpaqueReference(),
  streamId: OpaqueReference(),
  eventType: OpaqueReference(),
  occurredAt: Rfc3339(),
  actorId: OpaqueReference(),
  correlationId: OpaqueReference(),
  causationId: OpaqueReference(),
  payloadRef: OpaqueReference(),
  payloadHash: Sha256(),
  privacyFilterRef: OpaqueReference(),
}, Strict);
export type AuditEventInput = Static<typeof AuditEventInputSchema>;

export const AuditUniquenessKeySchema = Type.Object({
  namespace: OpaqueReference(),
  key: OpaqueReference(),
}, Strict);
export type AuditUniquenessKey = Static<typeof AuditUniquenessKeySchema>;

export interface PersistedAuditEvent extends AuditEventInput {
  readonly previousEventHash: string | null;
  readonly eventHash: string;
}
export interface AppendAuditInput {
  readonly event: AuditEventInput;
  readonly expectedPreviousEventHash: string | null;
  readonly uniquenessKeys: readonly AuditUniquenessKey[];
}
export interface CompactEvidenceReference {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadRef: string;
  readonly payloadHash: string;
  readonly eventHash: string;
}

export type AuditStoreErrorCode = "invalid_event" | "invalid_uniqueness_key" | "conflict" | "duplicate_event" | "uniqueness_conflict" | "corrupt_stream" | "store_unavailable" | "storage_failure";
export class AuditStoreError extends Error {
  readonly code: AuditStoreErrorCode;
  readonly details: readonly string[];
  constructor(code: AuditStoreErrorCode, message: string, details: readonly string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditStoreError";
    this.code = code;
    this.details = details;
  }
}

export type AdvisoryAppendResult<TMutation> = {
  readonly status: "persisted";
  readonly event: PersistedAuditEvent;
  readonly mutationEffect: "unchanged";
  readonly mutation: TMutation;
} | {
  readonly status: "non_persisted";
  readonly code: AuditStoreErrorCode;
  readonly mutationEffect: "unchanged";
  readonly mutation: TMutation;
};

interface AuditRow {
  event_id: string;
  stream_id: string;
  event_type: string;
  occurred_at: string;
  actor_id: string;
  correlation_id: string;
  causation_id: string;
  payload_ref: string;
  payload_hash: string;
  privacy_filter_ref: string;
  previous_event_hash: string | null;
  event_hash: string;
}

function hasValidRfc3339CalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function decodeAuditEventInput(input: unknown): AuditEventInput {
  if (!Value.Check(AuditEventInputSchema, input)) {
    const details = [...Value.Errors(AuditEventInputSchema, input)].slice(0, 5).map((error) => `${error.path || "/"}: ${error.message}`);
    throw new AuditStoreError("invalid_event", `Invalid audit event: ${details.join("; ")}`, details);
  }
  const event = structuredClone(input) as AuditEventInput;
  if (!hasValidRfc3339CalendarDate(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
    throw new AuditStoreError("invalid_event", "Invalid audit event timestamp.");
  }
  return event;
}

function decodeUniquenessKeys(input: readonly AuditUniquenessKey[]): AuditUniquenessKey[] {
  const keys = input.map((key) => {
    if (!Value.Check(AuditUniquenessKeySchema, key)) throw new AuditStoreError("invalid_uniqueness_key", "Invalid audit uniqueness key.");
    return structuredClone(key) as AuditUniquenessKey;
  });
  const identities = keys.map((key) => `${key.namespace}\u0000${key.key}`);
  if (new Set(identities).size !== identities.length) throw new AuditStoreError("invalid_uniqueness_key", "Duplicate uniqueness key in append request.");
  return keys;
}

function hashEvent(event: AuditEventInput, previousEventHash: string | null): string {
  const canonical = JSON.stringify({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    streamId: event.streamId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payloadRef: event.payloadRef,
    payloadHash: event.payloadHash,
    privacyFilterRef: event.privacyFilterRef,
    previousEventHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function rowToEvent(row: AuditRow): PersistedAuditEvent {
  return {
    schemaVersion: GUARDIAN_SCHEMA_VERSION,
    eventId: row.event_id,
    streamId: row.stream_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payloadRef: row.payload_ref,
    payloadHash: row.payload_hash,
    privacyFilterRef: row.privacy_filter_ref,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  };
}

export class SqliteAuditStore {
  private readonly database: Database.Database;

  constructor(filename: string) {
    try {
      this.database = new Database(filename);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 0");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT NOT NULL,
          payload_ref TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          privacy_filter_ref TEXT NOT NULL,
          previous_event_hash TEXT,
          event_hash TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS audit_events_stream_sequence ON audit_events(stream_id, sequence);
        CREATE TABLE IF NOT EXISTS audit_unique_keys (
          namespace TEXT NOT NULL,
          unique_key TEXT NOT NULL,
          event_id TEXT NOT NULL REFERENCES audit_events(event_id),
          PRIMARY KEY(namespace, unique_key)
        );
      `);
    } catch (error) {
      throw new AuditStoreError("store_unavailable", "Unable to open audit store.", [], { cause: error });
    }
  }

  journalMode(): string {
    this.assertOpen();
    return String(this.database.pragma("journal_mode", { simple: true })).toLowerCase();
  }

  appendRequired(input: AppendAuditInput): PersistedAuditEvent {
    this.assertOpen();
    const event = decodeAuditEventInput(input.event);
    const uniquenessKeys = decodeUniquenessKeys(input.uniquenessKeys);
    try {
      return this.database.transaction(() => this.appendInTransaction(event, input.expectedPreviousEventHash, uniquenessKeys)).immediate();
    } catch (error) {
      if (error instanceof AuditStoreError) throw error;
      throw new AuditStoreError("storage_failure", "Required audit append failed.", [], { cause: error });
    }
  }

  appendAdvisory<TMutation>(input: AppendAuditInput, mutation: TMutation): AdvisoryAppendResult<TMutation> {
    try {
      return { status: "persisted", event: this.appendRequired(input), mutationEffect: "unchanged", mutation };
    } catch (error) {
      const code = error instanceof AuditStoreError ? error.code : "storage_failure";
      return { status: "non_persisted", code, mutationEffect: "unchanged", mutation };
    }
  }

  readStream(streamId: string): PersistedAuditEvent[] {
    this.assertOpen();
    if (!Value.Check(OpaqueReference(), streamId)) throw new AuditStoreError("invalid_event", "Invalid stream ID.");
    const rows = this.database.prepare("SELECT * FROM audit_events WHERE stream_id = ? ORDER BY sequence").all(streamId) as AuditRow[];
    let expectedPrevious: string | null = null;
    return rows.map((row) => {
      const event = rowToEvent(row);
      if (event.previousEventHash !== expectedPrevious || hashEvent(event, event.previousEventHash) !== event.eventHash) {
        throw new AuditStoreError("corrupt_stream", `Audit stream ${streamId} failed hash verification.`);
      }
      expectedPrevious = event.eventHash;
      return event;
    });
  }

  renderCompactEvidenceIndex(streamId: string): CompactEvidenceReference[] {
    return this.readStream(streamId).map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payloadRef: event.payloadRef,
      payloadHash: event.payloadHash,
      eventHash: event.eventHash,
    }));
  }

  close(): void {
    if (!this.database.open) return;
    this.database.close();
  }

  private assertOpen(): void {
    if (!this.database.open) throw new AuditStoreError("store_unavailable", "Audit store is closed.");
  }

  private appendInTransaction(event: AuditEventInput, expectedPreviousEventHash: string | null, uniquenessKeys: readonly AuditUniquenessKey[]): PersistedAuditEvent {
    const latest = this.database.prepare("SELECT event_hash FROM audit_events WHERE stream_id = ? ORDER BY sequence DESC LIMIT 1").get(event.streamId) as { event_hash: string } | undefined;
    const previousEventHash = latest?.event_hash ?? null;
    if (previousEventHash !== expectedPreviousEventHash) throw new AuditStoreError("conflict", "Audit stream head changed.");
    if (this.database.prepare("SELECT 1 FROM audit_events WHERE event_id = ?").get(event.eventId)) throw new AuditStoreError("duplicate_event", "Audit event ID already exists.");
    for (const key of uniquenessKeys) {
      if (this.database.prepare("SELECT 1 FROM audit_unique_keys WHERE namespace = ? AND unique_key = ?").get(key.namespace, key.key)) {
        throw new AuditStoreError("uniqueness_conflict", "Audit uniqueness key already exists.");
      }
    }
    const persisted = { ...event, previousEventHash, eventHash: hashEvent(event, previousEventHash) };
    this.database.prepare(`INSERT INTO audit_events (
      event_id, stream_id, event_type, occurred_at, actor_id, correlation_id, causation_id,
      payload_ref, payload_hash, privacy_filter_ref, previous_event_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.streamId, event.eventType, event.occurredAt, event.actorId, event.correlationId, event.causationId, event.payloadRef, event.payloadHash, event.privacyFilterRef, previousEventHash, persisted.eventHash);
    const insertKey = this.database.prepare("INSERT INTO audit_unique_keys(namespace, unique_key, event_id) VALUES (?, ?, ?)");
    for (const key of uniquenessKeys) insertKey.run(key.namespace, key.key, event.eventId);
    return persisted;
  }
}
