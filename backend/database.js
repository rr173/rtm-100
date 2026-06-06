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
      original_severity TEXT CHECK(original_severity IN ('critical','warning')),
      reason TEXT NOT NULL,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS risk_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      rule_id INTEGER,
      conflict_id INTEGER,
      cross_conflict_id INTEGER,
      level TEXT NOT NULL CHECK(level IN ('high','medium','low')),
      trigger_reason TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'rule' CHECK(source IN ('rule','conflict','cross_contract')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (rule_id) REFERENCES risk_rules(id) ON DELETE CASCADE,
      FOREIGN KEY (conflict_id) REFERENCES detected_conflicts(id) ON DELETE CASCADE,
      FOREIGN KEY (cross_conflict_id) REFERENCES cross_contract_conflicts(id) ON DELETE CASCADE
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

  db.run(`
    CREATE TABLE IF NOT EXISTS contract_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      from_clause_id TEXT NOT NULL,
      to_clause_id TEXT NOT NULL,
      context TEXT NOT NULL,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, revision, from_clause_id, to_clause_id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS compliance_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tags TEXT NOT NULL DEFAULT '[]',
      check_type TEXT NOT NULL CHECK(check_type IN ('contains', 'numeric_range', 'duration_range', 'required_field')),
      check_params TEXT NOT NULL DEFAULT '{}',
      severity TEXT NOT NULL CHECK(severity IN ('critical', 'major', 'minor')),
      suggestion TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS compliance_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      clause_id TEXT,
      rule_id INTEGER NOT NULL,
      rule_name TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('critical', 'major', 'minor')),
      status TEXT NOT NULL CHECK(status IN ('violation', 'pass')),
      detail TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (rule_id) REFERENCES compliance_rules(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS negotiation_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      party TEXT NOT NULL CHECK(party IN ('甲方', '乙方')),
      clause_id TEXT NOT NULL,
      aspect TEXT NOT NULL CHECK(aspect IN ('amount', 'duration', 'percentage')),
      bottom_line REAL NOT NULL,
      ideal REAL NOT NULL,
      weight INTEGER NOT NULL CHECK(weight >= 1 AND weight <= 10),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, party, clause_id, aspect)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS negotiation_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      aspect TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('settled', 'deadlock')),
      agreed_value REAL,
      party_a_final REAL,
      party_b_final REAL,
      rounds INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, clause_id, aspect)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS contract_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      body_template TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '[]',
      auto_tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS execution_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      due_date TEXT NOT NULL,
      responsible_party TEXT NOT NULL CHECK(responsible_party IN ('甲方', '乙方')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'waived')),
      description TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      effective_date TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, clause_id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS execution_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('create', 'complete', 'waive', 'update')),
      operator TEXT NOT NULL DEFAULT 'system',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('upcoming', 'overdue')),
      due_date TEXT NOT NULL,
      responsible_party TEXT NOT NULL CHECK(responsible_party IN ('甲方', '乙方')),
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      scan_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(scan_date, contract_id, clause_id, type)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cost_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_tag TEXT NOT NULL,
      value_dimension TEXT NOT NULL CHECK(value_dimension IN ('amount', 'duration', 'percentage')),
      formula_type TEXT NOT NULL CHECK(formula_type IN ('linear', 'threshold')),
      params_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      template_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'rejected')),
      current_step INTEGER NOT NULL DEFAULT 0,
      initiator TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES workflow_templates(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      step_order INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('approve', 'reject', 'comment', 'start')),
      approver TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS search_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      clause_id TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      terms_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, clause_id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS semantic_triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      clause_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      action TEXT NOT NULL,
      object TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      UNIQUE(contract_id, revision, clause_id, subject, action, object)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cross_contract_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_a_id INTEGER NOT NULL,
      contract_b_id INTEGER NOT NULL,
      clause_a_id TEXT NOT NULL,
      clause_b_id TEXT NOT NULL,
      conflict_type TEXT NOT NULL CHECK(conflict_type IN ('contradiction','ambiguity','overlap','exclusivity_violation')),
      severity TEXT NOT NULL CHECK(severity IN ('critical','warning')),
      original_severity TEXT CHECK(original_severity IN ('critical','warning')),
      risk_propagated INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      scan_batch TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contract_a_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (contract_b_id) REFERENCES contracts(id) ON DELETE CASCADE
    );
  `);

  const conflictCols = db.exec("PRAGMA table_info(detected_conflicts)");
  const hasConflictRevision = conflictCols[0]?.values?.some(row => row[1] === 'revision');
  if (!hasConflictRevision) {
    db.run(`ALTER TABLE detected_conflicts ADD COLUMN revision INTEGER DEFAULT 1`);
  }
  const hasConflictOriginalSeverity = conflictCols[0]?.values?.some(row => row[1] === 'original_severity');
  if (!hasConflictOriginalSeverity) {
    db.run(`ALTER TABLE detected_conflicts ADD COLUMN original_severity TEXT CHECK(original_severity IN ('critical','warning'))`);
  }

  const riskCols = db.exec("PRAGMA table_info(risk_annotations)");
  const hasRiskRevision = riskCols[0]?.values?.some(row => row[1] === 'revision');
  if (!hasRiskRevision) {
    db.run(`ALTER TABLE risk_annotations ADD COLUMN revision INTEGER DEFAULT 1`);
  }
  const hasRiskSource = riskCols[0]?.values?.some(row => row[1] === 'source');
  if (!hasRiskSource) {
    db.run(`ALTER TABLE risk_annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'rule'`);
  }
  const hasRiskConflictId = riskCols[0]?.values?.some(row => row[1] === 'conflict_id');
  if (!hasRiskConflictId) {
    db.run(`ALTER TABLE risk_annotations ADD COLUMN conflict_id INTEGER`);
  }
  const hasRiskCrossConflictId = riskCols[0]?.values?.some(row => row[1] === 'cross_conflict_id');
  if (!hasRiskCrossConflictId) {
    db.run(`ALTER TABLE risk_annotations ADD COLUMN cross_conflict_id INTEGER`);
  }
  const riskColNames = riskCols[0]?.values?.map(row => row[1]) || [];
  if (riskColNames.includes('rule_id')) {
    const ruleIdCol = riskCols[0]?.values?.find(row => row[1] === 'rule_id');
    if (ruleIdCol && ruleIdCol[3] === 1) {
      const hasRuleIdNotNull = true;
    }
  }

  const negResultCols = db.exec("PRAGMA table_info(negotiation_results)");
  const colNames = negResultCols[0]?.values?.map(row => row[1]) || [];
  if (!colNames.includes('history_json')) {
    db.run(`ALTER TABLE negotiation_results ADD COLUMN history_json TEXT`);
  }
  if (!colNames.includes('strategy')) {
    db.run(`ALTER TABLE negotiation_results ADD COLUMN strategy TEXT`);
  }
  if (!colNames.includes('max_rounds')) {
    db.run(`ALTER TABLE negotiation_results ADD COLUMN max_rounds INTEGER`);
  }
  if (!colNames.includes('simulated_at')) {
    db.run(`ALTER TABLE negotiation_results ADD COLUMN simulated_at TEXT DEFAULT (datetime('now'))`);
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
