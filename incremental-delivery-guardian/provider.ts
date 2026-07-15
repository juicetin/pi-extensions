import { createHash } from "node:crypto";

import { Octokit } from "octokit";

export type CiState = "success" | "pending" | "failure" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "pending";

interface ResponseHeaders { readonly link?: string }
interface PullResponse {
  readonly data: {
    readonly state: string;
    readonly merged: boolean;
    readonly updated_at: string;
    readonly head: { readonly ref: string; readonly sha: string; readonly repo: { readonly full_name: string } | null };
    readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } | null };
  };
  readonly headers: ResponseHeaders;
}
interface ChecksResponse {
  readonly data: { readonly check_runs: readonly { readonly status: string; readonly conclusion: string | null }[] };
  readonly headers: ResponseHeaders;
}
interface ReviewsResponse {
  readonly data: readonly { readonly user: { readonly id: number } | null; readonly state: string; readonly submitted_at: string | null; readonly commit_id: string | null }[];
  readonly headers: ResponseHeaders;
}
interface StatusResponse {
  readonly data: { readonly state: string; readonly total_count: number };
  readonly headers: ResponseHeaders;
}

export interface GitHubReadClient {
  readonly pulls: {
    get(input: { owner: string; repo: string; pull_number: number }): Promise<PullResponse>;
    listReviews(input: { owner: string; repo: string; pull_number: number; per_page: 100 }): Promise<ReviewsResponse>;
  };
  readonly checks: {
    listForRef(input: { owner: string; repo: string; ref: string; per_page: 100 }): Promise<ChecksResponse>;
  };
  readonly repos: {
    getCombinedStatusForRef(input: { owner: string; repo: string; ref: string; per_page: 100 }): Promise<StatusResponse>;
  };
}

export interface GitHubEvidenceRequest {
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly observedAt: string;
}
export type ProviderName = "github" | "bitbucket";
export interface ProviderPullRequestEvidence {
  readonly provider: ProviderName;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly updatedAt: string;
  readonly observedAt: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepositoryId: string;
  readonly baseRef: string;
  readonly baseRepositoryId: string;
  readonly ciState: CiState;
  readonly reviewState: ReviewState;
}
export interface GitHubPullRequestEvidence extends ProviderPullRequestEvidence {
  readonly provider: "github";
}

export interface DeliveryClaim {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly observedAt: string;
  readonly maxAgeMs: number;
  readonly local: {
    readonly commitSha: string;
    readonly branch: string;
    readonly pushed: boolean;
    readonly verificationId: string;
    readonly verificationCompletedAt: string;
  };
}
export interface DeliveryReceipt {
  readonly schemaVersion: 1;
  readonly provider: ProviderName;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly providerObservedAt: string;
  readonly localVerificationId: string;
  readonly ciState: CiState;
  readonly reviewState: ReviewState;
  readonly receiptHash: string;
}

export type ProviderEvidenceErrorCode = "invalid_request" | "provider_unavailable" | "incomplete_evidence" | "claim_mismatch" | "stale_evidence" | "pull_request_not_open" | "ci_not_successful" | "review_not_approved";
export class ProviderEvidenceError extends Error {
  readonly code: ProviderEvidenceErrorCode;
  constructor(code: ProviderEvidenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderEvidenceError";
    this.code = code;
  }
}

export function createGitHubOctokitOptions(token: string, timeoutMs: number) {
  if (!token || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProviderEvidenceError("invalid_request", "GitHub token and positive finite timeout are required.");
  }
  return { auth: token, retry: { enabled: false }, request: { timeout: timeoutMs } } as const;
}

function hasNextPage(headers: ResponseHeaders): boolean {
  return headers.link?.includes('rel="next"') === true;
}

function ciState(checks: ChecksResponse["data"]["check_runs"]): CiState {
  if (checks.length === 0) return "unknown";
  const failed = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  if (checks.some((check) => check.status === "completed" && check.conclusion !== null && failed.has(check.conclusion))) return "failure";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  const accepted = new Set(["success", "neutral", "skipped"]);
  return checks.every((check) => check.conclusion !== null && accepted.has(check.conclusion)) ? "success" : "unknown";
}

function combinedCiState(checkState: CiState, status: StatusResponse["data"]): CiState {
  const statusState: CiState = status.total_count === 0 ? "unknown"
    : status.state === "success" ? "success"
      : status.state === "pending" ? "pending"
        : status.state === "failure" || status.state === "error" ? "failure" : "unknown";
  if (checkState === "failure" || statusState === "failure") return "failure";
  if (checkState === "pending" || statusState === "pending") return "pending";
  if (checkState === "success" || statusState === "success") return "success";
  return "unknown";
}

function reviewState(reviews: ReviewsResponse["data"], headSha: string): ReviewState {
  const latest = new Map<number, ReviewsResponse["data"][number]>();
  for (const review of reviews) {
    if (!review.user || !review.submitted_at || !validTimestamp(review.submitted_at)) throw new ProviderEvidenceError("incomplete_evidence", "Review identity or timestamp is unavailable.");
    const prior = latest.get(review.user.id);
    if (!prior || review.submitted_at > prior.submitted_at!) latest.set(review.user.id, review);
  }
  if ([...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) return "changes_requested";
  if ([...latest.values()].some((review) => review.state === "APPROVED" && review.commit_id === headSha)) return "approved";
  return "pending";
}

function validTimestamp(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && !Number.isNaN(Date.parse(value));
}

function validateRequest(input: GitHubEvidenceRequest): void {
  if (!input.owner || !input.repo || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0 || !validTimestamp(input.observedAt)) {
    throw new ProviderEvidenceError("invalid_request", "Valid repository, pull request number, and observation time are required.");
  }
}

export class GitHubEvidenceProvider {
  private readonly client: GitHubReadClient;

  constructor(client: GitHubReadClient) {
    this.client = client;
  }

  static authenticated(token: string, timeoutMs: number): GitHubEvidenceProvider {
    const octokit = new Octokit(createGitHubOctokitOptions(token, timeoutMs));
    return new GitHubEvidenceProvider(octokit.rest as unknown as GitHubReadClient);
  }

  async read(input: GitHubEvidenceRequest): Promise<GitHubPullRequestEvidence> {
    validateRequest(input);
    try {
      const pull = await this.client.pulls.get({ owner: input.owner, repo: input.repo, pull_number: input.pullRequestNumber });
      if (!pull.data.head.repo || !pull.data.base.repo) throw new ProviderEvidenceError("incomplete_evidence", "Pull request repository identity is unavailable.");
      if (!validTimestamp(pull.data.updated_at)) throw new ProviderEvidenceError("incomplete_evidence", "Pull request update time is invalid.");
      const checks = await this.client.checks.listForRef({ owner: input.owner, repo: input.repo, ref: pull.data.head.sha, per_page: 100 });
      const statuses = await this.client.repos.getCombinedStatusForRef({ owner: input.owner, repo: input.repo, ref: pull.data.head.sha, per_page: 100 });
      const reviews = await this.client.pulls.listReviews({ owner: input.owner, repo: input.repo, pull_number: input.pullRequestNumber, per_page: 100 });
      if (hasNextPage(checks.headers) || hasNextPage(statuses.headers) || hasNextPage(reviews.headers)) throw new ProviderEvidenceError("incomplete_evidence", "Provider evidence exceeds the bounded page.");
      return {
        provider: "github",
        repositoryId: `${input.owner}/${input.repo}`,
        pullRequestNumber: input.pullRequestNumber,
        state: pull.data.state === "open" ? "open" : "closed",
        merged: pull.data.merged,
        updatedAt: pull.data.updated_at,
        observedAt: input.observedAt,
        headRef: pull.data.head.ref,
        headSha: pull.data.head.sha,
        headRepositoryId: pull.data.head.repo.full_name,
        baseRef: pull.data.base.ref,
        baseRepositoryId: pull.data.base.repo.full_name,
        ciState: combinedCiState(ciState(checks.data.check_runs), statuses.data),
        reviewState: reviewState(reviews.data, pull.data.head.sha),
      };
    } catch (error) {
      if (error instanceof ProviderEvidenceError) throw error;
      throw new ProviderEvidenceError("provider_unavailable", "GitHub evidence request failed without retry.", { cause: error });
    }
  }
}

function requiredText(value: string): boolean {
  return value.trim().length > 0;
}

export function validateDeliveryEvidence(claim: DeliveryClaim, evidence: ProviderPullRequestEvidence): DeliveryReceipt {
  const observedAt = Date.parse(claim.observedAt);
  const evidenceAt = Date.parse(evidence.observedAt);
  const verificationAt = Date.parse(claim.local.verificationCompletedAt);
  if (!Number.isSafeInteger(claim.maxAgeMs) || claim.maxAgeMs <= 0 || [observedAt, evidenceAt, verificationAt].some(Number.isNaN)) {
    throw new ProviderEvidenceError("invalid_request", "Delivery claim times and freshness budget are invalid.");
  }
  if (evidenceAt > observedAt || observedAt - evidenceAt > claim.maxAgeMs) throw new ProviderEvidenceError("stale_evidence", "Provider evidence is stale or from the future.");
  if (evidence.state !== "open" || evidence.merged) throw new ProviderEvidenceError("pull_request_not_open", "Delivery requires an open, unmerged pull request.");
  const exact = evidence.repositoryId === claim.repositoryId
    && evidence.headRepositoryId === claim.repositoryId
    && evidence.baseRepositoryId === claim.repositoryId
    && evidence.pullRequestNumber === claim.pullRequestNumber
    && evidence.headRef === claim.branch
    && evidence.headSha === claim.headSha
    && evidence.baseRef === claim.baseRef
    && claim.local.commitSha === claim.headSha
    && claim.local.branch === claim.branch
    && claim.local.pushed
    && requiredText(claim.local.verificationId)
    && verificationAt <= observedAt;
  if (!exact) throw new ProviderEvidenceError("claim_mismatch", "Delivery claim does not match local and provider evidence.");
  const receiptCore = {
    schemaVersion: 1 as const,
    provider: evidence.provider,
    repositoryId: claim.repositoryId,
    pullRequestNumber: claim.pullRequestNumber,
    branch: claim.branch,
    headSha: claim.headSha,
    baseRef: claim.baseRef,
    providerObservedAt: evidence.observedAt,
    localVerificationId: claim.local.verificationId,
    ciState: evidence.ciState,
    reviewState: evidence.reviewState,
  };
  return { ...receiptCore, receiptHash: createHash("sha256").update(JSON.stringify(receiptCore)).digest("hex") };
}

export function validateProtectedLifecycleEvidence(claim: DeliveryClaim, evidence: ProviderPullRequestEvidence): DeliveryReceipt {
  const receipt = validateDeliveryEvidence(claim, evidence);
  if (receipt.ciState !== "success") throw new ProviderEvidenceError("ci_not_successful", "Protected lifecycle action requires successful CI.");
  if (receipt.reviewState !== "approved") throw new ProviderEvidenceError("review_not_approved", "Protected lifecycle action requires current approval for the exact head.");
  return receipt;
}

export async function attemptOptionalGitHubEvidence<TMutation>(provider: GitHubEvidenceProvider, input: GitHubEvidenceRequest, mutation: TMutation) {
  try {
    return { status: "available" as const, evidence: await provider.read(input), mutationEffect: "unchanged" as const, mutation };
  } catch (error) {
    const code = error instanceof ProviderEvidenceError ? error.code : "provider_unavailable";
    return { status: "provider_unavailable" as const, code, mutationEffect: "unchanged" as const, mutation };
  }
}
