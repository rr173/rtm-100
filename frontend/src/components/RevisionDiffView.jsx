import React, { useState } from 'react';

function renderDiffBody(diff, isOld) {
  if (!diff || !diff.sentences) {
    return null;
  }

  return diff.sentences.map((sentence, idx) => {
    let className = 'diff-sentence';
    if (isOld && sentence.type === 'deleted') {
      className += ' deleted';
    } else if (!isOld && sentence.type === 'added') {
      className += ' added';
    } else if (sentence.type === 'unchanged') {
    } else {
      return null;
    }
    return (
      <span key={idx} className={className}>
        {sentence.value}
      </span>
    );
  });
}

function ImpactBadge({ affectedClauses }) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div 
      className="impact-badge-wrapper"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className="impact-badge">
        影响 {affectedClauses.length} 个条款
      </span>
      {showTooltip && (
        <div className="impact-tooltip">
          <div className="impact-tooltip-title">受影响的条款:</div>
          <div className="impact-tooltip-list">
            {affectedClauses.map((id, i) => (
              <span key={i} className="impact-tooltip-item">{id}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RevisionDiffView({ diffData }) {
  if (!diffData) {
    return <div className="loading">加载对比数据中...</div>;
  }

  const { comparisons, summary, risk_changes, affected_clauses_map = {} } = diffData;

  const leftClauses = [];
  const rightClauses = [];

  for (const comp of comparisons) {
    if (comp.status === 'added') {
      leftClauses.push({ clause_id: comp.clause_id, empty: true });
      rightClauses.push({ clause_id: comp.clause_id, data: comp, status: 'added' });
    } else if (comp.status === 'deleted') {
      leftClauses.push({ clause_id: comp.clause_id, data: comp, status: 'deleted' });
      rightClauses.push({ clause_id: comp.clause_id, empty: true });
    } else {
      leftClauses.push({ clause_id: comp.clause_id, data: comp, status: comp.status });
      rightClauses.push({ clause_id: comp.clause_id, data: comp, status: comp.status });
    }
  }

  const getStatusBadge = (status) => {
    if (status === 'unchanged') return null;
    const labels = { added: '新增', deleted: '删除', modified: '修改' };
    return <span className={`status-badge ${status}`}>{labels[status]}</span>;
  };

  const formatRiskChange = (value) => {
    if (value > 0) {
      return <span className="risk-change-value positive">+{value}</span>;
    } else if (value < 0) {
      return <span className="risk-change-value negative">{value}</span>;
    }
    return <span className="risk-change-value neutral">0</span>;
  };

  return (
    <div className="diff-view">
      <div className="diff-header">
        <div className="diff-header-col">版本 {diffData.from_revision} (旧版)</div>
        <div className="diff-header-col">版本 {diffData.to_revision} (新版)</div>
      </div>
      <div className="diff-content">
        <div className="diff-col">
          {leftClauses.map((item, idx) => (
            <div key={idx} className={`diff-clause ${item.empty ? 'empty' : item.status || ''}`}>
              {item.empty ? null : (
                <>
                  <div className="diff-clause-title">
                    <span className="diff-clause-id">{item.data.clause_id}</span>
                    {item.data.title}
                    {getStatusBadge(item.status)}
                    {affected_clauses_map[item.data.clause_id] && (
                      <ImpactBadge affectedClauses={affected_clauses_map[item.data.clause_id]} />
                    )}
                  </div>
                  <div className="diff-body">
                    {item.status === 'modified'
                      ? renderDiffBody(item.data.diff, true)
                      : item.data.old_body}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="diff-col">
          {rightClauses.map((item, idx) => (
            <div key={idx} className={`diff-clause ${item.empty ? 'empty' : item.status || ''}`}>
              {item.empty ? null : (
                <>
                  <div className="diff-clause-title">
                    <span className="diff-clause-id">{item.data.clause_id}</span>
                    {item.data.title}
                    {getStatusBadge(item.status)}
                    {affected_clauses_map[item.data.clause_id] && (
                      <ImpactBadge affectedClauses={affected_clauses_map[item.data.clause_id]} />
                    )}
                  </div>
                  <div className="diff-body">
                    {item.status === 'modified'
                      ? renderDiffBody(item.data.diff, false)
                      : item.data.new_body}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="diff-summary">
        <div className="summary-item">
          <span className="summary-count added">{summary.added}</span>
          <span className="summary-label">新增条款</span>
        </div>
        <div className="summary-item">
          <span className="summary-count deleted">{summary.deleted}</span>
          <span className="summary-label">删除条款</span>
        </div>
        <div className="summary-item">
          <span className="summary-count modified">{summary.modified}</span>
          <span className="summary-label">修改条款</span>
        </div>
        {risk_changes && (
          <div className="risk-change">
            <span style={{ fontSize: '13px', color: '#6b7280', marginRight: '8px' }}>风险变化:</span>
            <div className="risk-change-item">
              <span style={{ color: '#dc2626' }}>高风险</span>
              {formatRiskChange(risk_changes.high)}
            </div>
            <div className="risk-change-item">
              <span style={{ color: '#d97706' }}>中风险</span>
              {formatRiskChange(risk_changes.medium)}
            </div>
            <div className="risk-change-item">
              <span style={{ color: '#6b7280' }}>低风险</span>
              {formatRiskChange(risk_changes.low)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
