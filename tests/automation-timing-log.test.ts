import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AutomationIncidentLog,parseAutomaticTimingSample,parseAutoWinEnsureTiming} from '../src/app/console/automation-incidents.ts';

const sample={event:'timing.automatic-sample',step:25,fixedMs:5000,addMs:0,passedWaitingTime:1,
  syncRttMs:370.25,wireToCaptureStartMs:420.75,collectionMs:980.5,sampleIndex:0};

test('automatic timing samples cross the bounded worker log only when explicitly enabled',t=>{
  const previous=process.env.MAJI_TIMING_TRACE;
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const lines:string[]=[],log=new AutomationIncidentLog(line=>lines.push(line)),line=JSON.stringify(sample)+'\n';
  delete process.env.MAJI_TIMING_TRACE;log.consume(line);assert.equal(lines.length,0);
  process.env.MAJI_TIMING_TRACE='1';log.consume(line.slice(0,47));log.consume(line.slice(47));log.consume(line);
  assert.deepEqual(lines.map(value=>JSON.parse(value)),[sample]);
  assert.deepEqual(parseAutomaticTimingSample(sample),sample);
  assert.doesNotThrow(()=>new AutomationIncidentLog(()=>{throw Error('LOG_FAILURE');}).emit(sample));
});

test('timing diagnostics reject payloads, arbitrary text, invalid clocks and unbounded values',t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const lines:string[]=[],log=new AutomationIncidentLog(line=>lines.push(line));
  for(const value of [null,[],{...sample,cookie:'PRIVATE'},{...sample,event:'timing.page-call'},
    {...sample,addMs:'PRIVATE'},{...sample,step:0},{...sample,fixedMs:0},{...sample,addMs:20001},
    {...sample,passedWaitingTime:1.5},{...sample,syncRttMs:Infinity},{...sample,wireToCaptureStartMs:-1},
    {...sample,collectionMs:120001},{...sample,sampleIndex:2}]) {
    assert.equal(parseAutomaticTimingSample(value),null);log.consume(JSON.stringify(value)+'\n');
  }
  assert.deepEqual(lines,[]);
});

test('ensure diagnostics expose only bounded phases, ages and changed field names behind the same opt-in',t=>{
  const previous=process.env.MAJI_TIMING_TRACE;
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const value={event:'timing.auto-win-ensure',phase:'ack',succeeded:false,totalMs:1250.25,ackAgeMs:1001,
    changedFields:['generation','lastStep'],captureMode:'region',captures:2};
  assert.deepEqual(parseAutoWinEnsureTiming(value),value);
  const lines:string[]=[],log=new AutomationIncidentLog(line=>lines.push(line));
  delete process.env.MAJI_TIMING_TRACE;log.consume(JSON.stringify(value)+'\n');assert.deepEqual(lines,[]);
  process.env.MAJI_TIMING_TRACE='1';log.consume(JSON.stringify(value)+'\n');
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[value]);
  const invalid=[{...value,scope:'PRIVATE'},{...value,phase:'PRIVATE'},
    {...value,changedFields:['PRIVATE']},{...value,changedFields:['generation','generation']},
    {...value,captureMode:'PRIVATE'},{...value,captures:257},{...value,totalMs:Infinity},
    {...value,ackAgeMs:'PRIVATE'},{...value,succeeded:'PRIVATE'}];
  for(const sample of invalid){assert.equal(parseAutoWinEnsureTiming(sample),null);log.consume(JSON.stringify(sample)+'\n');}
  assert.equal(lines.length,1);
  const last={...value,phase:'recovery-table',ackAgeMs:null,changedFields:[],captures:0,captureMode:'none'};
  const encoded=JSON.stringify(last)+'\n';log.consume(encoded.slice(0,50));log.consume(encoded.slice(50));
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[value,last]);
  assert.doesNotThrow(()=>new AutomationIncidentLog(()=>{throw Error('LOG_FAILURE');}).emit(value));
});
