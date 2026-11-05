import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import { saveEvidence } from '../src/observability/evidence.ts';

const dir = '.runtime/upstream/Akagi-63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/bridge/majsoul';
const proto = await readFile(`${dir}/proto/liqi.proto`);
const routes = await readFile(`${dir}/liqi.json`);
const versions = JSON.parse(await readFile('config/versions.json', 'utf8'));
const protoSha256 = createHash('sha256').update(proto).digest('hex');
const rpcMapSha256 = createHash('sha256').update(routes).digest('hex');
if (protoSha256 !== versions.protoSha256 || rpcMapSha256 !== versions.rpcMapSha256) throw new Error('PROTOCOL_HASH_MISMATCH');
const root = protobuf.parse(proto.toString(), { keepCase:true }).root;
const types = ['ReqCreateRoom','GameMode','OptionalOperationList','ActionPrototype','ActionNewRound','ReqSelfOperation','ReqSyncGame','ResSyncGame','GameRestore','GameSnapshot'];
const fields = Object.fromEntries(types.map(name => [name, Object.fromEntries(Object.entries(root.lookupType(`lq.${name}`).fields).map(([key, value]) => [key,{tag:value.id,type:value.type}]))]));
const evidence = { schemaVersion:1 as const, probe:'protocol', observedAt:new Date().toISOString(),
  status:'partial' as const,evidenceType:'local-integration' as const, details: {
    // Version and bundle identity were observed by the extraction run. Hashes prevent reuse after drift.
    declaredClientVersion:versions.clientVersion, bundleHash:versions.clientBundleHash,
    protoSha256,rpcMapSha256,
    routeCount:Object.keys(JSON.parse(routes.toString())).length,fields,
    limitation:'Schema inspection alone does not verify live compatibility; see technical-spikes.md.' } };
console.log(JSON.stringify({...evidence,evidencePath:await saveEvidence(evidence)},null,2));
