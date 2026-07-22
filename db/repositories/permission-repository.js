'use strict';

const {
  booleanInteger,
  immediate,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

const ROLES = new Set(['MEMBER', 'ERIC', 'ADMIN']);

function role(value) {
  const normalized = requireString(value, 'role', { max: 20 }).toUpperCase();
  if (!ROLES.has(normalized)) throw new TypeError(`Unsupported role: ${value}`);
  return normalized;
}

class PermissionRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.byId = db.prepare('SELECT * FROM permissions WHERE id = ?');
    this.byCanonical = db.prepare(
      'SELECT * FROM permissions WHERE chat_id = ? AND canonical_jid = ?'
    );
    this.byAlias = db.prepare(`
      SELECT p.*, a.id AS matched_alias_id, a.alias_jid AS matched_alias_jid
      FROM jid_aliases a
      JOIN permissions p ON p.id = a.permission_id AND p.chat_id = a.chat_id
      WHERE p.chat_id = ? AND a.alias_jid = ?
        AND a.enabled = 1 AND a.deleted_at IS NULL
        AND p.enabled = 1 AND p.deleted_at IS NULL
    `);
    this.activeRoles = db.prepare(`
      SELECT role FROM permission_roles
      WHERE permission_id = ? AND enabled = 1 AND deleted_at IS NULL
      ORDER BY CASE role WHEN 'MEMBER' THEN 1 WHEN 'ERIC' THEN 2 ELSE 3 END
    `);
  }

  decorate(permission, matchedAlias = null) {
    if (!permission || permission.enabled !== 1 || permission.deleted_at !== null) return null;
    const roles = this.activeRoles.all(permission.id).map((row) => row.role);
    if (!roles.length) return null;
    const effectiveRoles = [...roles];
    if (roles.includes('ADMIN') && !effectiveRoles.includes('MEMBER')) effectiveRoles.push('MEMBER');
    return {
      ...permission,
      roles,
      effective_roles: effectiveRoles,
      matched_alias_jid: matchedAlias,
    };
  }

  set(input) {
    const values = {
      permissionUid: uid(input.permissionUid, 'permissionUid'),
      chatId: requireInteger(input.chatId, 'chatId', { min: 1 }),
      canonicalJid: requireString(input.canonicalJid, 'canonicalJid', { max: 200 }),
      role: role(input.role),
      roleEnabled: booleanInteger(input.enabled, true),
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const aliasOwner = this.db.prepare(`
        SELECT permission_id AS id FROM jid_aliases
        WHERE chat_id = ? AND alias_jid = ? AND deleted_at IS NULL
      `).get(values.chatId, values.canonicalJid);
      const existing = this.byCanonical.get(values.chatId, values.canonicalJid);
      if (aliasOwner && aliasOwner.id !== existing?.id) {
        throw new Error('Canonical JID is already assigned as an alias in this chat');
      }

      let permission = existing;
      if (permission) {
        permission = this.db.prepare(`
          UPDATE permissions
          SET enabled = 1, updated_at = @now, deleted_at = NULL
          WHERE id = @id RETURNING *
        `).get({ id: permission.id, now: values.now });
      } else {
        permission = this.db.prepare(`
          INSERT INTO permissions (
            permission_uid, chat_id, canonical_jid, enabled, created_at, updated_at
          ) VALUES (@permissionUid, @chatId, @canonicalJid, 1, @now, @now)
          RETURNING *
        `).get(values);
      }

      this.db.prepare(`
        INSERT INTO permission_roles (
          permission_id, chat_id, role, enabled, created_at, updated_at, deleted_at
        ) VALUES (@permissionId, @chatId, @role, @roleEnabled, @now, @now, NULL)
        ON CONFLICT(permission_id, role) DO UPDATE SET
          enabled = excluded.enabled, updated_at = excluded.updated_at, deleted_at = NULL
      `).run({ ...values, permissionId: permission.id });

      const decorated = this.decorate(permission);
      // A disabled last role is intentionally not an authorization result, but set()
      // still returns the identity so callers can manage it.
      return decorated || {
        ...permission,
        roles: [],
        effective_roles: [],
        matched_alias_jid: null,
      };
    });
  }

  setRoleEnabled(input) {
    const permissionId = requireInteger(input.permissionId, 'permissionId', { min: 1 });
    const selectedRole = role(input.role);
    const enabled = booleanInteger(input.enabled);
    const now = requireTimestamp(input.now, 'now');
    const result = this.db.prepare(`
      UPDATE permission_roles SET enabled = ?, updated_at = ?
      WHERE permission_id = ? AND role = ? AND deleted_at IS NULL
      RETURNING *
    `).get(enabled, now, permissionId, selectedRole);
    if (!result) return null;
    const permission = this.byId.get(permissionId);
    return this.decorate(permission) || { ...permission, roles: [], effective_roles: [], matched_alias_jid: null };
  }

  setIdentityEnabled(id, enabled, now) {
    const permission = this.db.prepare(`
      UPDATE permissions SET enabled = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL RETURNING *
    `).get(
      booleanInteger(enabled),
      requireTimestamp(now, 'now'),
      requireInteger(id, 'id', { min: 1 })
    );
    return permission ? (this.decorate(permission) || { ...permission, roles: [], effective_roles: [], matched_alias_jid: null }) : null;
  }

  addAlias(input) {
    const values = {
      aliasUid: uid(input.aliasUid, 'aliasUid'),
      permissionId: requireInteger(input.permissionId, 'permissionId', { min: 1 }),
      aliasJid: requireString(input.aliasJid, 'aliasJid', { max: 200 }),
      enabled: booleanInteger(input.enabled, true),
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const permission = this.byId.get(values.permissionId);
      if (!permission || permission.deleted_at !== null) throw new Error('Permission not found');
      values.chatId = permission.chat_id;
      const canonicalOwner = this.db.prepare(`
        SELECT id FROM permissions
        WHERE chat_id = ? AND canonical_jid = ? AND deleted_at IS NULL
      `).get(permission.chat_id, values.aliasJid);
      if (canonicalOwner) throw new Error('Alias JID is already assigned as a canonical JID in this chat');

      const created = this.db.prepare(`
        INSERT INTO jid_aliases (
          alias_uid, permission_id, chat_id, alias_jid, enabled, created_at, updated_at
        ) VALUES (@aliasUid, @permissionId, @chatId, @aliasJid, @enabled, @now, @now)
        ON CONFLICT(chat_id, alias_jid) DO NOTHING RETURNING *
      `).get(values);
      if (created) return { record: created, created: true };

      const existing = this.db.prepare(
        'SELECT * FROM jid_aliases WHERE chat_id = ? AND alias_jid = ?'
      ).get(values.chatId, values.aliasJid);
      if (existing.permission_id !== values.permissionId) {
        throw new Error('JID alias is already assigned to another identity in this chat');
      }
      const restored = this.db.prepare(`
        UPDATE jid_aliases
        SET enabled = @enabled, deleted_at = NULL, updated_at = @now
        WHERE id = @id RETURNING *
      `).get({ ...values, id: existing.id });
      return { record: restored, created: false };
    });
  }

  setAliasEnabled(id, enabled, now) {
    return this.db.prepare(`
      UPDATE jid_aliases SET enabled = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL RETURNING *
    `).get(
      booleanInteger(enabled),
      requireTimestamp(now, 'now'),
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  resolve(chatId, jid) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const normalizedJid = requireString(jid, 'jid', { max: 200 });
    const direct = this.byCanonical.get(id, normalizedJid);
    const decoratedDirect = this.decorate(direct);
    if (decoratedDirect) return decoratedDirect;
    const aliased = this.byAlias.get(id, normalizedJid);
    return this.decorate(aliased, aliased?.matched_alias_jid || null);
  }

  hasRole(chatId, jid, requiredRole) {
    const permission = this.resolve(chatId, jid);
    return Boolean(permission?.effective_roles.includes(role(requiredRole)));
  }

  list(chatId, { includeDisabled = false } = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM permissions
      WHERE chat_id = ? AND deleted_at IS NULL ${includeDisabled ? '' : 'AND enabled = 1'}
      ORDER BY id
    `).all(requireInteger(chatId, 'chatId', { min: 1 }));
    if (includeDisabled) {
      return rows.map((row) => this.decorate(row) || {
        ...row, roles: [], effective_roles: [], matched_alias_jid: null,
      });
    }
    return rows.map((row) => this.decorate(row)).filter(Boolean);
  }

  softDelete(id, now) {
    const permissionId = requireInteger(id, 'id', { min: 1 });
    const timestamp = requireTimestamp(now, 'now');
    return immediate(this.db, () => {
      this.db.prepare(`
        UPDATE jid_aliases
        SET enabled = 0, deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE permission_id = ?
      `).run(timestamp, timestamp, permissionId);
      this.db.prepare(`
        UPDATE permission_roles
        SET enabled = 0, deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE permission_id = ?
      `).run(timestamp, timestamp, permissionId);
      return this.db.prepare(`
        UPDATE permissions SET enabled = 0, deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL RETURNING *
      `).get(timestamp, timestamp, permissionId) || null;
    });
  }
}

module.exports = { PermissionRepository, ROLES };
