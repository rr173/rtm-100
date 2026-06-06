import React, { useState } from 'react';
import { scanCrossContractConflicts } from '../api';

const SEVERITY_COLORS = { critical: '#dc2626', warning: '#f59e0b' };
const SEVERITY_LABELS = { critical: '严重', warning: '警告' };
const TYPE_LABELS = {
  contradiction: '量化矛盾',
  ambiguity: '潜在歧义',
  overlap: '条款重叠',
  exclusivity_violation: '独家违约'
};
const RISK_COLORS = { high: '#dc2626', medium: '#f59e0b', low: '#10b981' };

export default function CrossContractScanView({ contracts }) {
  const [selectedContractIds, setSelectedContractIds] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState(null);

  const toggleContract = (contractId) => {
    setSelectedContractIds(prev => {
      if (prev.includes(contractId)) {
        return prev.filter(id => id !== contractId);
      }
      return [...prev, contractId];
    });
    setScanResult(null);
    setError(null);
  };

  const handleScan = async () => {
    if (selectedContractIds.length < 2) {
      alert('请至少选择2份合同');
      return;
    }
    setScanning(true);
    setError(null);
    setScanResult(null);
    try {
      const result = await scanCrossContractConflicts(selectedContractIds);
      if (result.error) {
        setError(result.error);
      } else {
        setScanResult(result);
      }
    } catch (err) {
      setError('扫描失败: ' + err.message);
    } finally {
      setScanning(false);
    }
  };

  const getContractTitle = (id) => {
    const info = scanResult?.contracts_info?.[id];
    return info?.title || `合同#${id}`;
  };

  return (
    <div className="cross-contract-view">
      <div className="cross-contract-header">
        <h2>跨合同冲突扫描</h2>
        <p className="cross-contract-subtitle">
          选择多份合同进行跨合同条款矛盾检测，自动识别独家合作违约、量化约束冲突、标签互斥等问题，并支持风险关联传播。
        </p>
      </div>

      <div className="cross-contract-selector">
        <h3>选择要扫描的合同（至少2份）</h3>
        <div className="contract-checkboxes">
          {contracts.map(c => (
            <label key={c.id} className="contract-checkbox-item">
              <input
                type="checkbox"
                checked={selectedContractIds.includes(c.id)}
                onChange={() => toggleContract(c.id)}
              />
              <span className="contract-checkbox-label">{c.title}</span>
              <span className="contract-checkbox-parties">
                {c.parties?.join(' / ') || ''}
              </span>
            </label>
          ))}
        </div>
        <button
          className="btn btn-primary scan-btn"
          onClick={handleScan}
          disabled={scanning || selectedContractIds.length < 2}
        >
          {scanning ? '扫描中...' : `开始扫描 (已选 ${selectedContractIds.length} 份)`}
        </button>
      </div>

      {error && (
        <div className="error-message">{error}</div>
      )}

      {scanResult && (
        <div className="scan-results">
          <div className="scan-summary">
            <div className="stat-card">
              <div className="stat-value" style={{ color: '#1e3a5f' }}>{scanResult.contracts_scanned}</div>
              <div className="stat-label">扫描合同数</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: SEVERITY_COLORS.critical }}>{scanResult.conflict_summary.critical}</div>
              <div className="stat-label">严重冲突</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: SEVERITY_COLORS.warning }}>{scanResult.conflict_summary.warning}</div>
              <div className="stat-label">警告冲突</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: '#7c3aed' }}>{scanResult.conflict_summary.exclusivity_violations}</div>
              <div className="stat-label">独家违约</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: RISK_COLORS.high }}>{scanResult.conflict_summary.risk_propagated_count}</div>
              <div className="stat-label">风险传播</div>
            </div>
          </div>

          <div className="matrix-section">
            <h3>合同关系矩阵（冲突数量）</h3>
            <div className="matrix-wrapper">
              <table className="conflict-matrix">
                <thead>
                  <tr>
                    <th className="matrix-corner"></th>
                    {scanResult.relationship_matrix.contract_ids.map(cid => (
                      <th key={cid} className="matrix-header-col">
                        <div className="matrix-header-text" title={getContractTitle(cid)}>
                          {getContractTitle(cid).length > 15
                            ? getContractTitle(cid).slice(0, 15) + '...'
                            : getContractTitle(cid)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scanResult.relationship_matrix.rows.map(row => (
                    <tr key={row.contract_id}>
                      <th className="matrix-header-row" title={row.contract_title}>
                        {row.contract_title.length > 18
                          ? row.contract_title.slice(0, 18) + '...'
                          : row.contract_title}
                      </th>
                      {scanResult.relationship_matrix.contract_ids.map(cid => {
                        const cell = row.counts[cid];
                        if (cell.diagonal) {
                          return <td key={cid} className="matrix-cell matrix-diagonal">—</td>;
                        }
                        const hasConflict = cell.total > 0;
                        const intensity = Math.min(cell.total / 4, 1);
                        const bgColor = hasConflict
                          ? `rgba(220, 38, 38, ${0.15 + intensity * 0.55})`
                          : '#f0fdf4';
                        const textColor = hasConflict
                          ? (intensity > 0.5 ? '#ffffff' : SEVERITY_COLORS.critical)
                          : '#16a34a';
                        return (
                          <td
                            key={cid}
                            className="matrix-cell"
                            style={{ background: bgColor, color: textColor }}
                            title={`严重: ${cell.critical}, 警告: ${cell.warning}`}
                          >
                            {hasConflict ? (
                              <span className="matrix-cell-content">
                                <strong>{cell.total}</strong>
                                <span className="matrix-cell-breakdown">
                                  ({cell.critical}C/{cell.warning}W)
                                </span>
                              </span>
                            ) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="matrix-legend">
              <span className="legend-item"><span className="legend-color" style={{ background: '#f0fdf4' }}></span> 无冲突</span>
              <span className="legend-item"><span className="legend-color" style={{ background: 'rgba(220,38,38,0.2)' }}></span> 轻度</span>
              <span className="legend-item"><span className="legend-color" style={{ background: 'rgba(220,38,38,0.5)' }}></span> 中度</span>
              <span className="legend-item"><span className="legend-color" style={{ background: 'rgba(220,38,38,0.7)' }}></span> 重度</span>
            </div>
          </div>

          {scanResult.propagated_risks && scanResult.propagated_risks.length > 0 && (
            <div className="propagated-risks-section">
              <h3>风险关联传播 ({scanResult.propagated_risks.length} 项)</h3>
              <div className="propagated-risks-list">
                {scanResult.propagated_risks.map(r => (
                  <div key={r.id} className="propagated-risk-item">
                    <span className="risk-level-badge" style={{ background: RISK_COLORS[r.level], color: 'white' }}>
                      {r.level === 'high' ? '高' : r.level === 'medium' ? '中' : '低'}风险
                    </span>
                    <div className="propagated-risk-content">
                      <div className="propagated-risk-title">
                        <strong>[{getContractTitle(r.contract_id)}]</strong> {r.clause_id} - {r.clause_title}
                      </div>
                      <div className="propagated-risk-reason">{r.trigger_reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="conflicts-section">
            <h3>跨合同冲突详情 ({scanResult.conflicts.length} 项)</h3>
            <div className="cross-conflict-list">
              {scanResult.conflicts.map(c => (
                <div
                  key={c.id}
                  className="cross-conflict-card"
                  style={{ borderLeftColor: SEVERITY_COLORS[c.severity] }}
                >
                  <div className="cross-conflict-header">
                    <span className="cross-conflict-type" style={{ background: TYPE_COLOR(c.conflict_type) }}>
                      {TYPE_LABELS[c.conflict_type] || c.conflict_type}
                    </span>
                    <span className="cross-conflict-severity" style={{ color: SEVERITY_COLORS[c.severity] }}>
                      {SEVERITY_LABELS[c.severity]}
                    </span>
                    {c.risk_propagated === 1 && (
                      <span className="risk-propagated-badge">风险关联升级</span>
                    )}
                  </div>

                  <div className="cross-conflict-clauses">
                    <div className="cross-conflict-clause">
                      <div className="cross-clause-contract" style={{ color: '#2563eb' }}>
                        [{getContractTitle(c.contract_a_id)}]
                      </div>
                      <div className="cross-clause-title">
                        <strong>{c.clause_a_id}</strong> {c.clause_a_title}
                      </div>
                    </div>
                    <div className="cross-conflict-vs">⚔</div>
                    <div className="cross-conflict-clause">
                      <div className="cross-clause-contract" style={{ color: '#dc2626' }}>
                        [{getContractTitle(c.contract_b_id)}]
                      </div>
                      <div className="cross-clause-title">
                        <strong>{c.clause_b_id}</strong> {c.clause_b_title}
                      </div>
                    </div>
                  </div>

                  <div className="cross-conflict-reason">
                    {c.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TYPE_COLOR(type) {
  switch (type) {
    case 'exclusivity_violation': return '#7c3aed';
    case 'contradiction': return '#dc2626';
    case 'ambiguity': return '#f59e0b';
    case 'overlap': return '#0ea5e9';
    default: return '#6b7280';
  }
}
