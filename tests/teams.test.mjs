import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTeams, serializeTeams, teamFromPanes, validateTeam, blankTeam, seatFor, missingSeats } from '../src/teams/teams.js';

test('hand-edited file is normalized with defaults', () => {
  const [t] = normalizeTeams({ teams: [{ name: ' Hexa ', layout: 'grid', agents: [{ role: 'Dev' }], extra: 1 }] });
  assert.equal(t.name, 'Hexa');
  assert.equal(t.layout, 'focus');
  assert.equal(t.defaultTarget, 'Dev');
  assert.deepEqual(t.agents, [{ role: 'Dev', harness: 'claude', model: '', instructions: '' }]);
  assert.ok(t.id);
  assert.equal(t.extra, undefined);
});

test('missing or broken shapes give no teams', () => {
  assert.deepEqual(normalizeTeams(null), []);
  assert.deepEqual(normalizeTeams({ teams: 'x' }), []);
});

test('serialize omits empty model and instructions', () => {
  const out = serializeTeams([{ id: 'a', name: 'T', defaultTarget: 'M',
    agents: [{ role: 'M', harness: 'claude', model: 'opus', instructions: '  ' }] }]);
  assert.equal(out.version, 1);
  assert.deepEqual(out.teams[0].agents, [{ role: 'M', harness: 'claude', model: 'opus' }]);
  assert.equal(out.teams[0].defaultTarget, 'M');
});

test('validation catches blank and duplicate roles and names', () => {
  const t = blankTeam('Hexa');
  assert.equal(validateTeam(t), null);
  assert.match(validateTeam({ ...t, name: '' }), /name/);
  assert.match(validateTeam({ ...t, agents: [] }), /at least one/);
  assert.match(validateTeam({ ...t, agents: [{ role: 'A' }, { role: 'a ' }] }), /Two agents/);
  assert.match(validateTeam(t, [{ id: 'other', name: 'hexa' }]), /already called/);
  assert.equal(validateTeam(t, [{ id: t.id, name: 'Hexa' }]), null);
});

test('current panes become a team, skipping run and terminal panes', () => {
  const panes = [
    { id: 1, label: 'Claude 1', harness: { id: 'claude' }, claude: true },
    { id: 2, label: 'Claude 2', harness: { id: 'claude' }, claude: true },
    { id: 3, label: 'Codex 3', harness: { id: 'codex' } },
    { id: 4, kind: 'run', label: 'dev', harness: { id: 'run:dev' } },
    { id: 5, label: 'Terminal 1', harness: { id: 'terminal' } },
    { id: 6, kind: 'chat', label: 'Claude Chat 6' },
  ];
  const t = teamFromPanes(panes, { 1: 'Developer 1', 2: 'Manager', 3: 'Developer 1' }, 'Hexa');
  assert.deepEqual(t.agents.map((a) => [a.role, a.harness]), [
    ['Developer 1', 'claude'], ['Manager', 'claude'], ['Developer 1 2', 'codex'], ['Claude Chat 6', 'claude'],
  ]);
  assert.equal(t.defaultTarget, 'Manager');
  assert.equal(t.name, 'Hexa');
});

test('seat carries role, model and a roster prompt', () => {
  const team = { id: 't1', name: 'Hexa', agents: [
    { role: 'Manager', harness: 'claude', model: '', instructions: 'Coordinate.' },
    { role: 'Developer 1', harness: 'claude', model: 'opus', instructions: '' },
    { role: 'Reviewer', harness: 'codex', model: '', instructions: '' },
  ] };
  const m = seatFor(team, team.agents[0], (id) => id === 'codex' ? 'Codex' : id);
  assert.equal(m.role, 'Manager');
  assert.equal(m.model, null);
  assert.match(m.prompt, /You are "Manager", one agent in the team "Hexa"/);
  assert.match(m.prompt, /- Developer 1\n- Reviewer \(Codex — can't receive session messages\)/);
  assert.match(m.prompt, /Your role:\nCoordinate\./);
  assert.equal(seatFor(team, team.agents[1]).model, 'opus');
  const solo = seatFor({ id: 's', name: 'Solo', agents: [team.agents[1]] }, team.agents[1]);
  assert.doesNotMatch(solo.prompt, /teammates/);
});

test('missing seats skip roles that already run', () => {
  const team = { id: 't1', agents: [{ role: 'Manager' }, { role: 'Dev' }] };
  const panes = [
    { id: 1, team: { team_id: 't1', role: 'manager' } },
    { id: 2, team: { team_id: 'other', role: 'Dev' } },
  ];
  assert.deepEqual(missingSeats(team, panes).map((a) => a.role), ['Dev']);
});
