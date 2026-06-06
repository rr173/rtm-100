import React, { useState } from 'react';
import { resolveConflict } from '../api';

const SEVERITY_COLORS = { critical: '#dc2626', warning: '#f59e0b' };
const SEVERITY_LABELS = { critical: '严重', warning: '警告' };
const TYPE_LABELS = { contradiction: '矛盾', ambiguity: '歧义', overlap: '重叠' };

export default function ConflictCard({ conflict, allClauses, contractId, onResolved }) {
  const [resolving, setResolving] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [note, setNote] = useState('');
  const [resolved, setResolved] = useState(conflict.review_action !== null);
  const [currentAction, setCurrentAction] = useState(conflict.review_action?.action || null);

  const clauseA = allClauses.find(c => c.clause_id === conflict.clause_a_id);
  const clauseB = allClauses.find(c => c.clause_id === conflict.clause_b_id);

  const handleResolve = async (action) => {
    if (!reviewer.trim()) {
      alert('请输入审阅人姓名');
      return;
    }
    setResolving(true);
    try {
      await resolveConflict(contractId, conflict.id, {
        action,
        reviewer: reviewer.trim(),
        note: note.trim()
      });
      setResolved(true);
      setCurrentAction(action);
      onResolved();
    } catch (err) {
      alert('操作失败: ' + err.message);
    } finally {
      setResolving(false);
    }
  };

  const actionLabels = { confirm: '已确认', dismiss: '已驳回', modify: '待人工判定' };

  return (
    <div className="conflict-card" style={{ borderColor: SEVERITY_COLORS[conflict.severity] }}>
      <div className="conflict-card-header">
        <span className="conflict-type">{TYPE_LABELS[conflict.conflict_type]}</span>
        <span className="conflict-severity" style={{ color: SEVERITY_COLORS[conflict.severity] }}>
          {SEVERITY_LABELS[conflict.severity]}
          {conflict.risk_elevated && <span className="risk-elevated-badge"> (因高风险升级)</span>}
        </span>
        {resolved && currentAction && (
          <span className={`review-badge review-${currentAction}`}>
            {actionLabels[currentAction]}
          </span>
        )}
      </div>

      <div className="conflict-clauses">
        <div className="conflict-clause-a">
          <div className="conflict-clause-label">条款 {conflict.clause_a_id}</div>
          <div className="conflict-clause-title">{clauseA?.title || ''}</div>
          <div className="conflict-clause-body">{(clauseA?.body || '').substring(0, 80)}...</div>
        </div>
        <div className="conflict-vs">VS</div>
        <div className="conflict-clause-b">
          <div className="conflict-clause-label">条款 {conflict.clause_b_id}</div>
          <div className="conflict-clause-title">{clauseB?.title || ''}</div>
          <div className="conflict-clause-body">{(clauseB?.body || '').substring(0, 80)}...</div>
        </div>
      </div>

      <div className="conflict-reason">
        <strong>冲突原因:</strong> {conflict.reason}
      </div>

      {!resolved && (
        <div className="conflict-actions">
          <div className="review-inputs">
            <input
              type="text"
              placeholder="审阅人"
              value={reviewer}
              onChange={e => setReviewer(e.target.value)}
              className="review-input"
            />
            <input
              type="text"
              placeholder="备注(可选)"
              value={note}
              onChange={e => setNote(e.target.value)}
              className="review-input"
            />
          </div>
          <div className="review-buttons">
            <button
              className="btn btn-confirm"
              onClick={() => handleResolve('confirm')}
              disabled={resolving}
            >
              确认冲突
            </button>
            <button
              className="btn btn-dismiss"
              onClick={() => handleResolve('dismiss')}
              disabled={resolving}
            >
              驳回(误报)
            </button>
            <button
              className="btn btn-modify"
              onClick={() => handleResolve('modify')}
              disabled={resolving}
            >
              需人工判定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
