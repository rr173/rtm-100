import React from 'react';
import ConflictCard from './ConflictCard';

const LEVEL_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
const LEVEL_LABELS = { high: '高风险', medium: '中风险', low: '低风险' };
const SOURCE_LABELS = { rule: '规则命中', conflict: '冲突派生' };

function highlightNumbers(text) {
  const parts = [];
  const regex = /(\d+(?:\.\d+)?\s*(?:万元|元|个月|年|天|日|%))/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    parts.push(<mark key={match.index} className="number-highlight">{match[0]}</mark>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

export default function ClauseDetail({ clause, conflicts, risks, allClauses, contractId, onConflictResolved }) {
  return (
    <div className="clause-detail">
      <div className="clause-header">
        <h2>{clause.clause_id} - {clause.title}</h2>
        <div className="clause-meta">
          <span className="clause-section">{clause.section}</span>
        </div>
      </div>

      <div className="clause-body">
        <h4>条款正文</h4>
        <p>{highlightNumbers(clause.body)}</p>
      </div>

      <div className="clause-tags">
        <h4>语义标签</h4>
        <div className="tag-list">
          {clause.tags.map(tag => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      </div>

      {risks.length > 0 && (
        <div className="clause-risks">
          <h4>风险标注</h4>
          <div className="risk-list">
            {risks.map(risk => (
              <div key={risk.id} className="risk-item" style={{ borderLeftColor: LEVEL_COLORS[risk.level] }}>
                <div className="risk-level" style={{ color: LEVEL_COLORS[risk.level] }}>
                  {LEVEL_LABELS[risk.level]}
                </div>
                <div className="risk-source-tag">{SOURCE_LABELS[risk.source || 'rule']}</div>
                <div className="risk-reason">{risk.trigger_reason}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="clause-conflicts">
          <h4>关联冲突 ({conflicts.length})</h4>
          <div className="conflict-list">
            {conflicts.map(conflict => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                allClauses={allClauses}
                contractId={contractId}
                onResolved={onConflictResolved}
              />
            ))}
          </div>
        </div>
      )}

      {risks.length === 0 && conflicts.length === 0 && (
        <div className="no-issues">
          <p>该条款未检测到风险或冲突</p>
        </div>
      )}
    </div>
  );
}
