import type { RiskClass } from "./schemas.ts";
import type { DeliveryClaim, GitHubPullRequestEvidence } from "./provider.ts";
import { validateProtectedLifecycleEvidence } from "./provider.ts";
import type { SensitiveActionAuthorization, SensitiveActionConsumption } from "./decisions.ts";
import { validateSensitiveActionAuthorization } from "./decisions.ts";

export interface DescendantMaintenanceRequest { readonly pullRequestNumber:number; readonly headSha:string; readonly baseRef:string; readonly receiptHash:string }
export interface GitHubMergeRequest { readonly claim:DeliveryClaim; readonly evidence:GitHubPullRequestEvidence; readonly now:string; readonly riskClass?:RiskClass; readonly authorization?:SensitiveActionAuthorization; readonly consumedAuthorizationIds?:readonly string[]; readonly consumedNonces?:readonly string[]; readonly descendants:readonly DescendantMaintenanceRequest[] }
export interface GitHubMutationClient {
  merge(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}):Promise<{merged:true;sha:string}>;
  retarget(input:{repositoryId:string;pullRequestNumber:number;newBaseRef:string;expectedHeadSha:string}):Promise<void>;
  rebase(input:{repositoryId:string;pullRequestNumber:number;expectedHeadSha:string}):Promise<{headSha:string}>;
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
