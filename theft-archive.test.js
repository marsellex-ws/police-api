import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCurrentTheft, projectTheftArchive } from './theft-archive.js';
import { aggregatePoliceWeeks } from './theft-leaderboard.js';

test('current theft keeps the player private until the source reveals them', () => {
  const data = {theftInProgress:true, players:{23:{name:'Player_Test',playerId:23,startTime:100,state:2}}};
  assert.deepEqual(projectCurrentTheft(data), {active:{state:2, name:'', account:'', started_at:100}});
  data.players[23].state = 3;
  assert.deepEqual(projectCurrentTheft(data), {active:{state:3, name:'Player_Test',account:'23',started_at:100}});
  assert.deepEqual(projectCurrentTheft({theftInProgress:false,players:{}}), {active:null});
});

test('archive preserves the source counts and pays only successful thefts', () => {
  const projected = projectTheftArchive({
    23: {level:4, theftHistory:[
      {name:'Player_Test',timestamp:10,state:4,success:1,reward:500},
      {timestamp:20,state:5,success:0,reward:0},
      {timestamp:30,state:0,success:0,reward:2},
    ]}
  });
  assert.deepEqual(projected.totals,{players:1,successes:1,arrests:1,failures:1});
  assert.deepEqual(projected.history.map(item=>item.status),['failed','arrested','success']);
  assert.equal(projected.players[0].earnings,500);
});

test('archived police weeks split at Monday midnight in Moscow', () => {
  const monday = Date.parse('2026-11-23T00:00:00+03:00') / 1000;
  const weeks = aggregatePoliceWeeks([
    {timestamp:monday-1,policeName:'Officer',reward:50},
    {timestamp:monday,policeName:'Officer',reward:100},
  ], (monday+60)*1000);
  assert.deepEqual(weeks.map(week=>week.total_reward),[100,50]);
  assert.equal(weeks[0].from,new Date(monday*1000).toISOString());
});
