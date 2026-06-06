const { initDb, queryAll, queryOne, runSql } = require('./database');
const { detectConflicts } = require('./conflictDetection');
const { annotateRisks } = require('./riskAnnotation');
const { createRule, auditContract } = require('./complianceEngine');
const { seedNegotiationPositions } = require('./negotiationEngine');
const { seedDemoTemplates } = require('./templateEngine');
const { seedExecutionPlan } = require('./executionTracker');
const { seedDemoCostModels } = require('./costEngine');
const { seedDefaultTemplate, seedDemoWorkflow } = require('./workflowEngine');
const { buildIndex } = require('./searchEngine');
const { generateFingerprint } = require('./semanticFingerprint');

function seed() {
  seedDemoTemplates();

  const seededModels = seedDemoCostModels();
  if (seededModels > 0) {
    console.log(`Seeded ${seededModels} demo cost models.`);
  }

  seedDefaultTemplate();

  const existing = queryOne('SELECT COUNT(*) as cnt FROM contracts');
  if (existing && existing.cnt > 0) {
    console.log('Demo contract data already exists, skipping seed.');
    const idxCount = queryOne('SELECT COUNT(*) as cnt FROM search_index');
    if (!idxCount || idxCount.cnt === 0) {
      console.log('Search index not found, building index for existing contracts...');
      const idxResult = buildIndex();
      console.log(`Search index built: ${idxResult.indexed_clauses_count} clauses, ${idxResult.total_terms} terms.`);
    }

    const existingContracts = queryAll('SELECT id FROM contracts');
    for (const c of existingContracts) {
      const fpCount = queryOne(
        'SELECT COUNT(*) as cnt FROM semantic_triples WHERE contract_id = ? AND revision = 1',
        [c.id]
      );
      if (!fpCount || fpCount.cnt === 0) {
        console.log(`Generating semantic fingerprint for existing contract id=${c.id} revision=1...`);
        const fpResult = generateFingerprint(c.id, 1);
        if (!fpResult.error) {
          console.log(`  Fingerprint generated: ${fpResult.clauses_processed} clauses, ${fpResult.total_triples} triples.`);
        }
      }
    }
    return;
  }

  console.log('Seeding demo contract data...');

  const conflictRules = [
    { tag_a: 'transfer_restriction', tag_b: 'transfer_permission', condition: 'same_subject' },
    { tag_a: 'liability_cap', tag_b: 'liability_uncapped', condition: 'same_subject' },
    { tag_a: 'confidentiality', tag_b: 'disclosure_permission', condition: 'same_subject' }
  ];

  for (const r of conflictRules) {
    runSql(
      'INSERT INTO conflict_rules (tag_a, tag_b, condition) VALUES (?, ?, ?)',
      [r.tag_a, r.tag_b, r.condition]
    );
  }

  const riskRules = [
    { trigger_tags: JSON.stringify(['liability_cap']), condition: 'amount !== undefined && amount < 50', level: 'high', description: '责任上限低于50万元,风险较高' },
    { trigger_tags: JSON.stringify(['payment_term']), condition: 'duration !== undefined && duration > 90', level: 'medium', description: '付款期限超过90天,存在回款风险' },
    { trigger_tags: JSON.stringify(['termination']), condition: 'duration !== undefined && duration < 30', level: 'high', description: '终止通知期少于30天,风险较高' },
    { trigger_tags: JSON.stringify(['confidentiality']), condition: 'duration !== undefined && duration < 365', level: 'medium', description: '保密期限不足1年,保护不够充分' },
    { trigger_tags: JSON.stringify(['liability_uncapped']), condition: 'true', level: 'high', description: '无责任上限条款,风险极高' }
  ];

  for (const r of riskRules) {
    runSql(
      'INSERT INTO risk_rules (trigger_tags, condition, level, description) VALUES (?, ?, ?, ?)',
      [r.trigger_tags, r.condition, r.level, r.description]
    );
  }

  const contractResult = runSql(
    'INSERT INTO contracts (title, parties) VALUES (?, ?)',
    ['某某技术服务合作框架协议', JSON.stringify(['甲方: 星辰科技有限公司', '乙方: 浩瀚数据技术有限公司'])]
  );

  const contractId = contractResult.lastInsertRowid;

  const clauses = [
    { clause_id: 'C01', section: '总则', title: '协议目的与范围', body: '本协议旨在明确甲乙双方在技术服务合作中的权利义务关系,合作范围包括数据分析平台开发、运维支持及相关咨询服务。', tags: JSON.stringify(['scope']) },
    { clause_id: 'C02', section: '总则', title: '定义与解释', body: '本协议中"关联方"指直接或间接控制、受控于一方或与一方受共同控制的实体。"保密信息"指一方以书面、口头或其他形式披露的未公开信息。', tags: JSON.stringify(['definition']) },
    { clause_id: 'C03', section: '权利义务', title: '转让限制', body: '未经对方书面同意,任何一方不得将本协议项下的权利义务全部或部分转让给第三方,本协议项下的权利不可转让。', tags: JSON.stringify(['transfer_restriction']) },
    { clause_id: 'C04', section: '权利义务', title: '关联方转让许可', body: '在提前15天书面通知对方的前提下,一方可将本协议项下的权利义务转让给其关联方,该转让无需获得对方另行同意。', tags: JSON.stringify(['transfer_permission']) },
    { clause_id: 'C05', section: '权利义务', title: '责任上限', body: '任何情况下,一方对本协议项下产生的直接损失的总赔偿责任不超过合同总金额的10%,即不超过30万元。', tags: JSON.stringify(['liability_cap']) },
    { clause_id: 'C06', section: '权利义务', title: '间接损失免责', body: '任何情况下,一方均不对另一方的间接损失、利润损失、商誉损失等承担赔偿责任,本条款不设责任上限,适用于所有情形。', tags: JSON.stringify(['liability_uncapped']) },
    { clause_id: 'C07', section: '付款条件', title: '付款期限', body: '甲方应在收到乙方出具的合格发票后120天内将服务费用支付至乙方指定账户,逾期按日万分之五支付违约金。', tags: JSON.stringify(['payment_term']) },
    { clause_id: 'C08', section: '付款条件', title: '付款方式与货币', body: '所有款项以人民币支付,通过银行转账方式支付至乙方指定账户。乙方应在付款前提供合规的增值税专用发票。', tags: JSON.stringify(['payment_term']) },
    { clause_id: 'C09', section: '保密义务', title: '保密义务', body: '双方应对在合作过程中获知的对方保密信息严格保密,保密期限为自协议终止后6个月。未经披露方书面许可,不得向任何第三方披露。', tags: JSON.stringify(['confidentiality']) },
    { clause_id: 'C10', section: '保密义务', title: '信息披露例外', body: '如法律法规、监管机构或司法机关要求,一方可在必要范围内向相关方披露保密信息,无需获得对方同意,但应在合理可行范围内提前通知对方。', tags: JSON.stringify(['disclosure_permission']) },
    { clause_id: 'C11', section: '终止条件', title: '终止通知期', body: '任何一方拟终止本协议,应提前15天以书面形式通知对方,终止通知期内双方应继续履行本协议项下的义务。', tags: JSON.stringify(['termination']) },
    { clause_id: 'C12', section: '终止条件', title: '重大违约即期终止', body: '如一方发生重大违约,守约方有权立即书面通知违约方终止本协议,无需提前通知期,且不影响守约方追究违约责任的权利。', tags: JSON.stringify(['termination']) },
    { clause_id: 'C13', section: '争议解决', title: '争议解决方式', body: '因本协议引起的或与本协议有关的任何争议,双方应首先通过友好协商解决;协商不成的,任何一方可向甲方所在地有管辖权的人民法院提起诉讼。', tags: JSON.stringify(['dispute_resolution']) },
    { clause_id: 'C14', section: '其他', title: '不可抗力', body: '因不可抗力事件导致一方无法履行本协议义务的,该方应在不可抗力事件发生后5天内书面通知对方,并提供相关证明,可免除相应的违约责任。', tags: JSON.stringify(['force_majeure']) },
    { clause_id: 'C15', section: '其他', title: '协议完整性', body: '本协议构成双方就本协议事项的完整协议,取代此前的所有口头或书面沟通。本协议的任何修改需经双方书面签署方可生效。', tags: JSON.stringify(['miscellaneous']) }
  ];

  for (const c of clauses) {
    runSql(
      'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
      [contractId, c.clause_id, c.section, c.title, c.body, c.tags]
    );
  }

  const conflictsResult = detectConflicts(contractId);
  console.log(`Detected ${conflictsResult.conflicts.length} conflicts.`);

  const risksResult = annotateRisks(contractId);
  console.log(`Annotated ${risksResult.annotations.length} risk items.`);

  const complianceRules = [
    {
      name: '保密条款期限要求',
      description: '保密条款必须包含期限相关关键词',
      target_tags: ['confidentiality'],
      check_type: 'contains',
      check_params: { keywords: ['期限', '年', '个月', '天', '永久', '长期'] },
      severity: 'major',
      suggestion: '建议在保密条款中明确保密期限，例如"保密期限为协议终止后2年"'
    },
    {
      name: '责任上限最低要求',
      description: '责任上限不得低于合同金额的5%',
      target_tags: ['liability_cap'],
      check_type: 'numeric_range',
      check_params: { type: 'percentage', min: 5, max: undefined },
      severity: 'critical',
      suggestion: '建议将责任上限提高至合同金额的5%或以上，以合理分配风险'
    },
    {
      name: '付款期限限制',
      description: '付款期不得超过60天',
      target_tags: ['payment_term'],
      check_type: 'duration_range',
      check_params: { min_days: undefined, max_days: 60 },
      severity: 'major',
      suggestion: '建议缩短付款期限至60天以内，或增加逾期付款违约金条款'
    },
    {
      name: '终止条款通知期要求',
      description: '终止条款必须包含通知期',
      target_tags: ['termination'],
      check_type: 'duration_range',
      check_params: { min_days: 30, max_days: undefined },
      severity: 'minor',
      suggestion: '建议设置不少于30天的终止通知期，给予双方充分的准备时间'
    },
    {
      name: '转让限制条款要求',
      description: '合同必须包含转让限制条款',
      target_tags: ['transfer_restriction'],
      check_type: 'required_field',
      check_params: {},
      severity: 'minor',
      suggestion: '建议添加转让限制条款，明确未经对方同意不得转让合同权利义务'
    }
  ];

  for (const rule of complianceRules) {
    createRule(rule);
  }
  console.log(`Created ${complianceRules.length} compliance rules.`);

  const findings = auditContract(contractId);
  const violations = findings.filter(f => f.status === 'violation');
  console.log(`Audited contract: ${violations.length} compliance violations found.`);

  seedNegotiationPositions(contractId);
  console.log('Seeded negotiation positions for C05, C07, C09, C11 clauses.');

  seedExecutionPlan(contractId);

  const demoWorkflow = seedDemoWorkflow(contractId);
  if (demoWorkflow) {
    console.log(`Seeded demo workflow: status=${demoWorkflow.status}, current_step=${demoWorkflow.current_step?.role || 'N/A'}`);
  }

  const idxResult = buildIndex();
  console.log(`Search index built: ${idxResult.indexed_clauses_count} clauses, ${idxResult.total_terms} terms.`);

  console.log('Generating semantic fingerprint for demo contract revision=1...');
  const fpResult = generateFingerprint(contractId, 1);
  if (!fpResult.error) {
    console.log(`Semantic fingerprint generated: ${fpResult.clauses_processed} clauses, ${fpResult.total_triples} triples.`);
  }

  console.log('Seeding cross-contract conflict demo contracts (A/B/C)...');

  const contractAResult = runSql(
    'INSERT INTO contracts (title, parties) VALUES (?, ?)',
    ['星辰科技-浩瀚数据 独家技术服务合作协议(A合同)', JSON.stringify(['甲方: 星辰科技有限公司', '乙方: 浩瀚数据技术有限公司'])]
  );
  const contractAId = contractAResult.lastInsertRowid;

  const clausesA = [
    { clause_id: 'A01', section: '合作范围', title: '合作内容', body: '乙方为甲方提供数据分析平台开发、运维支持及相关咨询技术服务,服务范围涵盖甲方核心业务系统的全生命周期技术支持。', tags: JSON.stringify(['scope']) },
    { clause_id: 'A02', section: '合作范围', title: '独家合作条款', body: '本协议合作期间内,甲方不得与任何第三方签订与本协议项下同类或类似的技术服务合作协议,乙方为甲方该类服务的独家合作方。未经乙方书面同意,甲方不得就本协议所涉服务内容与其他任何第三方开展合作。', tags: JSON.stringify(['exclusivity', 'scope']) },
    { clause_id: 'A03', section: '权利义务', title: '责任上限', body: '任何情况下,乙方对本协议项下产生的所有损失的总赔偿责任不超过合同总金额的5%,即不超过15万元。', tags: JSON.stringify(['liability_cap']) },
    { clause_id: 'A04', section: '付款条件', title: '付款期限', body: '甲方应在收到乙方出具的合格发票后120天内将服务费用支付至乙方指定账户,逾期按日万分之五支付违约金。', tags: JSON.stringify(['payment_term']) },
    { clause_id: 'A05', section: '保密义务', title: '保密义务', body: '双方应对在合作过程中获知的对方保密信息严格保密,保密期限为自协议终止后6个月。', tags: JSON.stringify(['confidentiality']) },
    { clause_id: 'A06', section: '终止条件', title: '终止通知期', body: '任何一方拟终止本协议,应提前15天以书面形式通知对方。', tags: JSON.stringify(['termination']) }
  ];

  for (const c of clausesA) {
    runSql(
      'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
      [contractAId, c.clause_id, c.section, c.title, c.body, c.tags]
    );
  }

  const conflictsA = detectConflicts(contractAId);
  const risksA = annotateRisks(contractAId);
  console.log(`  Contract A (id=${contractAId}): ${conflictsA.conflicts.length} conflicts, ${risksA.annotations.length} risks.`);

  const contractBResult = runSql(
    'INSERT INTO contracts (title, parties) VALUES (?, ?)',
    ['星辰科技-星云智联 数据分析服务外包协议(B合同)', JSON.stringify(['甲方: 星辰科技有限公司', '乙方: 星云智联科技有限公司'])]
  );
  const contractBId = contractBResult.lastInsertRowid;

  const clausesB = [
    { clause_id: 'B01', section: '服务内容', title: '外包服务范围', body: '乙方为甲方提供数据分析平台开发及运维技术服务,乙方作为甲方的第三方服务商,承接甲方核心业务系统的数据分析模块外包开发工作。', tags: JSON.stringify(['scope']) },
    { clause_id: 'B02', section: '服务内容', title: '第三方服务合作确认', body: '甲乙双方确认,乙方作为独立第三方服务商为甲方提供本协议项下的技术服务,甲方有权与其他合作方同时开展同类服务合作。', tags: JSON.stringify(['scope']) },
    { clause_id: 'B03', section: '权利义务', title: '责任上限', body: '任何情况下,乙方对本协议项下产生的直接损失的总赔偿责任不低于合同总金额的30%,即不低于90万元,乙方承担全部连带责任。', tags: JSON.stringify(['liability_cap']) },
    { clause_id: 'B04', section: '付款条件', title: '付款期限', body: '甲方应在收到乙方出具的合格发票后30天内将服务费用支付至乙方指定账户,逾期按日万分之三支付违约金。', tags: JSON.stringify(['payment_term']) },
    { clause_id: 'B05', section: '保密义务', title: '保密期限', body: '双方保密义务期限为自协议签订之日起永久有效,不因协议终止而失效。', tags: JSON.stringify(['confidentiality']) },
    { clause_id: 'B06', section: '终止条件', title: '终止通知期', body: '任何一方拟终止本协议,应提前60天以书面形式通知对方,并给予合理的工作交接期。', tags: JSON.stringify(['termination']) },
    { clause_id: 'B07', section: '权利义务', title: '转让许可', body: '经对方书面同意后,一方可将本协议项下的权利义务转让给其指定的第三方合作伙伴。', tags: JSON.stringify(['transfer_permission']) }
  ];

  for (const c of clausesB) {
    runSql(
      'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
      [contractBId, c.clause_id, c.section, c.title, c.body, c.tags]
    );
  }

  const conflictsB = detectConflicts(contractBId);
  const risksB = annotateRisks(contractBId);
  console.log(`  Contract B (id=${contractBId}): ${conflictsB.conflicts.length} conflicts, ${risksB.annotations.length} risks.`);

  const contractCResult = runSql(
    'INSERT INTO contracts (title, parties) VALUES (?, ?)',
    ['星辰科技-浩瀚数据 技术服务补充协议(C合同)', JSON.stringify(['甲方: 星辰科技有限公司', '乙方: 浩瀚数据技术有限公司'])]
  );
  const contractCId = contractCResult.lastInsertRowid;

  const clausesC = [
    { clause_id: 'C01', section: '补充条款', title: '补充协议效力', body: '本补充协议为《星辰科技-浩瀚数据 独家技术服务合作协议》(A合同)的不可分割组成部分,与原协议具有同等法律效力。本补充协议与原协议约定不一致的,以本补充协议为准。', tags: JSON.stringify(['miscellaneous']) },
    { clause_id: 'C02', section: '补充条款', title: '独家合作条款变更', body: '经双方协商一致,原协议独家合作条款修改为:甲方在保证乙方主要服务供应商地位的前提下,可根据业务需要与其他第三方服务商签订同类技术服务合作协议,但应提前30天书面通知乙方。', tags: JSON.stringify(['scope']) },
    { clause_id: 'C03', section: '补充条款', title: '责任上限补充', body: '本补充协议项下,乙方对甲方的赔偿责任上限调整为不超过合同总金额的20%,即不超过60万元,该限额仅适用于直接损失赔偿。', tags: JSON.stringify(['liability_cap']) },
    { clause_id: 'C04', section: '补充条款', title: '付款期限调整', body: '原协议付款期限由120天调整为45天,甲方应在收到合格发票后45天内完成付款。', tags: JSON.stringify(['payment_term']) },
    { clause_id: 'C05', section: '补充条款', title: '保密期限延长', body: '双方保密义务期限延长至自协议终止后3年,原协议6个月保密期限条款不再适用。', tags: JSON.stringify(['confidentiality']) },
    { clause_id: 'C06', section: '补充条款', title: '转让限制', body: '未经对方事先书面同意,任何一方不得将本补充协议及原协议项下的任何权利义务转让给第三方。', tags: JSON.stringify(['transfer_restriction']) }
  ];

  for (const c of clausesC) {
    runSql(
      'INSERT INTO clauses (contract_id, clause_id, section, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)',
      [contractCId, c.clause_id, c.section, c.title, c.body, c.tags]
    );
  }

  const conflictsC = detectConflicts(contractCId);
  const risksC = annotateRisks(contractCId);
  console.log(`  Contract C (id=${contractCId}): ${conflictsC.conflicts.length} conflicts, ${risksC.annotations.length} risks.`);

  const crossContractIds = [contractAId, contractBId, contractCId];
  for (const cid of crossContractIds) {
    const fpR = generateFingerprint(cid, 1);
    if (!fpR.error) {
      console.log(`  Contract id=${cid} fingerprint: ${fpR.clauses_processed} clauses, ${fpR.total_triples} triples.`);
    }
  }

  const idxResult2 = buildIndex();
  console.log(`Search index rebuilt: ${idxResult2.indexed_clauses_count} clauses, ${idxResult2.total_terms} terms.`);

  console.log('Demo data seeded successfully.');
}

module.exports = { seed };
