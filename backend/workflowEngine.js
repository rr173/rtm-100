const { queryAll, queryOne, runSql } = require('./database');

const VALID_ROLES = ['legal', 'finance', 'executive', 'custom'];
const VALID_ACTIONS = ['approve', 'review'];

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps必须是非空数组');
  }
  for (const step of steps) {
    if (typeof step.order !== 'number' || step.order < 0) {
      throw new Error('每个step必须包含有效的order字段(非负整数)');
    }
    if (!VALID_ROLES.includes(step.role)) {
      throw new Error(`role必须是${VALID_ROLES.join('/')}之一`);
    }
    if (!step.approver_name || typeof step.approver_name !== 'string') {
      throw new Error('每个step必须包含approver_name');
    }
    if (!VALID_ACTIONS.includes(step.action_required)) {
      throw new Error(`action_required必须是${VALID_ACTIONS.join('/')}之一`);
    }
    if (step.timeout_hours !== undefined && (typeof step.timeout_hours !== 'number' || step.timeout_hours <= 0)) {
      throw new Error('timeout_hours必须是正整数');
    }
  }
  const orders = steps.map(s => s.order);
  const uniqueOrders = new Set(orders);
  if (uniqueOrders.size !== orders.length) {
    throw new Error('steps中的order不能重复');
  }
}

function sortSteps(steps) {
  return [...steps].sort((a, b) => a.order - b.order);
}

function createWorkflowTemplate(name, steps) {
  if (!name || typeof name !== 'string') {
    throw new Error('name为必填字符串');
  }
  validateSteps(steps);
  const sortedSteps = sortSteps(steps);

  const result = runSql(
    'INSERT INTO workflow_templates (name, steps_json) VALUES (?, ?)',
    [name, JSON.stringify(sortedSteps)]
  );

  return {
    id: result.lastInsertRowid,
    name,
    steps: sortedSteps
  };
}

function getWorkflowTemplates() {
  const rows = queryAll('SELECT * FROM workflow_templates ORDER BY created_at DESC');
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    steps: JSON.parse(row.steps_json),
    created_at: row.created_at
  }));
}

function getWorkflowTemplateById(id) {
  const row = queryOne('SELECT * FROM workflow_templates WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    steps: JSON.parse(row.steps_json),
    created_at: row.created_at
  };
}

function deleteWorkflowTemplate(id) {
  const existing = queryOne('SELECT 1 FROM workflow_templates WHERE id = ?', [id]);
  if (!existing) return false;
  runSql('DELETE FROM workflow_templates WHERE id = ?', [id]);
  return true;
}

function hasActiveWorkflow(contractId) {
  const row = queryOne(
    "SELECT COUNT(*) as cnt FROM workflow_instances WHERE contract_id = ? AND status = 'in_progress'",
    [contractId]
  );
  return row && row.cnt > 0;
}

function startWorkflow(contractId, templateId, initiator) {
  const contract = queryOne('SELECT 1 FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    throw { status: 404, message: '合同不存在' };
  }

  const template = getWorkflowTemplateById(templateId);
  if (!template) {
    throw { status: 404, message: '审批链模板不存在' };
  }

  if (!initiator || typeof initiator !== 'string') {
    throw { status: 400, message: 'initiator为必填项' };
  }

  if (hasActiveWorkflow(contractId)) {
    throw { status: 409, message: '该合同已有进行中的工作流' };
  }

  const result = runSql(
    "INSERT INTO workflow_instances (contract_id, template_id, status, current_step, initiator) VALUES (?, ?, 'in_progress', 0, ?)",
    [contractId, templateId, initiator]
  );

  const instanceId = result.lastInsertRowid;

  runSql(
    'INSERT INTO workflow_actions (instance_id, step_order, action, approver, comment) VALUES (?, 0, ?, ?, ?)',
    [instanceId, 'start', initiator, '工作流启动']
  );

  return getWorkflowStatus(contractId);
}

function getWorkflowStatus(contractId) {
  const instance = queryOne(
    "SELECT * FROM workflow_instances WHERE contract_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
    [contractId]
  );

  if (!instance) {
    const lastInstance = queryOne(
      'SELECT * FROM workflow_instances WHERE contract_id = ? ORDER BY created_at DESC LIMIT 1',
      [contractId]
    );
    if (!lastInstance) {
      return null;
    }
    return buildWorkflowStatusResponse(lastInstance);
  }

  return buildWorkflowStatusResponse(instance);
}

function buildWorkflowStatusResponse(instance) {
  const template = getWorkflowTemplateById(instance.template_id);
  if (!template) return null;

  const totalSteps = template.steps.length;
  const currentStepIndex = instance.current_step;
  const isCompleted = instance.status === 'completed';
  const isRejected = instance.status === 'rejected';

  let completedSteps = currentStepIndex;
  if (isCompleted) completedSteps = totalSteps;
  if (isRejected) completedSteps = currentStepIndex;

  const currentStep = (isCompleted || isRejected) ? null : template.steps[currentStepIndex];

  return {
    workflow_id: instance.id,
    contract_id: instance.contract_id,
    template_id: instance.template_id,
    template_name: template.name,
    status: instance.status,
    initiator: instance.initiator,
    current_step: currentStep,
    completed_steps: completedSteps,
    total_steps: totalSteps,
    created_at: instance.created_at,
    completed_at: instance.completed_at
  };
}

function verifyApprover(contractId, approver) {
  const instance = queryOne(
    "SELECT * FROM workflow_instances WHERE contract_id = ? AND status = 'in_progress'",
    [contractId]
  );
  if (!instance) {
    throw { status: 404, message: '没有进行中的工作流' };
  }

  const template = getWorkflowTemplateById(instance.template_id);
  if (!template) {
    throw { status: 404, message: '审批链模板不存在' };
  }

  if (instance.current_step >= template.steps.length) {
    throw { status: 400, message: '工作流已完成' };
  }

  const currentStep = template.steps[instance.current_step];
  if (currentStep.approver_name !== approver) {
    throw { status: 403, message: `当前步骤审批人应为${currentStep.approver_name},无权操作` };
  }

  return { instance, template, currentStep };
}

function approveWorkflow(contractId, approver, comment) {
  if (!approver || typeof approver !== 'string') {
    throw { status: 400, message: 'approver为必填项' };
  }

  const { instance, template, currentStep } = verifyApprover(contractId, approver);

  runSql(
    'INSERT INTO workflow_actions (instance_id, step_order, action, approver, comment) VALUES (?, ?, ?, ?, ?)',
    [instance.id, currentStep.order, 'approve', approver, comment || '']
  );

  const nextStepIndex = instance.current_step + 1;

  if (nextStepIndex >= template.steps.length) {
    runSql(
      "UPDATE workflow_instances SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
      [instance.id]
    );
  } else {
    runSql(
      'UPDATE workflow_instances SET current_step = ? WHERE id = ?',
      [nextStepIndex, instance.id]
    );
  }

  return getWorkflowStatus(contractId);
}

function rejectWorkflow(contractId, approver, reason) {
  if (!approver || typeof approver !== 'string') {
    throw { status: 400, message: 'approver为必填项' };
  }
  if (!reason || typeof reason !== 'string') {
    throw { status: 400, message: 'reason为必填项' };
  }

  const { instance, currentStep } = verifyApprover(contractId, approver);

  runSql(
    'INSERT INTO workflow_actions (instance_id, step_order, action, approver, comment) VALUES (?, ?, ?, ?, ?)',
    [instance.id, currentStep.order, 'reject', approver, reason]
  );

  runSql(
    "UPDATE workflow_instances SET status = 'rejected', completed_at = datetime('now') WHERE id = ?",
    [instance.id]
  );

  return getWorkflowStatus(contractId);
}

function commentWorkflow(contractId, approver, comment) {
  if (!approver || typeof approver !== 'string') {
    throw { status: 400, message: 'approver为必填项' };
  }
  if (!comment || typeof comment !== 'string') {
    throw { status: 400, message: 'comment为必填项' };
  }

  const { instance, currentStep } = verifyApprover(contractId, approver);

  runSql(
    'INSERT INTO workflow_actions (instance_id, step_order, action, approver, comment) VALUES (?, ?, ?, ?, ?)',
    [instance.id, currentStep.order, 'comment', approver, comment]
  );

  return getWorkflowStatus(contractId);
}

function getWorkflowHistory(contractId) {
  const instances = queryAll(
    'SELECT * FROM workflow_instances WHERE contract_id = ? ORDER BY created_at DESC',
    [contractId]
  );

  if (instances.length === 0) {
    return [];
  }

  const templateMap = {};
  for (const inst of instances) {
    if (!templateMap[inst.template_id]) {
      const tpl = getWorkflowTemplateById(inst.template_id);
      if (tpl) {
        templateMap[inst.template_id] = tpl;
      }
    }
  }

  const instanceIds = instances.map(i => i.id);
  const placeholders = instanceIds.map(() => '?').join(',');

  const actions = queryAll(
    `SELECT * FROM workflow_actions WHERE instance_id IN (${placeholders}) ORDER BY created_at DESC`,
    instanceIds
  );

  const result = actions.map(action => {
    const instance = instances.find(i => i.id === action.instance_id);
    const template = instance ? templateMap[instance.template_id] : null;
    const steps = template ? template.steps : [];
    const step = steps.find(s => s.order === action.step_order);

    return {
      workflow_id: action.instance_id,
      workflow_status: instance ? instance.status : null,
      step_order: action.step_order,
      role: step ? step.role : null,
      approver_name: step ? step.approver_name : null,
      approver: action.approver,
      action: action.action,
      comment: action.comment,
      timestamp: action.created_at
    };
  });

  return result;
}

function seedDefaultTemplate() {
  const existing = queryOne('SELECT COUNT(*) as cnt FROM workflow_templates');
  if (existing && existing.cnt > 0) {
    return null;
  }

  const defaultSteps = [
    { order: 0, role: 'legal', approver_name: '张法务', action_required: 'approve', timeout_hours: 48 },
    { order: 1, role: 'finance', approver_name: '李财务', action_required: 'approve', timeout_hours: 24 },
    { order: 2, role: 'executive', approver_name: '王总经理', action_required: 'approve', timeout_hours: 72 }
  ];

  const template = createWorkflowTemplate('标准审批流程(法务→财务→总经理)', defaultSteps);
  console.log(`Seeded default workflow template: ${template.name}`);
  return template;
}

function seedDemoWorkflow(contractId) {
  const templates = getWorkflowTemplates();
  if (templates.length === 0) {
    console.log('No workflow templates found, skipping demo workflow seed.');
    return null;
  }

  const active = queryOne(
    "SELECT 1 FROM workflow_instances WHERE contract_id = ? AND status = 'in_progress'",
    [contractId]
  );
  if (active) {
    console.log('Demo contract already has active workflow, skipping.');
    return null;
  }

  const hasAny = queryOne(
    'SELECT COUNT(*) as cnt FROM workflow_instances WHERE contract_id = ?',
    [contractId]
  );
  if (hasAny && hasAny.cnt > 0) {
    console.log('Demo contract already has workflow history, skipping.');
    return null;
  }

  const template = templates[0];
  const initiator = '赵秘书';

  const status = startWorkflow(contractId, template.id, initiator);
  console.log(`Started demo workflow for contract ${contractId}: workflow_id=${status.workflow_id}`);

  approveWorkflow(contractId, '张法务', '条款合法合规，审核通过');
  console.log('Demo workflow step 1 (legal) approved.');

  approveWorkflow(contractId, '李财务', '付款条款合理，财务审核通过');
  console.log('Demo workflow step 2 (finance) approved.');

  return getWorkflowStatus(contractId);
}

module.exports = {
  createWorkflowTemplate,
  getWorkflowTemplates,
  getWorkflowTemplateById,
  deleteWorkflowTemplate,
  startWorkflow,
  getWorkflowStatus,
  approveWorkflow,
  rejectWorkflow,
  commentWorkflow,
  getWorkflowHistory,
  seedDefaultTemplate,
  seedDemoWorkflow
};
