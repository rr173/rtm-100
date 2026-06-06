const express = require('express');
const cors = require('cors');
const { initDb, queryAll, queryOne, runSql, saveDb } = require('./database');
const { detectConflicts, deleteConflictDerivedRisks } = require('./conflictDetection');
const { annotateRisks, getClauseRiskLevel } = require('./riskAnnotation');
const { compareRevisions } = require('./textDiff');
const { seed } = require('./seed');
const { 
  analyzeDependencies, 
  saveDependencies, 
  getDependencies, 
  getImpactAnalysis,
  getModifiedClauseImpact
} = require('./clauseDependency');
const {
  createRule,
  getRules,
  deleteRule,
  auditContract,
  getAuditResults,
  batchAudit,
  getComplianceReport
} = require('./complianceEngine');
const {
  savePositions,
  getPositions,
  calculateNegotiationSpace,
  simulateNegotiation,
  generateReport,
  compareScenarios,
  recommendStrategy,
  getNegotiationHistory,
  debriefNegotiation
} = require('./negotiationEngine');
const {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  fillTemplateById,
  recommendTemplates
} = require('./templateEngine');
const {
  createExecutionPlan,
  getExecutionPlan,
  completeClause,
  waiveClause,
  getClauseHistory,
  getAlerts,
  getExecutionReport,
  scanNotifications,
  getNotifications,
  getNotificationStats,
  markNotificationRead,
  markAllRead
} = require('./executionTracker');
const {
  createCostModel,
  getCostModels,
  deleteCostModel,
  evaluateRevisionImpact,
  batchEvaluateImpact
} = require('./costEngine');
const {
  createWorkflowTemplate,
  getWorkflowTemplates,
  deleteWorkflowTemplate,
  startWorkflow,
  getWorkflowStatus,
  approveWorkflow,
  rejectWorkflow,
  commentWorkflow,
  getWorkflowHistory
} = require('./workflowEngine');
const {
  buildIndex,
  searchSimilar,
  detectPlagiarism
} = require('./searchEngine');
const {
  generateFingerprint,
  semanticDiff,
  getEvolutionChain
} = require('./semanticFingerprint');
const {
  scanCrossContractConflicts,
  getCrossContractScanResult
} = require('./crossContractConflict');

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

    const conflictsResult = detectConflicts(contractId);
    const risksResult = annotateRisks(contractId);

    res.json({
      contract_id: contractId,
      conflicts_detected: conflictsResult.conflicts.length,
      risks_annotated: risksResult.annotations.length
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
    const revision = parseInt(req.query.revision || '1');
    const conflicts = queryAll(
      'SELECT * FROM detected_conflicts WHERE contract_id = ? AND revision = ?',
      [req.params.id, revision]
    );

    const reviewActions = queryAll('SELECT * FROM review_actions');
    const actionMap = {};
    for (const a of reviewActions) {
      actionMap[a.conflict_id] = a;
    }

    const result = conflicts.map(c => ({
      ...c,
      risk_elevated: c.original_severity ? c.severity !== c.original_severity : false,
      review_action: actionMap[c.id] || null
    }));

    res.json(result);
  });

  app.get('/api/contracts/:id/risks', (req, res) => {
    const revision = parseInt(req.query.revision || '1');
    const annotations = queryAll(
      'SELECT * FROM risk_annotations WHERE contract_id = ? AND revision = ?',
      [req.params.id, revision]
    );
    const result = annotations.map(a => ({
      ...a,
      source: a.source || 'rule'
    }));
    res.json(result);
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

    if (action === 'dismiss') {
      deleteConflictDerivedRisks(parseInt(req.params.id), parseInt(req.params.conflictId), conflict.revision || 1);
    }

    if (existing) {
      runSql(
        "UPDATE review_actions SET action = ?, reviewer = ?, note = ?, created_at = datetime('now') WHERE id = ?",
        [action, reviewer, note || '', existing.id]
      );
      res.json({ id: existing.id, action, reviewer, note: note || '' });
    } else {
      const result = runSql(
        'INSERT INTO review_actions (conflict_id, action, reviewer, note) VALUES (?, ?, ?, ?)',
        [parseInt(req.params.conflictId), action, reviewer, note || '']
      );
      res.json({ id: result.lastInsertRowid, action, reviewer, note: note || '' });
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

    const result = runSql(
      'INSERT INTO conflict_rules (tag_a, tag_b, condition) VALUES (?, ?, ?)',
      [tag_a, tag_b, condition]
    );
    res.json({ id: result.lastInsertRowid, tag_a, tag_b, condition });
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

    const result = runSql(
      'INSERT INTO risk_rules (trigger_tags, condition, level, description) VALUES (?, ?, ?, ?)',
      [JSON.stringify(trigger_tags), condition, level, description]
    );
    res.json({ id: result.lastInsertRowid, trigger_tags, condition, level, description });
  });

  app.post('/api/contracts/:id/revisions', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { clauses } = req.body;

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    if (!Array.isArray(clauses) || clauses.length === 0) {
      return res.status(400).json({ error: 'clauses为必填项' });
    }

    const maxRevision = queryOne(
      'SELECT MAX(revision_number) as max_rev FROM contract_revisions WHERE contract_id = ?',
      [contractId]
    );
    
    let previousRevision = maxRevision?.max_rev || 0;
    let previousClauses = null;

    if (previousRevision === 0) {
      const currentClauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
      const clausesForJson = currentClauses.map(c => ({
        clause_id: c.clause_id,
        section: c.section,
        title: c.title,
        body: c.body,
        tags: JSON.parse(c.tags)
      }));
      runSql(
        'INSERT INTO contract_revisions (contract_id, revision_number, clauses_json) VALUES (?, ?, ?)',
        [contractId, 1, JSON.stringify(clausesForJson)]
      );
      previousRevision = 1;
      previousClauses = clausesForJson;
      
      const clausesForAnalyze = currentClauses.map(c => ({
        clause_id: c.clause_id,
        title: c.title,
        body: c.body
      }));
      const prevDeps = analyzeDependencies(contractId, 1, clausesForAnalyze);
      saveDependencies(prevDeps);
    } else {
      const prevData = queryOne(
        'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
        [contractId, previousRevision]
      );
      if (prevData) {
        previousClauses = JSON.parse(prevData.clauses_json);
      }
    }

    const clausesForStorage = clauses.map(c => ({
      clause_id: c.id || c.clause_id,
      section: c.section || 'default',
      title: c.title,
      body: c.body,
      tags: c.tags || []
    }));

    const newRevisionNumber = previousRevision + 1;

    runSql(
      'INSERT INTO contract_revisions (contract_id, revision_number, clauses_json) VALUES (?, ?, ?)',
      [contractId, newRevisionNumber, JSON.stringify(clausesForStorage)]
    );

    const clausesForDetection = clausesForStorage.map(c => ({
      clause_id: c.clause_id,
      section: c.section,
      title: c.title,
      body: c.body,
      tags: JSON.stringify(c.tags)
    }));

    const conflictsResult = detectConflicts(contractId, newRevisionNumber, clausesForDetection);
    const risksResult = annotateRisks(contractId, newRevisionNumber, clausesForDetection);

    const newDeps = analyzeDependencies(contractId, newRevisionNumber, clausesForStorage);
    saveDependencies(newDeps);

    let affectedClauses = [];
    if (previousClauses) {
      const modifiedClauseIds = [];
      const newClauseMap = {};
      for (const c of clausesForStorage) {
        newClauseMap[c.clause_id] = c;
      }
      for (const old of previousClauses) {
        const newClause = newClauseMap[old.clause_id];
        if (newClause && newClause.body !== old.body) {
          modifiedClauseIds.push(old.clause_id);
        }
      }

      if (modifiedClauseIds.length > 0) {
        affectedClauses = getModifiedClauseImpact(
          contractId,
          previousRevision,
          newRevisionNumber,
          modifiedClauseIds
        );
      }
    }

    res.json({
      contract_id: contractId,
      revision_number: newRevisionNumber,
      conflicts_detected: conflictsResult.conflicts.length,
      risks_annotated: risksResult.annotations.length,
      dependencies_count: newDeps.length,
      affected_clauses: affectedClauses
    });
  });

  app.get('/api/contracts/:id/revisions', (req, res) => {
    const contractId = parseInt(req.params.id);

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    const revisions = queryAll(
      `SELECT revision_number, created_at, clauses_json 
       FROM contract_revisions 
       WHERE contract_id = ? 
       ORDER BY revision_number ASC`,
      [contractId]
    );

    if (revisions.length === 0) {
      const currentClauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
      const clausesForJson = currentClauses.map(c => ({
        clause_id: c.clause_id,
        section: c.section,
        title: c.title,
        body: c.body,
        tags: JSON.parse(c.tags)
      }));
      runSql(
        'INSERT INTO contract_revisions (contract_id, revision_number, clauses_json, created_at) VALUES (?, ?, ?, ?)',
        [contractId, 1, JSON.stringify(clausesForJson), contract.created_at]
      );
      res.json([{
        revision_number: 1,
        created_at: contract.created_at,
        changed_clauses_count: 0
      }]);
      return;
    }

    const result = [];
    for (let i = 0; i < revisions.length; i++) {
      const rev = revisions[i];
      let changedCount = 0;

      if (i > 0) {
        const prevClauses = JSON.parse(revisions[i - 1].clauses_json);
        const currClauses = JSON.parse(rev.clauses_json);
        const comparison = compareRevisions(prevClauses, currClauses);
        changedCount = comparison.summary.added + comparison.summary.deleted + comparison.summary.modified;
      }

      result.push({
        revision_number: rev.revision_number,
        created_at: rev.created_at,
        changed_clauses_count: changedCount
      });
    }

    res.json(result);
  });

  app.get('/api/contracts/:id/revisions/:rev', (req, res) => {
    const contractId = parseInt(req.params.id);
    const revision = parseInt(req.params.rev);

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    const revisionData = queryOne(
      'SELECT * FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractId, revision]
    );

    if (!revisionData) return res.status(404).json({ error: '版本不存在' });

    const clauses = JSON.parse(revisionData.clauses_json);

    const clausesWithRisk = clauses.map(c => ({
      ...c,
      risk_level: getClauseRiskLevel(contractId, c.clause_id, revision)
    }));

    res.json({
      id: contract.id,
      title: contract.title,
      parties: JSON.parse(contract.parties),
      created_at: contract.created_at,
      revision_number: revision,
      clauses: clausesWithRisk
    });
  });

  app.get('/api/contracts/:id/diff', (req, res) => {
    const contractId = parseInt(req.params.id);
    const fromRev = parseInt(req.query.from || '1');
    const toRev = parseInt(req.query.to || '2');

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    if (fromRev >= toRev) {
      return res.status(400).json({ error: 'from版本必须小于to版本' });
    }

    const fromData = queryOne(
      'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractId, fromRev]
    );
    const toData = queryOne(
      'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractId, toRev]
    );

    if (!fromData || !toData) {
      return res.status(404).json({ error: '指定的版本不存在' });
    }

    const fromClauses = JSON.parse(fromData.clauses_json);
    const toClauses = JSON.parse(toData.clauses_json);

    const comparison = compareRevisions(fromClauses, toClauses);

    const fromRisks = queryAll(
      'SELECT level, COUNT(*) as count FROM risk_annotations WHERE contract_id = ? AND revision = ? GROUP BY level',
      [contractId, fromRev]
    );
    const toRisks = queryAll(
      'SELECT level, COUNT(*) as count FROM risk_annotations WHERE contract_id = ? AND revision = ? GROUP BY level',
      [contractId, toRev]
    );

    const riskMapFrom = {};
    const riskMapTo = {};
    for (const r of fromRisks) riskMapFrom[r.level] = r.count;
    for (const r of toRisks) riskMapTo[r.level] = r.count;

    const riskChanges = {
      high: (riskMapTo.high || 0) - (riskMapFrom.high || 0),
      medium: (riskMapTo.medium || 0) - (riskMapFrom.medium || 0),
      low: (riskMapTo.low || 0) - (riskMapFrom.low || 0)
    };

    const modifiedClauseIds = comparison.comparisons
      .filter(c => c.status === 'modified')
      .map(c => c.clause_id);

    const depsFrom = getDependencies(contractId, fromRev);
    const depsTo = getDependencies(contractId, toRev);
    
    const reverseGraph = {};
    const allDeps = [...depsFrom, ...depsTo];
    
    for (const dep of allDeps) {
      if (!reverseGraph[dep.to_clause_id]) {
        reverseGraph[dep.to_clause_id] = new Set();
      }
      reverseGraph[dep.to_clause_id].add(dep.from_clause_id);
    }

    const affectedClausesMap = {};
    const MAX_NODES = 50;

    for (const clauseId of modifiedClauseIds) {
      const visited = new Set();
      const queue = [];
      
      if (reverseGraph[clauseId]) {
        for (const neighbor of reverseGraph[clauseId]) {
          if (!visited.has(neighbor) && visited.size < MAX_NODES) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      
      while (queue.length > 0 && visited.size < MAX_NODES) {
        const id = queue.shift();
        
        if (reverseGraph[id]) {
          for (const neighbor of reverseGraph[id]) {
            if (!visited.has(neighbor) && visited.size < MAX_NODES) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
      }

      if (visited.size > 0) {
        affectedClausesMap[clauseId] = Array.from(visited);
      }
    }

    res.json({
      from_revision: fromRev,
      to_revision: toRev,
      comparisons: comparison.comparisons,
      summary: comparison.summary,
      risk_changes: riskChanges,
      affected_clauses_map: affectedClausesMap
    });
  });

  app.post('/api/contracts/:id/analyze-deps', (req, res) => {
    const contractId = parseInt(req.params.id);
    const revision = parseInt(req.body.revision || '1');

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    let clauses;
    if (revision === 1) {
      clauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
      clauses = clauses.map(c => ({
        clause_id: c.clause_id,
        title: c.title,
        body: c.body
      }));
    } else {
      const revisionData = queryOne(
        'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
        [contractId, revision]
      );
      if (!revisionData) return res.status(404).json({ error: '版本不存在' });
      clauses = JSON.parse(revisionData.clauses_json);
    }

    const deps = analyzeDependencies(contractId, revision, clauses);
    const count = saveDependencies(deps);

    res.json({
      contract_id: contractId,
      revision: revision,
      dependencies_count: count
    });
  });

  app.get('/api/contracts/:id/deps', (req, res) => {
    const contractId = parseInt(req.params.id);
    const revision = parseInt(req.query.revision || '1');

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    let clauses;
    if (revision === 1) {
      clauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
      clauses = clauses.map(c => ({
        clause_id: c.clause_id,
        title: c.title
      }));
    } else {
      const revisionData = queryOne(
        'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
        [contractId, revision]
      );
      if (!revisionData) return res.status(404).json({ error: '版本不存在' });
      const parsed = JSON.parse(revisionData.clauses_json);
      clauses = parsed.map(c => ({
        clause_id: c.clause_id,
        title: c.title
      }));
    }

    const deps = getDependencies(contractId, revision);

    res.json({
      nodes: clauses,
      edges: deps.map(d => ({
        from: d.from_clause_id,
        to: d.to_clause_id,
        context: d.context
      }))
    });
  });

  app.get('/api/contracts/:id/impact', (req, res) => {
    const contractId = parseInt(req.params.id);
    const revision = parseInt(req.query.revision || '1');
    const clauseId = req.query.clause_id;

    const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    if (!clauseId) {
      return res.status(400).json({ error: 'clause_id为必填项' });
    }

    const result = getImpactAnalysis(contractId, revision, clauseId);
    res.json(result);
  });

  app.post('/api/compliance/rules', (req, res) => {
    try {
      const rule = createRule(req.body);
      res.json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/compliance/rules', (req, res) => {
    const targetTag = req.query.target_tag;
    const rules = getRules(targetTag);
    res.json(rules);
  });

  app.delete('/api/compliance/rules/:id', (req, res) => {
    const deleted = deleteRule(req.params.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '规则不存在' });
    }
  });

  app.post('/api/compliance/audit', (req, res) => {
    const { contract_id, revision } = req.body;
    if (!contract_id) {
      return res.status(400).json({ error: 'contract_id为必填项' });
    }

    try {
      const findings = auditContract(contract_id, revision || 1);
      res.json(findings);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/compliance/audits/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const revision = parseInt(req.query.revision || '1');

    try {
      const findings = getAuditResults(contractId, revision);
      res.json(findings);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/compliance/audit/batch', (req, res) => {
    const { contract_ids } = req.body;
    if (!Array.isArray(contract_ids) || contract_ids.length === 0) {
      return res.status(400).json({ error: 'contract_ids为必填数组' });
    }

    const result = batchAudit(contract_ids);
    res.json(result);
  });

  app.get('/api/compliance/report/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const revision = parseInt(req.query.revision || '1');

    try {
      const report = getComplianceReport(contractId, revision);
      res.json(report);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/negotiation/positions', (req, res) => {
    const { contract_id, party, positions } = req.body;

    if (!contract_id || !party || !Array.isArray(positions)) {
      return res.status(400).json({ error: 'contract_id, party, positions为必填项' });
    }

    if (!['甲方', '乙方'].includes(party)) {
      return res.status(400).json({ error: 'party必须是"甲方"或"乙方"' });
    }

    for (const pos of positions) {
      if (!pos.clause_id || !pos.aspect || pos.bottom_line === undefined || pos.ideal === undefined || pos.weight === undefined) {
        return res.status(400).json({ error: '每个position必须包含clause_id, aspect, bottom_line, ideal, weight' });
      }
      if (!['amount', 'duration', 'percentage'].includes(pos.aspect)) {
        return res.status(400).json({ error: 'aspect必须是amount/duration/percentage之一' });
      }
      if (pos.weight < 1 || pos.weight > 10) {
        return res.status(400).json({ error: 'weight必须在1-10之间' });
      }
    }

    const result = savePositions(contract_id, party, positions);
    res.json(result);
  });

  app.get('/api/negotiation/positions/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const positions = getPositions(contractId);
    res.json(positions);
  });

  app.get('/api/negotiation/space/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const space = calculateNegotiationSpace(contractId);
    res.json(space);
  });

  app.post('/api/negotiation/simulate', (req, res) => {
    const { contract_id, max_rounds, strategy } = req.body;

    if (!contract_id) {
      return res.status(400).json({ error: 'contract_id为必填项' });
    }

    if (max_rounds !== undefined && (!Number.isInteger(max_rounds) || max_rounds < 1)) {
      return res.status(400).json({ error: 'max_rounds必须是正整数' });
    }

    if (strategy !== undefined && !['balanced', 'aggressive', 'conservative'].includes(strategy)) {
      return res.status(400).json({ error: 'strategy必须是balanced/aggressive/conservative之一' });
    }

    const result = simulateNegotiation(
      contract_id,
      max_rounds || 5,
      strategy || 'balanced'
    );
    res.json(result);
  });

  app.get('/api/negotiation/report/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const report = generateReport(contractId);
    res.json(report);
  });

  app.post('/api/negotiation/compare', (req, res) => {
    const { contract_id, scenarios } = req.body;

    if (!contract_id) {
      return res.status(400).json({ error: 'contract_id为必填项' });
    }
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return res.status(400).json({ error: 'scenarios为必填数组' });
    }

    for (const scenario of scenarios) {
      if (!scenario.name) {
        return res.status(400).json({ error: '每个scenario必须包含name' });
      }
      if (scenario.max_rounds !== undefined && (!Number.isInteger(scenario.max_rounds) || scenario.max_rounds < 1)) {
        return res.status(400).json({ error: 'max_rounds必须是正整数' });
      }
      if (scenario.strategy !== undefined && !['balanced', 'aggressive', 'conservative'].includes(scenario.strategy)) {
        return res.status(400).json({ error: 'strategy必须是balanced/aggressive/conservative之一' });
      }
      if (scenario.weight_adjustments !== undefined && typeof scenario.weight_adjustments !== 'object') {
        return res.status(400).json({ error: 'weight_adjustments必须是对象' });
      }
    }

    const result = compareScenarios(contract_id, scenarios);
    res.json(result);
  });

  app.get('/api/negotiation/recommend/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const result = recommendStrategy(contractId);
    res.json(result);
  });

  app.get('/api/negotiation/history/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const history = getNegotiationHistory(contractId);
    if (!history) {
      return res.status(404).json({ error: '未找到该合同的谈判模拟记录' });
    }
    res.json(history);
  });

  app.get('/api/negotiation/debrief/:contractId', (req, res) => {
    const contractId = parseInt(req.params.contractId);
    const debrief = debriefNegotiation(contractId);
    if (!debrief) {
      return res.status(404).json({ error: '未找到该合同的谈判模拟记录,请先运行模拟' });
    }
    res.json(debrief);
  });

  app.post('/api/templates', (req, res) => {
    try {
      const template = createTemplate(req.body);
      res.json(template);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/templates', (req, res) => {
    const category = req.query.category || null;
    const templates = getTemplates(category);
    res.json(templates);
  });

  app.get('/api/templates/recommend', (req, res) => {
    const existingTags = req.query.existing_tags
      ? req.query.existing_tags.split(',').filter(t => t.trim() !== '')
      : [];
    const recommendations = recommendTemplates(existingTags);
    res.json(recommendations);
  });

  app.get('/api/templates/:id', (req, res) => {
    const template = getTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: '模板不存在' });
    }
    res.json(template);
  });

  app.put('/api/templates/:id', (req, res) => {
    try {
      const template = updateTemplate(req.params.id, req.body);
      if (!template) {
        return res.status(404).json({ error: '模板不存在' });
      }
      res.json(template);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    const deleted = deleteTemplate(req.params.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '模板不存在' });
    }
  });

  app.post('/api/templates/:id/fill', (req, res) => {
    const { params } = req.body;
    const result = fillTemplateById(req.params.id, params || {});
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json(result);
  });

  app.post('/api/contracts/generate', (req, res) => {
    const { title, parties, template_selections } = req.body;

    if (!title || !Array.isArray(template_selections) || template_selections.length === 0) {
      return res.status(400).json({ error: 'title和template_selections为必填项' });
    }

    const clauseIdSet = new Set();
    for (const selection of template_selections) {
      if (!selection.template_id || !selection.clause_id) {
        return res.status(400).json({ error: '每个template_selection必须包含template_id和clause_id' });
      }
      if (!selection.title) {
        return res.status(400).json({ error: `clause_id="${selection.clause_id}"缺少title字段,条款标题为必填项` });
      }
      if (clauseIdSet.has(selection.clause_id)) {
        return res.status(400).json({ error: `clause_id"${selection.clause_id}"重复,条款编号必须唯一` });
      }
      clauseIdSet.add(selection.clause_id);
    }

    const generatedClauses = [];
    const allWarnings = [];

    for (const selection of template_selections) {
      const fillResult = fillTemplateById(selection.template_id, selection.params || {});
      if (fillResult.error) {
        return res.status(fillResult.status || 400).json({
          error: `模板填充失败(clause_id=${selection.clause_id}): ${fillResult.error}`
        });
      }

      if (fillResult.warnings && fillResult.warnings.length > 0) {
        for (const w of fillResult.warnings) {
          allWarnings.push(`[${selection.clause_id}] ${w}`);
        }
      }

      generatedClauses.push({
        id: selection.clause_id,
        clause_id: selection.clause_id,
        section: selection.section || 'default',
        title: selection.title,
        body: fillResult.filled_body,
        tags: fillResult.tags
      });
    }

    const contractResult = runSql(
      'INSERT INTO contracts (title, parties) VALUES (?, ?)',
      [title, JSON.stringify(parties || [])]
    );

    const contractId = contractResult.lastInsertRowid;

    for (const c of generatedClauses) {
      runSql(
        'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
        [contractId, c.clause_id, c.section, c.title, c.body, JSON.stringify(c.tags || [])]
      );
    }

    const conflictsResult = detectConflicts(contractId);
    const risksResult = annotateRisks(contractId);
    const complianceFindings = auditContract(contractId);
    const complianceViolations = complianceFindings.filter(f => f.status === 'violation');

    res.json({
      contract_id: contractId,
      clauses_count: generatedClauses.length,
      conflicts_detected: conflictsResult.conflicts.length,
      risks_annotated: risksResult.annotations.length,
      compliance_violations: complianceViolations.length,
      warnings: allWarnings
    });
  });

  app.post('/api/contracts/:id/execution-plan', (req, res) => {
    const contractId = parseInt(req.params.id);
    try {
      const result = createExecutionPlan(contractId, req.body);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/execution-plan', (req, res) => {
    const contractId = parseInt(req.params.id);
    try {
      const result = getExecutionPlan(contractId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/execution/:clauseId/complete', (req, res) => {
    const contractId = parseInt(req.params.id);
    const clauseId = req.params.clauseId;
    const operator = req.body?.operator || 'system';
    try {
      const result = completeClause(contractId, clauseId, operator);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/execution/:clauseId/waive', (req, res) => {
    const contractId = parseInt(req.params.id);
    const clauseId = req.params.clauseId;
    const reason = req.body?.reason;
    const operator = req.body?.operator || 'system';
    try {
      const result = waiveClause(contractId, clauseId, reason, operator);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/execution/:clauseId/history', (req, res) => {
    const contractId = parseInt(req.params.id);
    const clauseId = req.params.clauseId;
    try {
      const result = getClauseHistory(contractId, clauseId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/execution/alerts', (req, res) => {
    const contractId = parseInt(req.params.id);
    const date = req.query.date;
    try {
      const result = getAlerts(contractId, date);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/execution/report', (req, res) => {
    const contractId = parseInt(req.params.id);
    try {
      const result = getExecutionReport(contractId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/notifications/scan', (req, res) => {
    try {
      const date = req.body?.date;
      const result = scanNotifications(date);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/notifications', (req, res) => {
    try {
      const filters = {
        party: req.query.party,
        type: req.query.type,
        contract_id: req.query.contract_id ? parseInt(req.query.contract_id) : undefined,
        include_read: req.query.include_read
      };
      const result = getNotifications(filters);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/notifications/stats', (req, res) => {
    try {
      const result = getNotificationStats();
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/notifications/:id/read', (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const result = markNotificationRead(id);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/notifications/read-all', (req, res) => {
    try {
      const contractId = req.body?.contract_id ? parseInt(req.body.contract_id) : undefined;
      const result = markAllRead(contractId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/cost-models', (req, res) => {
    try {
      const model = createCostModel(req.body);
      res.json(model);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/cost-models', (req, res) => {
    const models = getCostModels();
    res.json(models);
  });

  app.delete('/api/cost-models/:id', (req, res) => {
    const deleted = deleteCostModel(req.params.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '成本模型不存在' });
    }
  });

  app.post('/api/contracts/:id/cost-impact', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { from_revision, to_revision } = req.body;

    if (!from_revision || !to_revision) {
      return res.status(400).json({ error: 'from_revision和to_revision为必填项' });
    }
    if (from_revision >= to_revision) {
      return res.status(400).json({ error: 'from_revision必须小于to_revision' });
    }

    try {
      const result = evaluateRevisionImpact(contractId, from_revision, to_revision);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/cost-impact/batch', (req, res) => {
    const { contract_ids, from_revision, to_revision } = req.body;

    if (!Array.isArray(contract_ids) || contract_ids.length === 0) {
      return res.status(400).json({ error: 'contract_ids为必填数组' });
    }
    if (!from_revision || !to_revision) {
      return res.status(400).json({ error: 'from_revision和to_revision为必填项' });
    }
    if (from_revision >= to_revision) {
      return res.status(400).json({ error: 'from_revision必须小于to_revision' });
    }

    const result = batchEvaluateImpact(contract_ids, from_revision, to_revision);
    res.json(result);
  });

  app.post('/api/workflow/templates', (req, res) => {
    try {
      const { name, steps } = req.body;
      const template = createWorkflowTemplate(name, steps);
      res.json(template);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/workflow/templates', (req, res) => {
    const templates = getWorkflowTemplates();
    res.json(templates);
  });

  app.delete('/api/workflow/templates/:id', (req, res) => {
    const deleted = deleteWorkflowTemplate(req.params.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '审批链模板不存在' });
    }
  });

  app.post('/api/contracts/:id/workflow/start', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { template_id, initiator } = req.body;

    if (!template_id) {
      return res.status(400).json({ error: 'template_id为必填项' });
    }

    try {
      const status = startWorkflow(contractId, template_id, initiator);
      res.json(status);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/workflow', (req, res) => {
    const contractId = parseInt(req.params.id);
    const status = getWorkflowStatus(contractId);
    if (!status) {
      return res.status(404).json({ error: '该合同暂无工作流记录' });
    }
    res.json(status);
  });

  app.post('/api/contracts/:id/workflow/approve', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { approver, comment } = req.body;

    try {
      const status = approveWorkflow(contractId, approver, comment);
      res.json(status);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/workflow/reject', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { approver, reason } = req.body;

    try {
      const status = rejectWorkflow(contractId, approver, reason);
      res.json(status);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/workflow/comment', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { approver, comment } = req.body;

    try {
      const status = commentWorkflow(contractId, approver, comment);
      res.json(status);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/workflow/history', (req, res) => {
    const contractId = parseInt(req.params.id);
    const history = getWorkflowHistory(contractId);
    res.json(history);
  });

  app.post('/api/search/index', (req, res) => {
    try {
      const { contract_id } = req.body;
      const result = buildIndex(contract_id ? parseInt(contract_id) : undefined);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/search/query', (req, res) => {
    try {
      const { text, top_k, min_score, exclude_contract_id } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'text为必填项' });
      }
      const result = searchSimilar(
        text,
        top_k !== undefined ? parseInt(top_k) : 5,
        min_score !== undefined ? parseFloat(min_score) : 0.1,
        exclude_contract_id ? parseInt(exclude_contract_id) : undefined
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/search/plagiarism', (req, res) => {
    try {
      const { contract_id, threshold } = req.body;
      if (!contract_id) {
        return res.status(400).json({ error: 'contract_id为必填项' });
      }
      const result = detectPlagiarism(
        parseInt(contract_id),
        threshold !== undefined ? parseFloat(threshold) : 0.7
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/fingerprint', (req, res) => {
    const contractId = parseInt(req.params.id);
    const revision = req.body?.revision ? parseInt(req.body.revision) : undefined;

    try {
      const result = generateFingerprint(contractId, revision);
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/contracts/:id/semantic-diff', (req, res) => {
    const contractId = parseInt(req.params.id);
    const { from_revision, to_revision } = req.body;

    try {
      const result = semanticDiff(
        contractId,
        from_revision !== undefined ? parseInt(from_revision) : undefined,
        to_revision !== undefined ? parseInt(to_revision) : undefined
      );
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/contracts/:id/evolution', (req, res) => {
    const contractId = parseInt(req.params.id);
    const clauseId = req.query.clause_id;

    try {
      const result = getEvolutionChain(contractId, clauseId);
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/cross-contract/scan', (req, res) => {
    const { contract_ids, revision } = req.body;
    if (!Array.isArray(contract_ids) || contract_ids.length < 2) {
      return res.status(400).json({ error: 'contract_ids为必填数组,至少包含2份合同ID' });
    }

    const result = scanCrossContractConflicts(contract_ids, parseInt(revision || '1'));
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json(result);
  });

  app.get('/api/cross-contract/scan/:batchId', (req, res) => {
    const result = getCrossContractScanResult(req.params.batchId);
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json(result);
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
