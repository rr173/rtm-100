import React, { useEffect, useRef, useState, useCallback } from 'react';

function forceDirectedLayout(nodes, edges, width, height) {
  const nodeMap = {};
  const positions = [];
  
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = Math.min(width, height) * 0.3;
    positions.push({
      id: node.clause_id,
      x: width / 2 + radius * Math.cos(angle),
      y: height / 2 + radius * Math.sin(angle),
      vx: 0,
      vy: 0
    });
    nodeMap[node.clause_id] = positions[i];
  });

  const iterations = 100;
  const damping = 0.9;
  const repulsionStrength = 5000;
  const attractionStrength = 0.01;
  const centerStrength = 0.01;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsionStrength / (dist * dist);
        
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        
        positions[i].vx -= fx;
        positions[i].vy -= fy;
        positions[j].vx += fx;
        positions[j].vy += fy;
      }
    }

    for (const edge of edges) {
      const from = nodeMap[edge.from];
      const to = nodeMap[edge.to];
      if (!from || !to) continue;
      
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 100) * attractionStrength;
      
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    }

    for (const pos of positions) {
      const dx = width / 2 - pos.x;
      const dy = height / 2 - pos.y;
      pos.vx += dx * centerStrength;
      pos.vy += dy * centerStrength;
    }

    for (const pos of positions) {
      pos.vx *= damping;
      pos.vy *= damping;
      pos.x += pos.vx;
      pos.y += pos.vy;
      
      pos.x = Math.max(50, Math.min(width - 50, pos.x));
      pos.y = Math.max(50, Math.min(height - 50, pos.y));
    }
  }

  return positions;
}

export default function DependencyGraph({ depsData, onNodeClick }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredEdge, setHoveredEdge] = useState(null);
  const positionsRef = useRef([]);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const { nodes = [], edges = [] } = depsData || {};

  useEffect(() => {
    if (containerRef.current) {
      const updateSize = () => {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({
          width: rect.width - 40,
          height: Math.max(500, rect.height - 40)
        });
      };
      updateSize();
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }
  }, []);

  useEffect(() => {
    if (nodes.length > 0) {
      positionsRef.current = forceDirectedLayout(nodes, edges, dimensions.width, dimensions.height);
    }
  }, [nodes, edges, dimensions.width, dimensions.height]);

  const getRelatedNodes = useCallback((nodeId) => {
    if (!nodeId) return { upstream: new Set(), downstream: new Set() };
    
    const upstream = new Set();
    const downstream = new Set();
    
    for (const edge of edges) {
      if (edge.from === nodeId) {
        upstream.add(edge.to);
      }
      if (edge.to === nodeId) {
        downstream.add(edge.from);
      }
    }
    
    return { upstream, downstream };
  }, [edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    if (nodes.length === 0) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('暂无依赖关系数据', dimensions.width / 2, dimensions.height / 2);
      return;
    }

    const positions = positionsRef.current;
    const posMap = {};
    for (const pos of positions) {
      posMap[pos.id] = pos;
    }

    const { upstream, downstream } = getRelatedNodes(selectedNode);

    for (const edge of edges) {
      const from = posMap[edge.from];
      const to = posMap[edge.to];
      if (!from || !to) continue;

      let opacity = 1;
      let color = '#94a3b8';
      
      if (selectedNode) {
        const isRelated = edge.from === selectedNode || edge.to === selectedNode ||
          upstream.has(edge.from) || upstream.has(edge.to) ||
          downstream.has(edge.from) || downstream.has(edge.to);
        opacity = isRelated ? 1 : 0.2;
        if (edge.to === selectedNode) color = '#22c55e';
        if (edge.from === selectedNode) color = '#3b82f6';
      }

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const arrowLength = 12;
      const arrowAngle = Math.PI / 6;
      const endX = to.x - (dx / dist) * 25;
      const endY = to.y - (dy / dist) * 25;
      const startX = from.x + (dx / dist) * 25;
      const startY = from.y + (dy / dist) * 25;

      ctx.strokeStyle = color;
      ctx.globalAlpha = opacity;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      const angle = Math.atan2(dy, dx);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowLength * Math.cos(angle - arrowAngle),
        endY - arrowLength * Math.sin(angle - arrowAngle)
      );
      ctx.lineTo(
        endX - arrowLength * Math.cos(angle + arrowAngle),
        endY - arrowLength * Math.sin(angle + arrowAngle)
      );
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const node of nodes) {
      const pos = posMap[node.clause_id];
      if (!pos) continue;

      let fillColor = '#e2e8f0';
      let strokeColor = '#64748b';
      let opacity = 1;
      let textColor = '#1e293b';

      if (selectedNode) {
        if (node.clause_id === selectedNode) {
          fillColor = '#3b82f6';
          strokeColor = '#1d4ed8';
          textColor = '#ffffff';
        } else if (upstream.has(node.clause_id)) {
          fillColor = '#22c55e';
          strokeColor = '#16a34a';
          textColor = '#ffffff';
        } else if (downstream.has(node.clause_id)) {
          fillColor = '#f59e0b';
          strokeColor = '#d97706';
          textColor = '#ffffff';
        } else {
          opacity = 0.3;
        }
      }

      ctx.globalAlpha = opacity;
      ctx.fillStyle = fillColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.clause_id, pos.x, pos.y);
      ctx.globalAlpha = 1;
    }

    for (const node of nodes) {
      const pos = posMap[node.clause_id];
      if (!pos) continue;

      let opacity = 1;
      if (selectedNode && node.clause_id !== selectedNode && 
          !upstream.has(node.clause_id) && !downstream.has(node.clause_id)) {
        opacity = 0.3;
      }

      ctx.globalAlpha = opacity;
      ctx.fillStyle = '#374151';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(node.title.substring(0, 10), pos.x, pos.y + 40);
      ctx.globalAlpha = 1;
    }
  }, [nodes, edges, selectedNode, dimensions, getRelatedNodes]);

  const handleCanvasClick = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const positions = positionsRef.current;
    let clickedNode = null;

    for (const pos of positions) {
      const dx = x - pos.x;
      const dy = y - pos.y;
      if (dx * dx + dy * dy <= 625) {
        clickedNode = pos.id;
        break;
      }
    }

    if (clickedNode) {
      setSelectedNode(prev => prev === clickedNode ? null : clickedNode);
      if (onNodeClick) {
        onNodeClick(clickedNode === selectedNode ? null : clickedNode);
      }
    } else {
      setSelectedNode(null);
      if (onNodeClick) {
        onNodeClick(null);
      }
    }
  }, [selectedNode, onNodeClick]);

  const selectedNodeData = nodes.find(n => n.clause_id === selectedNode);
  const { upstream, downstream } = getRelatedNodes(selectedNode);

  return (
    <div className="dependency-graph" ref={containerRef}>
      <div className="graph-header">
        <h3>条款依赖图谱</h3>
        <div className="graph-legend">
          <div className="legend-item">
            <span className="legend-dot" style={{ background: '#3b82f6' }}></span>
            <span>选中节点</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: '#22c55e' }}></span>
            <span>上游（被引用）</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: '#f59e0b' }}></span>
            <span>下游（引用它）</span>
          </div>
        </div>
      </div>
      
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        onClick={handleCanvasClick}
        style={{ cursor: 'pointer' }}
      />
      
      {selectedNodeData && (
        <div className="node-info-panel">
          <div className="node-info-title">
            <strong>{selectedNodeData.clause_id}</strong>
            <span>{selectedNodeData.title}</span>
          </div>
          {upstream.size > 0 && (
            <div className="node-info-section">
              <label>引用了（上游）:</label>
              <div className="tag-list">
                {Array.from(upstream).map(id => (
                  <span key={id} className="tag upstream">{id}</span>
                ))}
              </div>
            </div>
          )}
          {downstream.size > 0 && (
            <div className="node-info-section">
              <label>被引用（下游）:</label>
              <div className="tag-list">
                {Array.from(downstream).map(id => (
                  <span key={id} className="tag downstream">{id}</span>
                ))}
              </div>
            </div>
          )}
          {upstream.size === 0 && downstream.size === 0 && (
            <div className="node-info-empty">该条款没有依赖关系</div>
          )}
        </div>
      )}
    </div>
  );
}
