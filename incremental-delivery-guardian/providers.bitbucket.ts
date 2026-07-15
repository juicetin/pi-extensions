import type { CiState, ProviderPullRequestEvidence, ReviewState } from "./provider.ts";

export type BitbucketProviderErrorCode = "invalid_request" | "provider_unavailable" | "incomplete_evidence";
export class BitbucketProviderError extends Error {
  readonly code: BitbucketProviderErrorCode;
  constructor(code: BitbucketProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BitbucketProviderError";
    this.code = code;
  }
}

export interface BitbucketReadClient { get(path: string): Promise<unknown> }
export interface BitbucketEvidenceRequest {
  readonly workspace: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly observedAt: string;
}
export interface BitbucketPullRequestEvidence extends ProviderPullRequestEvidence {
  readonly provider: "bitbucket";
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class BitbucketRestClient implements BitbucketReadClient {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(token: string, timeoutMs: number, fetcher: Fetcher = globalThis.fetch) {
    if (!token || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof fetcher !== "function") {
      throw new BitbucketProviderError("invalid_request", "Bitbucket token, positive finite timeout, and fetch implementation are required.");
    }
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
  }

  async get(path: string): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new BitbucketProviderError("invalid_request", "Bitbucket request path must be relative to the official API origin.");
    let response: Response;
    try {
      response = await this.fetcher(`https://api.bitbucket.org/2.0${path}`, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new BitbucketProviderError("provider_unavailable", "Bitbucket REST request failed without retry.", { cause: error });
    }
    if (!response.ok) throw new BitbucketProviderError("provider_unavailable", `Bitbucket REST request returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch (error) {
      throw new BitbucketProviderError("incomplete_evidence", "Bitbucket REST response was not valid JSON.", { cause: error });
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BitbucketProviderError("incomplete_evidence", `${label} is missing or malformed.`);
  return value as Record<string, unknown>;
}
function text(record: Record<string, unknown>, key: string, label: string): string {
  if (typeof record[key] !== "string" || record[key] === "") throw new BitbucketProviderError("incomplete_evidence", `${label}.${key} is missing or malformed.`);
  return record[key];
}
function recordAt(record: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  return object(record[key], `${label}.${key}`);
}
function list(record: Record<string, unknown>, key: string, label: string): unknown[] {
  if (!Array.isArray(record[key])) throw new BitbucketProviderError("incomplete_evidence", `${label}.${key} is missing or malformed.`);
  return record[key];
}
function validTimestamp(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && !Number.isNaN(Date.parse(value));
}
function requireTimestamp(value: string, label: string): string {
  if (!validTimestamp(value)) throw new BitbucketProviderError("incomplete_evidence", `${label} is not a valid timestamp.`);
  return value;
}
function assertCompletePage(page: Record<string, unknown>, label: string): void {
  if (typeof page.next === "string" && page.next.length > 0) throw new BitbucketProviderError("incomplete_evidence", `${label} exceeds the bounded page.`);
}

function latestHeadUpdate(activity: Record<string, unknown>, headSha: string, createdOn: string): number {
  assertCompletePage(activity, "pull request activity");
  let latest = Date.parse(createdOn);
  for (const raw of list(activity, "values", "pull request activity")) {
    const entry = object(raw, "activity entry");
    if (entry.update === undefined) continue;
    const update = object(entry.update, "activity update");
    const source = recordAt(update, "source", "activity update");
    const commit = recordAt(source, "commit", "activity update.source");
    if (text(commit, "hash", "activity update.source.commit") !== headSha) continue;
    const date = Date.parse(requireTimestamp(text(update, "date", "activity update"), "activity update.date"));
    if (date > latest) latest = date;
  }
  return latest;
}

function currentReviewState(pull: Record<string, unknown>, headUpdatedAt: number): ReviewState {
  let approved = false;
  for (const raw of list(pull, "participants", "pull request")) {
    const participant = object(raw, "participant");
    text(recordAt(participant, "user", "participant"), "uuid", "participant.user");
    const participatedOn = Date.parse(requireTimestamp(text(participant, "participated_on", "participant"), "participant.participated_on"));
    if (participatedOn < headUpdatedAt) continue;
    if (participant.state === "changes_requested") return "changes_requested";
    if (participant.approved === true && participant.state === "approved") approved = true;
  }
  return approved ? "approved" : "pending";
}

function pipelineState(page: Record<string, unknown>, headSha: string): CiState {
  assertCompletePage(page, "pipelines");
  const pipelines = list(page, "values", "pipelines").map((raw) => object(raw, "pipeline"));
  if (pipelines.length === 0) return "unknown";
  for (const pipeline of pipelines) {
    const commit = recordAt(recordAt(pipeline, "target", "pipeline"), "commit", "pipeline.target");
    if (text(commit, "hash", "pipeline.target.commit") !== headSha) throw new BitbucketProviderError("incomplete_evidence", "Pipeline query returned evidence for a different head.");
    requireTimestamp(text(pipeline, "created_on", "pipeline"), "pipeline.created_on");
  }
  pipelines.sort((left, right) => Date.parse(text(right, "created_on", "pipeline")) - Date.parse(text(left, "created_on", "pipeline")));
  const state = recordAt(pipelines[0]!, "state", "pipeline");
  const name = text(state, "name", "pipeline.state");
  if (name === "PENDING" || name === "IN_PROGRESS") return "pending";
  if (name !== "COMPLETED") return "unknown";
  if (state.result === null || state.result === undefined) return "unknown";
  const result = text(object(state.result, "pipeline.state.result"), "name", "pipeline.state.result");
  if (result === "SUCCESSFUL") return "success";
  if (["FAILED", "ERROR", "STOPPED", "EXPIRED"].includes(result)) return "failure";
  return "unknown";
}

export class BitbucketEvidenceProvider {
  private readonly client: BitbucketReadClient;
  constructor(client: BitbucketReadClient) { this.client = client; }

  async read(input: BitbucketEvidenceRequest): Promise<BitbucketPullRequestEvidence> {
    if (!input.workspace || !input.repo || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0 || !validTimestamp(input.observedAt)) {
      throw new BitbucketProviderError("invalid_request", "Valid workspace, repository, pull request number, and observation time are required.");
    }
    const workspace = encodeURIComponent(input.workspace);
    const repo = encodeURIComponent(input.repo);
    const root = `/repositories/${workspace}/${repo}`;
    try {
      const pull = object(await this.client.get(`${root}/pullrequests/${input.pullRequestNumber}`), "pull request");
      const id = pull.id;
      if (id !== input.pullRequestNumber) throw new BitbucketProviderError("incomplete_evidence", "Pull request identity does not match the request.");
      const source = recordAt(pull, "source", "pull request");
      const destination = recordAt(pull, "destination", "pull request");
      const headSha = text(recordAt(source, "commit", "pull request.source"), "hash", "pull request.source.commit");
      const activity = object(await this.client.get(`${root}/pullrequests/${input.pullRequestNumber}/activity?pagelen=100`), "pull request activity");
      const query = encodeURIComponent(`target.commit.hash="${headSha}"`);
      const pipelinePage = object(await this.client.get(`${root}/pipelines/?pagelen=100&sort=-created_on&q=${query}`), "pipelines");
      const state = text(pull, "state", "pull request");
      if (!["OPEN", "MERGED", "DECLINED", "SUPERSEDED"].includes(state)) throw new BitbucketProviderError("incomplete_evidence", "Pull request state is unsupported.");
      const createdOn = requireTimestamp(text(pull, "created_on", "pull request"), "pull request.created_on");
      const updatedOn = requireTimestamp(text(pull, "updated_on", "pull request"), "pull request.updated_on");
      const sourceRepo = text(recordAt(source, "repository", "pull request.source"), "full_name", "pull request.source.repository");
      const destinationRepo = text(recordAt(destination, "repository", "pull request.destination"), "full_name", "pull request.destination.repository");
      return {
        provider: "bitbucket",
        repositoryId: `${input.workspace}/${input.repo}`,
        pullRequestNumber: input.pullRequestNumber,
        state: state === "OPEN" ? "open" : "closed",
        merged: state === "MERGED",
        updatedAt: updatedOn,
        observedAt: input.observedAt,
        headRef: text(recordAt(source, "branch", "pull request.source"), "name", "pull request.source.branch"),
        headSha,
        headRepositoryId: sourceRepo,
        baseRef: text(recordAt(destination, "branch", "pull request.destination"), "name", "pull request.destination.branch"),
        baseRepositoryId: destinationRepo,
        ciState: pipelineState(pipelinePage, headSha),
        reviewState: currentReviewState(pull, latestHeadUpdate(activity, headSha, createdOn)),
      };
    } catch (error) {
      if (error instanceof BitbucketProviderError) throw error;
      throw new BitbucketProviderError("provider_unavailable", "Bitbucket evidence request failed without retry.", { cause: error });
    }
  }
}

export async function attemptOptionalBitbucketEvidence<TMutation>(provider: BitbucketEvidenceProvider, input: BitbucketEvidenceRequest, mutation: TMutation) {
  try {
    return { status: "available" as const, evidence: await provider.read(input), mutationEffect: "unchanged" as const, mutation };
  } catch (error) {
    const code = error instanceof BitbucketProviderError ? error.code : "provider_unavailable";
    return { status: "provider_unavailable" as const, code, mutationEffect: "unchanged" as const, mutation };
  }
}
