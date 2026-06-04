import React, { useState } from 'react';

const RISK_DOT = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e', null: '#9ca3af' };

export default function ContractTree({ clauses, selectedClauseId, onSelectClause, getConflictCountForClause }) {
  const [collapsed, setCollapsed] = useState({});

  const sections = [];
  const sectionMap = {};
  for (const c of clauses) {
    if (!sectionMap[c.section]) {
      sectionMap[c.section] = [];
      sections.push(c.section);
    }
    sectionMap[c.section].push(c);
  }

  const toggleSection = (section) => {
    setCollapsed(prev => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="contract-tree">
      <h3>合同条款</h3>
      {sections.map(section => (
        <div key={section} className="tree-section">
          <div
            className="section-header"
            onClick={() => toggleSection(section)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && toggleSection(section)}
          >
            <span className="section-toggle">{collapsed[section] ? '▶' : '▼'}</span>
            <span className="section-name">{section}</span>
            <span className="section-count">{sectionMap[section].length}</span>
          </div>
          {!collapsed[section] && (
            <div className="section-clauses">
              {sectionMap[section].map(clause => {
                const conflictCount = getConflictCountForClause(clause.clause_id);
                return (
                  <div
                    key={clause.clause_id}
                    className={`clause-item ${selectedClauseId === clause.clause_id ? 'selected' : ''}`}
                    onClick={() => onSelectClause(clause.clause_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && onSelectClause(clause.clause_id)}
                  >
                    <span
                      className="risk-dot"
                      style={{ backgroundColor: RISK_DOT[clause.risk_level] || RISK_DOT[null] }}
                      title={clause.risk_level ? `${clause.risk_level}风险` : '无风险'}
                    />
                    <span className="clause-id">{clause.clause_id}</span>
                    <span className="clause-title">{clause.title}</span>
                    {conflictCount > 0 && (
                      <span className="conflict-badge">{conflictCount}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
