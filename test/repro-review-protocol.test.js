import {test} from 'node:test';import assert from 'node:assert/strict';
import {combineReviews} from '../src/repro/review-protocol.js';
import {validateWorkflow} from '../src/repro/config.js';
const review=status=>({schema:'video-remake.reproduction-review@1',artifactSha256:'a',evidenceManifestSha256:'b',checks:[{id:'visual',status,notes:'paired observations',evidenceIds:['s','r']}]});
test('only unanimous observed passes pass; fail and missing evidence remain blocking',()=>{
 for(const [a,b,expected] of [['pass','pass','pass'],['pass','fail','fail'],['pass','unobserved','unobserved'],['fail','fail','fail']]){
  const x=combineReviews([review(a),review(b)]);assert.equal(x.review.checks[0].status,expected);assert.equal(x.disagreements.length,a===b?0:1);
 }
 assert.throws(()=>combineReviews([review('pass'),{...review('pass'),artifactSha256:'other'}]),/share artifact/);
 assert.throws(()=>validateWorkflow({policy:{reviewSamples:3}}),/reviewSamples/);
});
