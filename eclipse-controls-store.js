"use strict";

const { Pool } = require("pg");

function createEclipseControlsStore(options = {}) {
  const env = options.env || process.env;
  const namespace = String(options.namespace || "test-bot").slice(0, 64);
  const connectionString = env.ECLIPSE_CONTROLS_DATABASE_URL ||
    env.ECLIPSE_LICENSE_DATABASE_URL || env.DATABASE_URL || "";
  const pool = options.pool || (connectionString ? new Pool({
    connectionString, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    ssl: /sslmode=require/i.test(connectionString) ? { rejectUnauthorized: false } : undefined
  }) : null);
  let initialized = false;
  let initError = "";

  async function initialize() {
    if (!pool) {
      initError = "Neon is not configured. Set ECLIPSE_LICENSE_DATABASE_URL or DATABASE_URL.";
      return false;
    }
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS eclipse_test_group_controls (
          bot_namespace TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          countdown_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          countdown_target_id TEXT,
          countdown_target_name TEXT,
          inactivity_ms INTEGER NOT NULL DEFAULT 300000,
          count_delay_ms INTEGER NOT NULL DEFAULT 2000,
          autolock_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          expected_title TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (bot_namespace, thread_id)
        );
        CREATE TABLE IF NOT EXISTS eclipse_test_countdown_state (
          bot_namespace TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_name TEXT NOT NULL DEFAULT '',
          locked_at BIGINT NOT NULL,
          last_activity_at BIGINT NOT NULL,
          countdown_started_at BIGINT,
          next_number INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'waiting',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (bot_namespace, thread_id)
        );
        CREATE TABLE IF NOT EXISTS eclipse_test_countdown_history (
          id BIGSERIAL PRIMARY KEY,
          bot_namespace TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_name TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL,
          started_at BIGINT NOT NULL,
          ended_at BIGINT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS eclipse_test_countdown_history_recent
          ON eclipse_test_countdown_history (bot_namespace, created_at DESC);
        CREATE TABLE IF NOT EXISTS eclipse_test_nickname_locks (
          bot_namespace TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          expected_nickname TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (bot_namespace, thread_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS eclipse_test_reaction_settings (
          bot_namespace TEXT PRIMARY KEY,
          settings JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      initialized = true;
      initError = "";
      return true;
    } catch (error) {
      initError = String(error?.message || error).slice(0, 300);
      console.error("[ECLIPSE CONTROLS] Neon initialization failed:", initError);
      return false;
    }
  }

  function assertReady() {
    if (!initialized) throw new Error(initError || "ECLIPSE controls database is not initialized.");
  }

  async function getGroup(threadID) {
    assertReady();
    const result = await pool.query(
      "SELECT thread_id AS \"threadID\", countdown_enabled AS \"countdownEnabled\", countdown_target_id AS \"countdownTargetId\", countdown_target_name AS \"countdownTargetName\", inactivity_ms AS \"inactivityMs\", count_delay_ms AS \"countDelayMs\", autolock_enabled AS \"autolockEnabled\", expected_title AS \"expectedTitle\" FROM eclipse_test_group_controls WHERE bot_namespace=$1 AND thread_id=$2",
      [namespace, String(threadID)]
    );
    return result.rows[0] || {
      threadID: String(threadID), countdownEnabled: false, countdownTargetId: "",
      countdownTargetName: "", inactivityMs: 300000, countDelayMs: 2000,
      autolockEnabled: false, expectedTitle: ""
    };
  }

  async function updateGroup(threadID, input = {}) {
    assertReady();
    const id = String(threadID || "").trim();
    if (!id || id.length > 128) throw new Error("A valid Messenger group is required.");
    const current = await getGroup(id);
    const targetId = input.countdownTargetId == null ? current.countdownTargetId : String(input.countdownTargetId).trim();
    const inactivityMs = input.inactivityMs == null ? current.inactivityMs : Math.max(60000, Math.min(3600000, Number(input.inactivityMs) || 300000));
    const countDelayMs = input.countDelayMs == null ? current.countDelayMs : Math.max(1000, Math.min(10000, Number(input.countDelayMs) || 2000));
    const expectedTitle = input.expectedTitle == null ? current.expectedTitle : String(input.expectedTitle).trim().slice(0, 100);
    const result = await pool.query(
      `INSERT INTO eclipse_test_group_controls
       (bot_namespace,thread_id,countdown_enabled,countdown_target_id,countdown_target_name,inactivity_ms,count_delay_ms,autolock_enabled,expected_title,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (bot_namespace,thread_id) DO UPDATE SET
       countdown_enabled=EXCLUDED.countdown_enabled,countdown_target_id=EXCLUDED.countdown_target_id,
       countdown_target_name=EXCLUDED.countdown_target_name,inactivity_ms=EXCLUDED.inactivity_ms,
       count_delay_ms=EXCLUDED.count_delay_ms,autolock_enabled=EXCLUDED.autolock_enabled,
       expected_title=EXCLUDED.expected_title,updated_at=NOW()
       RETURNING thread_id AS "threadID",countdown_enabled AS "countdownEnabled",
       countdown_target_id AS "countdownTargetId",countdown_target_name AS "countdownTargetName",
       inactivity_ms AS "inactivityMs",count_delay_ms AS "countDelayMs",
       autolock_enabled AS "autolockEnabled",expected_title AS "expectedTitle"`,
      [namespace,id,input.countdownEnabled == null ? current.countdownEnabled : Boolean(input.countdownEnabled),
       targetId || null,input.countdownTargetName == null ? current.countdownTargetName : String(input.countdownTargetName).slice(0,100),
       inactivityMs,countDelayMs,input.autolockEnabled == null ? current.autolockEnabled : Boolean(input.autolockEnabled),
       expectedTitle || null]
    );
    return result.rows[0];
  }


  async function saveNicknameLock(threadID, userID, nickname) {
    assertReady();
    const group = String(threadID || "").trim();
    const user = String(userID || "").trim();
    const expected = String(nickname || "").trim();
    if (!group || !user || !expected) throw new Error("A group, member, and nickname are required to save a nickname lock.");
    if (group.length > 128 || user.length > 128 || expected.length > 64) throw new Error("Nickname lock values exceed the supported limits.");
    const result = await pool.query(
      `INSERT INTO eclipse_test_nickname_locks (bot_namespace,thread_id,user_id,expected_nickname,updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (bot_namespace,thread_id,user_id) DO UPDATE SET expected_nickname=EXCLUDED.expected_nickname,updated_at=NOW()
       RETURNING thread_id AS "threadID",user_id AS "userID",expected_nickname AS "expectedNickname"`,
      [namespace, group, user, expected]
    );
    return result.rows[0];
  }

  async function getNicknameLocks(threadID) {
    assertReady();
    const result = await pool.query(
      'SELECT thread_id AS "threadID",user_id AS "userID",expected_nickname AS "expectedNickname" FROM eclipse_test_nickname_locks WHERE bot_namespace=$1 AND thread_id=$2 ORDER BY updated_at DESC',
      [namespace, String(threadID)]
    );
    return result.rows;
  }

  async function listNicknameLocks() {
    assertReady();
    const result = await pool.query(
      'SELECT thread_id AS "threadID",user_id AS "userID",expected_nickname AS "expectedNickname" FROM eclipse_test_nickname_locks WHERE bot_namespace=$1 ORDER BY thread_id,user_id',
      [namespace]
    );
    return result.rows;
  }

  async function deleteNicknameLock(threadID, userID) {
    assertReady();
    await pool.query("DELETE FROM eclipse_test_nickname_locks WHERE bot_namespace=$1 AND thread_id=$2 AND user_id=$3",
      [namespace, String(threadID), String(userID)]);
  }

  async function getReactionSettings() {
    assertReady();
    const result = await pool.query("SELECT settings FROM eclipse_test_reaction_settings WHERE bot_namespace=$1",[namespace]);
    return result.rows[0]?.settings || null;
  }

  async function updateReactionSettings(settings) {
    assertReady();
    const value = settings && typeof settings === "object" ? settings : {};
    const result = await pool.query(
      "INSERT INTO eclipse_test_reaction_settings (bot_namespace,settings,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (bot_namespace) DO UPDATE SET settings=EXCLUDED.settings,updated_at=NOW() RETURNING settings",
      [namespace,JSON.stringify(value)]
    );
    return result.rows[0].settings;
  }

  async function listProtectedGroups() {
    assertReady();
    const result = await pool.query(
      'SELECT thread_id AS "threadID" FROM eclipse_test_group_controls WHERE bot_namespace=$1 AND autolock_enabled=TRUE AND expected_title IS NOT NULL AND expected_title<>\'\'',
      [namespace]
    );
    return result.rows;
  }

  async function saveCountdownState(state) {
    assertReady();
    await pool.query(
      `INSERT INTO eclipse_test_countdown_state
       (bot_namespace,thread_id,target_id,target_name,locked_at,last_activity_at,countdown_started_at,next_number,status,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (bot_namespace,thread_id) DO UPDATE SET
       target_id=EXCLUDED.target_id,target_name=EXCLUDED.target_name,locked_at=EXCLUDED.locked_at,
       last_activity_at=EXCLUDED.last_activity_at,countdown_started_at=EXCLUDED.countdown_started_at,
       next_number=EXCLUDED.next_number,status=EXCLUDED.status,updated_at=NOW()`,
      [namespace,String(state.threadID),String(state.targetId),String(state.targetName||""),
       Number(state.lockedAt)||Date.now(),Number(state.lastActivityAt)||Date.now(),
       state.countdownStartedAt==null?null:Number(state.countdownStartedAt),
       Math.max(1,Number(state.nextNumber)||1),String(state.status||"waiting")]
    );
  }

  async function deleteCountdownState(threadID) {
    assertReady();
    await pool.query("DELETE FROM eclipse_test_countdown_state WHERE bot_namespace=$1 AND thread_id=$2",[namespace,String(threadID)]);
  }

  async function loadCountdownStates() {
    assertReady();
    const result=await pool.query(
      'SELECT thread_id AS "threadID",target_id AS "targetId",target_name AS "targetName",locked_at AS "lockedAt",last_activity_at AS "lastActivityAt",countdown_started_at AS "countdownStartedAt",next_number AS "nextNumber",status FROM eclipse_test_countdown_state WHERE bot_namespace=$1',
      [namespace]
    );
    return result.rows;
  }

  async function recordCountdownResult(item) {
    assertReady();
    await pool.query(
      "INSERT INTO eclipse_test_countdown_history (bot_namespace,thread_id,target_id,target_name,result,started_at,ended_at,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [namespace,String(item.threadID),String(item.targetId),String(item.targetName||""),String(item.result),
       Number(item.startedAt)||Date.now(),Number(item.endedAt)||Date.now(),String(item.reason||"").slice(0,300)]
    );
  }

  async function listCountdownHistory(limit = 50) {
    assertReady();
    const result=await pool.query(
      'SELECT id,thread_id AS "threadID",target_id AS "targetId",target_name AS "targetName",result,started_at AS "startedAt",ended_at AS "endedAt",reason,created_at AS "createdAt" FROM eclipse_test_countdown_history WHERE bot_namespace=$1 ORDER BY created_at DESC LIMIT $2',
      [namespace,Math.max(1,Math.min(100,Number(limit)||50))]
    );
    return result.rows;
  }

  return {
    initialize, isInitialized: () => initialized, getError: () => initError,
    getGroup, updateGroup, listProtectedGroups, saveNicknameLock, getNicknameLocks, listNicknameLocks, deleteNicknameLock, getReactionSettings, updateReactionSettings, saveCountdownState, deleteCountdownState,
    loadCountdownStates, recordCountdownResult, listCountdownHistory
  };
}

module.exports = { createEclipseControlsStore };
