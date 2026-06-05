const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'contracts.db');

let db = null;
let SQL = null;

async function initDb() {
  SQL = await initSqlJs();

  const buffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  db = new SQL.Database(buffer);

  db.run(`
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      parties TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS clauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      section TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, clause_id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conflict_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_a TEXT NOT NULL,
      tag_b TEXT NOT NULL,
      condition TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS risk_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_tags TEXT NOT NULL DEFAULT '[]',
      condition TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('high','medium','low')),
      description TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS detected_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_a_id TEXT NOT NULL,
      clause_b_id TEXT NOT NULL,
      conflict_type TEXT NOT NULL CHECK(conflict_type IN ('contradiction','ambiguity','overlap')),
      severity TEXT NOT NULL CHECK(severity IN ('critical','warning')),
      reason TEXT NOT NULL,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS risk_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      rule_id INTEGER NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('high','medium','low')),
      trigger_reason TEXT NOT NULL,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (rule_id) REFERENCES risk_rules(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS review_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conflict_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('confirm','dismiss','modify')),
      reviewer TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conflict_id) REFERENCES detected_conflicts(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS contract_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      revision_number INTEGER NOT NULL,
      clauses_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, revision_number)
    );
  `);

  const conflictCols = db.exec("PRAGMA table_info(detected_conflicts)");
  const hasConflictRevision = conflictCols[0]?.values?.some(row => row[1] === 'revision');
  if (!hasConflictRevision) {
    db.run(`ALTER TABLE detected_conflicts ADD COLUMN revision INTEGER DEFAULT 1`);
  }

  const riskCols = db.exec("PRAGMA table_info(risk_annotations)");
  const hasRiskRevision = riskCols[0]?.values?.some(row => row[1] === 'revision');
  if (!hasRiskRevision) {
    db.run(`ALTER TABLE risk_annotations ADD COLUMN revision INTEGER DEFAULT 1`);
  }

  saveDb();
  return db;
}

function getDb() {
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

function runSql(sql, params) {
  if (params) {
    db.run(sql, params);
  } else {
    db.run(sql);
  }
  const lastId = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
  saveDb();
  return {
    lastInsertRowid: lastId,
    changes: db.getRowsModified()
  };
}

module.exports = { getDb, initDb, saveDb, queryAll, queryOne, runSql };
