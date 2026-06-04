import React from 'react';

const LEVEL_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
const LEVEL_LABELS = { high: '高风险', medium: '中风险', low: '低风险' };
const SEVERITY_COLORS = { critical: '#dc2626', warning: '#f59e0b' };
const SEVERITY_LABELS = { critical: '严重', warning: '警告' };

export default function ContractOverview({ contract, reviewStatus, risks, conflicts }) {
  const highRiskCount = new Set(
    risks.filter(r => r.level === 'high').map(r => r.clause_id)
  ).size;

  const totalClauses = contract.clauses?.length || 0;

  const stats = [
    { label: '总条款数', value: totalClauses, color: '#3b82f6' },
    { label: '高风险条款', value: highRiskCount, color: LEVEL_COLORS.high },
    { label: '未解决冲突', value: reviewStatus.pending, color: SEVERITY_COLORS.critical },
    { label: '审阅完成', value: `${reviewStatus.review_percentage}%`, color: '#22c55e' }
  ];

  return (
    <div className="contract-overview">
      {stats.map((s, i) => (
        <div key={i} className="stat-card">
          <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
          <div className="stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}
