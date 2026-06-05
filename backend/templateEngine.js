const { queryAll, queryOne, runSql } = require('./database');

const TAG_ASSOCIATION_MATRIX = [
  { tag: 'transfer_restriction', associated: ['transfer_permission'], description: '有转让限制通常需要配套关联方转让许可条款' },
  { tag: 'transfer_permission', associated: ['transfer_restriction'], description: '有转让许可通常需要配套基础转让限制条款' },
  { tag: 'liability_cap', associated: ['dispute_resolution', 'liability_uncapped'], description: '责任上限条款通常配套争议解决和间接损失免责条款' },
  { tag: 'liability_uncapped', associated: ['liability_cap'], description: '无上限责任条款通常需要配套直接损失上限条款' },
  { tag: 'confidentiality', associated: ['disclosure_permission'], description: '保密义务条款通常配套信息披露例外条款' },
  { tag: 'disclosure_permission', associated: ['confidentiality'], description: '信息披露例外通常需要配套基础保密义务条款' },
  { tag: 'termination', associated: ['dispute_resolution', 'force_majeure'], description: '终止条款通常配套争议解决和不可抗力条款' },
  { tag: 'payment_term', associated: ['liability_cap'], description: '付款条款通常配套逾期付款的责任上限条款' },
  { tag: 'dispute_resolution', associated: ['liability_cap', 'termination'], description: '争议解决条款通常配套责任上限和终止条款' },
  { tag: 'force_majeure', associated: ['termination'], description: '不可抗力条款通常配套终止条款' }
];

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fillTemplate(bodyTemplate, params, paramDefinitions) {
  const warnings = [];
  let filledBody = bodyTemplate;

  const placeholderRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;

  const placeholders = [];
  let match;
  while ((match = placeholderRegex.exec(bodyTemplate)) !== null) {
    placeholders.push(match[1].trim());
  }

  const uniquePlaceholders = [...new Set(placeholders)];

  for (const paramName of uniquePlaceholders) {
    const paramDef = paramDefinitions.find(p => p.name === paramName);
    const valueProvided = params && params.hasOwnProperty(paramName);
    const value = valueProvided ? params[paramName] : (paramDef ? paramDef.default_value : undefined);

    if (value === undefined || value === null || value === '') {
      return {
        error: `必填参数"${paramName}"未提供`,
        status: 400
      };
    }

    if (paramDef && paramDef.type === 'number') {
      if (typeof value !== 'number' && isNaN(Number(value))) {
        warnings.push(`参数"${paramName}"应为number类型,但传入了非数字值,已用原始文本替换`);
      }
    }

    const escapedValue = String(value).replace(/\$/g, '$$$$');
    const paramRegex = new RegExp(`\\{\\{\\s*${escapeRegExp(paramName)}\\s*\\}\\}`, 'g');
    filledBody = filledBody.replace(paramRegex, escapedValue);
  }

  return {
    filled_body: filledBody,
    warnings
  };
}

function validateTemplateData(data) {
  const { name, category, body_template, params, auto_tags } = data;

  if (!name || !category || !body_template) {
    return { error: 'name, category, body_template为必填项' };
  }

  if (!Array.isArray(params)) {
    return { error: 'params必须为数组' };
  }

  const paramNames = new Set();
  for (const param of params) {
    if (!param.name || !param.type) {
      return { error: '每个param必须包含name和type' };
    }
    if (!['number', 'text', 'date'].includes(param.type)) {
      return { error: `参数"${param.name}"的type必须是number/text/date之一` };
    }
    if (paramNames.has(param.name)) {
      return { error: `参数名"${param.name}"重复` };
    }
    paramNames.add(param.name);
  }

  if (!Array.isArray(auto_tags)) {
    return { error: 'auto_tags必须为数组' };
  }

  return null;
}

function createTemplate(data) {
  const validationError = validateTemplateData(data);
  if (validationError) {
    throw new Error(validationError.error);
  }

  const { name, category, body_template, params, auto_tags } = data;

  const result = runSql(
    'INSERT INTO contract_templates (name, category, body_template, params_json, auto_tags_json) VALUES (?, ?, ?, ?, ?)',
    [name, category, body_template, JSON.stringify(params), JSON.stringify(auto_tags || [])]
  );

  return getTemplateById(result.lastInsertRowid);
}

function getTemplates(category = null) {
  let sql = 'SELECT * FROM contract_templates ORDER BY created_at DESC';
  let params = [];

  if (category) {
    sql = 'SELECT * FROM contract_templates WHERE category = ? ORDER BY created_at DESC';
    params = [category];
  }

  const rows = queryAll(sql, params);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    body_template: row.body_template,
    params: JSON.parse(row.params_json),
    auto_tags: JSON.parse(row.auto_tags_json),
    created_at: row.created_at
  }));
}

function getTemplateById(id) {
  const row = queryOne('SELECT * FROM contract_templates WHERE id = ?', [parseInt(id)]);
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    body_template: row.body_template,
    params: JSON.parse(row.params_json),
    auto_tags: JSON.parse(row.auto_tags_json),
    created_at: row.created_at
  };
}

function updateTemplate(id, data) {
  const existing = getTemplateById(id);
  if (!existing) {
    return null;
  }

  const validationError = validateTemplateData(data);
  if (validationError) {
    throw new Error(validationError.error);
  }

  const { name, category, body_template, params, auto_tags } = data;

  runSql(
    'UPDATE contract_templates SET name = ?, category = ?, body_template = ?, params_json = ?, auto_tags_json = ? WHERE id = ?',
    [name, category, body_template, JSON.stringify(params), JSON.stringify(auto_tags || []), parseInt(id)]
  );

  return getTemplateById(id);
}

function deleteTemplate(id) {
  const existing = getTemplateById(id);
  if (!existing) {
    return false;
  }

  runSql('DELETE FROM contract_templates WHERE id = ?', [parseInt(id)]);
  return true;
}

function fillTemplateById(id, params) {
  const template = getTemplateById(id);
  if (!template) {
    return { error: '模板不存在', status: 404 };
  }

  const result = fillTemplate(template.body_template, params, template.params);
  if (result.error) {
    return result;
  }

  return {
    filled_body: result.filled_body,
    tags: template.auto_tags,
    warnings: result.warnings
  };
}

function recommendTemplates(existingTags) {
  const existingTagSet = new Set(existingTags || []);
  const allTemplates = getTemplates();
  const recommendedTemplateIds = new Set();
  const recommendations = [];

  for (const association of TAG_ASSOCIATION_MATRIX) {
    if (existingTagSet.has(association.tag)) {
      for (const associatedTag of association.associated) {
        if (!existingTagSet.has(associatedTag)) {
          const matchingTemplates = allTemplates.filter(t =>
            t.auto_tags.includes(associatedTag) &&
            !recommendedTemplateIds.has(t.id)
          );

          for (const tmpl of matchingTemplates) {
            recommendedTemplateIds.add(tmpl.id);
            recommendations.push({
              template: tmpl,
              reason: association.description,
              trigger_tag: association.tag,
              missing_tag: associatedTag
            });
          }
        }
      }
    }
  }

  return recommendations;
}

function seedDemoTemplates() {
  const existing = queryOne('SELECT COUNT(*) as cnt FROM contract_templates');
  if (existing && existing.cnt > 0) {
    console.log('Demo templates already exist, skipping seed.');
    return;
  }

  console.log('Seeding demo templates...');

  const demoTemplates = [
    {
      name: '保密义务标准条款',
      category: '保密',
      body_template: '双方应对在合作过程中获知的对方保密信息严格保密,保密期限为自协议终止后{{保密期限}}个月。未经披露方书面许可,不得向任何第三方披露。本保密义务不适用于以下信息:(1)披露时已为公众所知的信息;(2)非因接收方过错而成为公众所知的信息;(3)接收方从有合法来源的第三方处获得的信息。',
      params: [
        { name: '保密期限', type: 'number', description: '保密期限(月)', default_value: 24 }
      ],
      auto_tags: ['confidentiality']
    },
    {
      name: '付款期限标准条款',
      category: '付款',
      body_template: '{{付款方}}应在收到{{收款方}}出具的合格发票后{{付款天数}}天内将服务费用支付至{{收款方}}指定账户,逾期按日万分之{{违约金比例}}支付违约金。所有款项以人民币支付,通过银行转账方式支付。',
      params: [
        { name: '付款方', type: 'text', description: '付款方名称', default_value: '甲方' },
        { name: '收款方', type: 'text', description: '收款方名称', default_value: '乙方' },
        { name: '付款天数', type: 'number', description: '付款期限(天)', default_value: 30 },
        { name: '违约金比例', type: 'number', description: '日违约金比例(万分之几)', default_value: 5 }
      ],
      auto_tags: ['payment_term']
    },
    {
      name: '责任上限标准条款',
      category: '责任',
      body_template: '任何情况下,一方对本协议项下产生的直接损失的总赔偿责任不超过合同总金额的{{上限百分比}}%,即不超过{{上限金额}}万元。前述责任上限不适用于以下情形:(1)一方的故意或重大过失行为;(2)一方违反保密义务的行为;(3)一方侵犯对方知识产权的行为。',
      params: [
        { name: '上限百分比', type: 'number', description: '责任上限占合同金额的百分比', default_value: 10 },
        { name: '上限金额', type: 'number', description: '责任上限金额(万元)', default_value: 100 }
      ],
      auto_tags: ['liability_cap']
    },
    {
      name: '终止通知标准条款',
      category: '终止',
      body_template: '任何一方拟终止本协议,应提前{{通知天数}}天以书面形式通知对方,终止通知期内双方应继续履行本协议项下的义务。如一方发生重大违约,守约方有权立即书面通知违约方终止本协议,无需提前通知期,且不影响守约方追究违约责任的权利。',
      params: [
        { name: '通知天数', type: 'number', description: '终止通知期(天)', default_value: 30 }
      ],
      auto_tags: ['termination']
    },
    {
      name: '转让限制标准条款',
      category: '转让',
      body_template: '未经对方书面同意,任何一方不得将本协议项下的权利义务全部或部分转让给第三方。但在提前{{通知天数}}天书面通知对方的前提下,一方可将本协议项下的权利义务转让给其关联方,该转让无需获得对方另行同意。"关联方"指直接或间接控制、受控于一方或与一方受共同控制的实体。',
      params: [
        { name: '通知天数', type: 'number', description: '关联方转让提前通知期(天)', default_value: 15 }
      ],
      auto_tags: ['transfer_restriction', 'transfer_permission']
    },
    {
      name: '争议解决标准条款',
      category: '争议解决',
      body_template: '因本协议引起的或与本协议有关的任何争议,双方应首先通过友好协商解决;协商不成的,任何一方可向{{管辖法院}}有管辖权的人民法院提起诉讼。在争议解决期间,除争议事项外,双方应继续履行本协议其他条款。',
      params: [
        { name: '管辖法院', type: 'text', description: '管辖法院所在地', default_value: '甲方所在地' }
      ],
      auto_tags: ['dispute_resolution']
    }
  ];

  for (const tmpl of demoTemplates) {
    createTemplate(tmpl);
  }

  console.log(`Seeded ${demoTemplates.length} demo templates.`);
}

module.exports = {
  TAG_ASSOCIATION_MATRIX,
  fillTemplate,
  validateTemplateData,
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  fillTemplateById,
  recommendTemplates,
  seedDemoTemplates
};
