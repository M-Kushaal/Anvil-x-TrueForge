import { describe, expect, it } from 'vitest';
import { CommandPermissions, EditPermissions } from '../../../src/mcp/permissions';

describe('EditPermissions', () => {
  it('consumes only the exact approved edit, regardless of argument order', () => {
    const grants = new EditPermissions();
    grants.grant('propose_edit', '{"path":"x.ts","search":"old","replace":"new"}');
    expect(grants.consume('propose_edit', { path: 'x.ts', search: 'old', replace: 'evil' })).toBe(false);
    expect(grants.consume('propose_edit', { replace: 'new', search: 'old', path: 'x.ts' })).toBe(true);
    expect(grants.consume('propose_edit', { path: 'x.ts', search: 'old', replace: 'new' })).toBe(false);
  });
  it('revokes grants when the active task stops', () => {
    const grants = new EditPermissions();
    grants.grant('create_file', { path: 'x.ts', content: 'new' });
    grants.revoke();
    expect(grants.consume('create_file', { path: 'x.ts', content: 'new' })).toBe(false);
  });
});

describe('CommandPermissions', () => {
  it('requires a grant and consumes it only once', () => {
    const permissions = new CommandPermissions();
    const args = { command: 'npm test', timeout_seconds: 30 };
    expect(permissions.consume(args)).toBe(false);
    expect(permissions.grant(JSON.stringify(args), permissions.epoch)).toBe(true);
    expect(permissions.consume(args)).toBe(true);
    expect(permissions.consume(args)).toBe(false);
  });

  it('matches the complete command and exact execution timeout', () => {
    const permissions = new CommandPermissions();
    permissions.grant({ command: 'npm test', timeout_seconds: 30 }, permissions.epoch);
    expect(permissions.consume({ command: 'npm test\nother-command', timeout_seconds: 30 })).toBe(false);
    expect(permissions.consume({ command: 'npm test ', timeout_seconds: 30 })).toBe(false);
    expect(permissions.consume({ command: 'npm test', timeout_seconds: 300 })).toBe(false);
    expect(permissions.consume({ command: 'npm test', timeout_seconds: 30 })).toBe(true);
  });

  it('normalizes an omitted timeout to the execution default', () => {
    const permissions = new CommandPermissions();
    permissions.grant({ command: 'npm test' }, permissions.epoch);
    expect(permissions.consume({ command: 'npm test', timeout_seconds: 120 })).toBe(true);
  });

  it('revokes existing grants and rejects approvals from the stopped task', () => {
    const permissions = new CommandPermissions();
    const oldEpoch = permissions.epoch;
    permissions.grant({ command: 'npm test' }, oldEpoch);
    permissions.revoke();
    expect(permissions.consume({ command: 'npm test' })).toBe(false);
    expect(permissions.grant({ command: 'npm test' }, oldEpoch)).toBe(false);
    expect(permissions.grant({ command: 'npm test' }, permissions.epoch)).toBe(true);
    expect(permissions.consume({ command: 'npm test' })).toBe(true);
  });

  it('retains the number of independently approved identical commands', () => {
    const permissions = new CommandPermissions();
    permissions.grant({ command: 'npm test' }, permissions.epoch);
    permissions.grant({ command: 'npm test' }, permissions.epoch);
    expect(permissions.consume({ command: 'npm test' })).toBe(true);
    expect(permissions.consume({ command: 'npm test' })).toBe(true);
    expect(permissions.consume({ command: 'npm test' })).toBe(false);
  });

  it.each([undefined, null, '', '{bad json', {}, { command: '' }, { command: '   ' }, { command: 1 }])('refuses malformed grants: %j', (args) => {
    const permissions = new CommandPermissions();
    expect(permissions.grant(args, permissions.epoch)).toBe(false);
    expect(permissions.consume(args)).toBe(false);
  });
});
