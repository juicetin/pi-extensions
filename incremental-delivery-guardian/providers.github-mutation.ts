import { Octokit } from "octokit";
import type { RiskClass } from "./schemas.ts";
import type { DeliveryClaim, GitHubPullRequestEvidence } from "./provider.ts";
import { createGitHubOctokitOptions, validateProtectedLifecycleEvidence } from "./provider.ts";
import type { SensitiveActionAuthorization, SensitiveActionConsumption } from "./decisions.ts";
import { validateSensitiveActionAuthorization } from "./decisions.ts";

export interface DescendantMaintenanceRequest { readonly pullRequestNumber:number; readonly headSha:string; readonly baseRef:string; readonly receiptHash:string }
export interface GitHubMergeRequest { readonly claim:DeliveryClaim; readonly evidence:GitHubPullRequestEvidence; readonly now:string; readonly riskClass?:RiskClass; readonly authorization?:SensitiveActionAuthorization; readonly consumedAuthorizationIds?:readonly string[]; readonly consumedNonces?:readonly string[]; readonly descendants:readonly DescendantMaintenanceRequest[] }
export interface GitHubMutationClient {
  merge(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}):Promise<{merged:boolean;sha:string}>;
  retarget(input:{repositoryId:string;pullRequestNumber:number;newBaseRef:string;expectedHeadSha:string}):Promise<void>;
  rebase(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}):Promise<{headSha:string}>;
}
interface GitHubWriteClient { pulls:{
  merge(input:{owner:string;repo:string;pull_number:number;sha:string}):Promise<{data:{merged:boolean;sha:string}}>;
  update(input:{owner:string;repo:string;pull_number:number;base:string}):Promise<{data:{head:{sha:string};base:{ref:string}}}>;
  updateBranch(input:{owner:string;repo:string;pull_number:number;expected_head_sha:string}):Promise<{data:{latest_commit_sha:string}}>;
} }
function repositoryParts(repositoryId:string):{owner:string;repo:string}{const parts=repositoryId.split("/");if(parts.length!==2||parts.some(part=>!part))throw new Error("github_repository_invalid");return{owner:parts[0]!,repo:parts[1]!};}
export class OctokitGitHubMutationClient implements GitHubMutationClient {
  private readonly client:GitHubWriteClient;
  constructor(client:GitHubWriteClient){this.client=client;}
  static authenticated(token:string,timeoutMs:number){const octokit=new Octokit(createGitHubOctokitOptions(token,timeoutMs));return new OctokitGitHubMutationClient(octokit.rest as unknown as GitHubWriteClient);}
  async merge(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}){const repo=repositoryParts(input.repositoryId);const response=await this.client.pulls.merge({...repo,pull_number:input.pullRequestNumber,sha:input.expectedHeadSha});return{merged:response.data.merged,sha:response.data.sha};}
  async retarget(input:{repositoryId:string;pullRequestNumber:number;newBaseRef:string;expectedHeadSha:string}){const repo=repositoryParts(input.repositoryId);const response=await this.client.pulls.update({...repo,pull_number:input.pullRequestNumber,base:input.newBaseRef});if(response.data.head.sha!==input.expectedHeadSha||response.data.base.ref!==input.newBaseRef)throw new Error("github_retarget_not_confirmed");}
  async rebase(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}){const repo=repositoryParts(input.repositoryId);const response=await this.client.pulls.updateBranch({...repo,pull_number:input.pullRequestNumber,expected_head_sha:input.expectedHeadSha});if(!response.data.latest_commit_sha)throw new Error("github_rebase_not_confirmed");return{headSha:response.data.latest_commit_sha};}
}
export interface MergeDependencies {
  readonly client:GitHubMutationClient;
  consume(consumption:SensitiveActionConsumption):Promise<void>;
  verify(input:{repositoryId:string;pullRequestNumber:number;headSha:string;baseRef:string;invalidatedReceiptHash:string}):Promise<{verificationId:string;completedAt:string}>;
}
export interface GitHubMergeResult { readonly mergeSha:string; readonly receiptHash:string; readonly descendants:readonly {pullRequestNumber:number;oldHeadSha:string;newHeadSha:string;newBaseRef:string;invalidatedReceiptHash:string;verificationId:string}[] }

const allowed=new Set(["claim","evidence","now","riskClass","authorization","consumedAuthorizationIds","consumedNonces","descendants"]);
function validateShape(input:GitHubMergeRequest):void{
 if(!input||typeof input!=="object"||Object.keys(input).some(k=>!allowed.has(k))||!Array.isArray(input.descendants))throw new Error("merge_request_invalid");
 if(new Set(input.descendants.map(d=>d.pullRequestNumber)).size!==input.descendants.length)throw new Error("merge_request_invalid");
 for(const d of input.descendants)if(!Number.isSafeInteger(d.pullRequestNumber)||d.pullRequestNumber<=0||!d.headSha||!d.baseRef||!d.receiptHash)throw new Error("merge_request_invalid");
}

export async function executeGitHubMerge(input:GitHubMergeRequest,deps:MergeDependencies):Promise<GitHubMergeResult>{
 validateShape(input);
 const receipt=validateProtectedLifecycleEvidence(input.claim,input.evidence);
 if(input.riskClass===undefined){
  if(input.authorization!==undefined||input.consumedAuthorizationIds!==undefined||input.consumedNonces!==undefined)throw new Error("merge_request_invalid");
 }else{
  if(!input.authorization||!input.consumedAuthorizationIds||!input.consumedNonces)throw new Error("merge_authorization_required");
  const validated=validateSensitiveActionAuthorization(input.authorization,{resource:{type:"pull_request",repositoryId:input.claim.repositoryId,resourceId:String(input.claim.pullRequestNumber),immutableTarget:input.claim.headSha},operation:"merge",riskClass:input.riskClass,now:input.now,consumedAuthorizationIds:[...input.consumedAuthorizationIds],consumedNonces:[...input.consumedNonces]});
  await deps.consume(validated.consumption);
 }
 for(const d of input.descendants)if(d.baseRef!==input.claim.branch||d.pullRequestNumber===input.claim.pullRequestNumber)throw new Error("descendant_mismatch");
 const merged=await deps.client.merge({repositoryId:input.claim.repositoryId,pullRequestNumber:input.claim.pullRequestNumber,expectedHeadSha:input.claim.headSha});
 if(!merged.merged||!merged.sha)throw new Error("merge_not_confirmed");
 const descendants=[];
 for(const d of input.descendants){
  await deps.client.retarget({repositoryId:input.claim.repositoryId,pullRequestNumber:d.pullRequestNumber,newBaseRef:input.claim.baseRef,expectedHeadSha:d.headSha});
  const rebased=await deps.client.rebase({repositoryId:input.claim.repositoryId,pullRequestNumber:d.pullRequestNumber,expectedHeadSha:d.headSha});
  if(!rebased.headSha||rebased.headSha===d.headSha)throw new Error("descendant_rebase_not_confirmed");
  const verification=await deps.verify({repositoryId:input.claim.repositoryId,pullRequestNumber:d.pullRequestNumber,headSha:rebased.headSha,baseRef:input.claim.baseRef,invalidatedReceiptHash:d.receiptHash});
  if(!verification.verificationId||Number.isNaN(Date.parse(verification.completedAt)))throw new Error("descendant_verification_invalid");
  descendants.push({pullRequestNumber:d.pullRequestNumber,oldHeadSha:d.headSha,newHeadSha:rebased.headSha,newBaseRef:input.claim.baseRef,invalidatedReceiptHash:d.receiptHash,verificationId:verification.verificationId});
 }
 return {mergeSha:merged.sha,receiptHash:receipt.receiptHash,descendants};
}
