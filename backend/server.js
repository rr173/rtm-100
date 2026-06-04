const express = require('express');
const cors = require('cors');
const { initDb, queryAll, queryOne, runSql, saveDb } = require('./database');
const { detectConflicts } = require('./conflictDetection');
const { annotateRisks, getClauseRiskLevel } = require('./riskAnnotation');
const { seed } = require('./seed');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

async function startServer() {
  await initDb();
  seed();

  app.post('/api/contracts', (req, res) => {
    const { title, parties, clauses } = req.body;

    if (!title || !Array.isArray(clauses) || clauses.length === 0) {
      return res.status(400).json({ error: 'title和clauses为必填项' });
    }

    const contractResult = runSql(
      'INSERT INTO contracts (title, parties) VALUES (?, ?)',
      [title, JSON.stringify(parties || [])]
    );

    const contractId = contractResult.lastInsertRowid;

    for (const c of clauses) {
      runSql(
        'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
        [contractId, c.id, c.section || 'default', c.title, c.body, JSON.stringify(c.tags || [])]
      );
    }

    const conflicts = detectConflicts(contractId);
    const annotations = annotateRisks(contractId);

    res.json({
      contract_id: contractId,
      conflicts_detected: conflicts.length,
      risks_annotated: annotations.length
    });
  });

  app.get('/api/contracts', (req, res) => {
    const contracts = queryAll('SELECT * FROM contracts ORDER BY created_at DESC');
    res.json(contracts.map(c => ({ ...c, parties: JSON.parse(c.parties) })));
  });

  app.get('/api/contracts/:id', (req, res) => {
    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [req.params.id]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    const clauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [req.params.id]);

    contract.parties = JSON.parse(contract.parties);
    contract.clauses = clauses.map(c => ({
      ...c,
      tags: JSON.parse(c.tags),
      risk_level: getClauseRiskLevel(parseInt(req.params.id), c.clause_id)
    }));

    res.json(contract);
  });

  app.get('/api/contracts/:id/conflicts', (req, res) => {
    const conflicts = queryAll(
      'SELECT * FROM detected_conflicts WHERE contract_id = ?',
      [req.params.id]
    );

    const reviewActions = queryAll('SELECT * FROM review_actions');
    const actionMap = {};
    for (const a of reviewActions) {
      actionMap[a.conflict_id] = a;
    }

    const result = conflicts.map(c => ({
      ...c,
      review_action: actionMap[c.id] || null
    }));

    res.json(result);
  });

  app.get('/api/contracts/:id/risks', (req, res) => {
    const annotations = queryAll(
      'SELECT * FROM risk_annotations WHERE contract_id = ?',
      [req.params.id]
    );
    res.json(annotations);
  });

  app.post('/api/contracts/:id/conflicts/:conflictId/resolve', (req, res) => {
    const { action, reviewer, note } = req.body;

    if (!['confirm', 'dismiss', 'modify'].includes(action)) {
      return res.status(400).json({ error: 'action必须是confirm/dismiss/modify之一' });
    }
    if (!reviewer) {
      return res.status(400).json({ error: 'reviewer为必填项' });
    }

    const conflict = queryOne(
      'SELECT * FROM detected_conflicts WHERE id = ? AND contract_id = ?',
      [req.params.conflictId, req.params.id]
    );

    if (!conflict) return res.status(404).json({ error: '冲突记录不存在' });

    const existing = queryOne(
      'SELECT * FROM review_actions WHERE conflict_id = ?',
      [req.params.conflictId]
    );

    if (existing) {
      runSql(
        "UPDATE review_actions SET action = ?, reviewer = ?, note = ?, created_at = datetime('now') WHERE id = ?",
        [action, reviewer, note || '', existing.id]
      );
      res.json({ id: existing.id, action, reviewer, note: note || '' });
    } else {
      runSql(
        'INSERT INTO review_actions (conflict_id, action, reviewer, note) VALUES (?, ?, ?, ?)',
        [parseInt(req.params.conflictId), action, reviewer, note || '']
      );
      const row = queryOne('SELECT last_insert_rowid() as id');
      res.json({ id: row.id, action, reviewer, note: note || '' });
    }
  });

  app.get('/api/contracts/:id/review-status', (req, res) => {
    const total = queryOne(
      'SELECT COUNT(*) as cnt FROM detected_conflicts WHERE contract_id = ?',
      [req.params.id]
    );

    const actions = queryAll(`
      SELECT ra.action
      FROM review_actions ra
      JOIN detected_conflicts dc ON ra.conflict_id = dc.id
      WHERE dc.contract_id = ?
    `, [req.params.id]);

    const confirmed = actions.filter(a => a.action === 'confirm').length;
    const dismissed = actions.filter(a => a.action === 'dismiss').length;
    const modified = actions.filter(a => a.action === 'modify').length;
    const reviewed = confirmed + dismissed + modified;
    const pending = total.cnt - reviewed;

    res.json({
      total_conflicts: total.cnt,
      confirmed,
      dismissed,
      modified,
      pending,
      review_percentage: total.cnt > 0 ? Math.round((reviewed / total.cnt) * 100) : 0
    });
  });

  app.get('/api/rules/conflicts', (req, res) => {
    const rules = queryAll('SELECT * FROM conflict_rules');
    res.json(rules);
  });

  app.post('/api/rules/conflicts', (req, res) => {
    const { tag_a, tag_b, condition } = req.body;
    if (!tag_a || !tag_b || !condition) {
      return res.status(400).json({ error: 'tag_a, tag_b, condition为必填项' });
    }

    runSql(
      'INSERT INTO conflict_rules (tag_a, tag_b, condition) VALUES (?, ?, ?)',
      [tag_a, tag_b, condition]
    );
    const row = queryOne('SELECT last_insert_rowid() as id');
    res.json({ id: row.id, tag_a, tag_b, condition });
  });

  app.get('/api/rules/risks', (req, res) => {
    const rules = queryAll('SELECT * FROM risk_rules');
    res.json(rules.map(r => ({ ...r, trigger_tags: JSON.parse(r.trigger_tags) })));
  });

  app.post('/api/rules/risks', (req, res) => {
    const { trigger_tags, condition, level, description } = req.body;
    if (!trigger_tags || !condition || !level || !description) {
      return res.status(400).json({ error: 'trigger_tags, condition, level, description为必填项' });
    }
    if (!['high', 'medium', 'low'].includes(level)) {
      return res.status(400).json({ error: 'level必须是high/medium/low之一' });
    }

    runSql(
      'INSERT INTO risk_rules (trigger_tags, condition, level, description) VALUES (?, ?, ?, ?)',
      [JSON.stringify(trigger_tags), condition, level, description]
    );
    const row = queryOne('SELECT last_insert_rowid() as id');
    res.json({ id: row.id, trigger_tags, condition, level, description });
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Contract review backend running on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
