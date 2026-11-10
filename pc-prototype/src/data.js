const banks = {
  微观经济学: [
    ['单选题','需求函数 Q = 120 − 3P，当 P = 20 时，需求价格弹性为多少？',['−2','−1','−0.5','−0.25'],'−1','由 Q = 60，弹性 = (−3) × 20 / 60 = −1。','需求价格弹性'],
    ['单选题','完全竞争厂商的短期供给曲线是边际成本曲线在什么以上的部分？',['平均可变成本最低点','平均总成本最低点','平均固定成本最低点'],'平均可变成本最低点','低于停产点时，价格不足以弥补平均可变成本。','短期供给'],
    ['计算题','需求 Qd = 80 − 2P，供给 Qs = 20 + P。求均衡价格与数量。',[], '价格 20，数量 40','令 80 − 2P = 20 + P，再代入任一函数。','市场均衡'],
    ['简答题','解释为什么对需求缺乏弹性的商品提价可能提高销售收入。',[],'价格上升比例超过销量下降比例。','结合总收入 P × Q 说明，并限定为小幅价格变动。','弹性与收入'],
    ['单选题','其他条件不变，消费者收入增加时，正常品的需求曲线如何移动？',['向左','向右','不变'],'向右','在各个给定价格上，消费者愿意购买更多正常品。','需求曲线'],
    ['计算题','需求 Qd = 100 − P，供给 Qs = P。向卖方征收每单位 20 元税，求买卖双方价格。',[],'买方 60 元，卖方 40 元','令 Pb = Ps + 20，且 100 − Pb = Ps。','税负归宿'],
    ['单选题','当边际成本低于平均成本时，平均成本如何变化？',['下降','上升','保持不变'],'下降','新增单位成本低于当前平均值，会拉低平均成本。','成本曲线'],
    ['简答题','区分需求量变动和需求变动，并各举一个原因。',[],'自身价格变化引起沿需求曲线移动，收入变化可使需求曲线移动。','先区分曲线内移动和整条曲线移动，再给出例子。','需求曲线'],
    ['单选题','供给完全无弹性时，单位税主要由谁负担？',['买方','卖方','双方各一半'],'卖方','供给量不随价格变化，卖方净得价格下降。','税负归宿']
  ],
  高等数学: [
    ['单选题','函数 f(x) = x³ 的导数是什么？',['x²','3x²','3x'],'3x²','应用幂函数求导公式。','导数'],
    ['计算题','求 ∫₀¹ (2x + 1) dx。',[],'2','原函数为 x² + x，在上下限代入作差。','定积分'],
    ['单选题','下列哪个函数在全体实数上连续？',['1/x','x²','ln x'],'x²','多项式在全体实数上连续。','连续性'],
    ['计算题','求函数 f(x) = x² − 4x + 7 的最小值。',[],'最小值 3，在 x = 2 取得。','配方得到 (x − 2)² + 3。','极值']
  ],
  大学英语: [
    ['单选题','Choose the correct form: She ___ here since 2020.',['lives','has lived','lived'],'has lived','Since 2020 connects a past starting point with the present.','现在完成时'],
    ['简答题','Translate into English: 我期待与你合作。',[],'I look forward to working with you.','In look forward to, to is a preposition followed by a gerund.','动名词'],
    ['单选题','Choose the correct form: If I ___ you, I would apply.',['am','was','were'],'were','Use were for the hypothetical condition.','虚拟语气'],
    ['简答题','Write one sentence contrasting two study methods using although.',[],'Although rereading is easy, active recall takes more effort.','Use although to introduce the concessive clause.','让步状语从句']
  ],
  管理学: [
    ['单选题','制定目标并明确行动路径属于哪项管理职能？',['计划','组织','控制'],'计划','计划职能包括确立目标和选择实现目标的路径。','管理职能'],
    ['简答题','简述授权时应明确的两个要素。',[],'明确授权范围和结果责任。','可补充反馈机制及权限边界。','组织授权'],
    ['单选题','将实际绩效与目标比较属于哪项管理职能？',['领导','控制','组织'],'控制','控制包括测量绩效、比较和纠偏。','管理控制'],
    ['简答题','说明反馈控制与前馈控制的区别。',[],'反馈控制基于已发生的结果；前馈控制在行动前识别偏差。','说明实施时点，并各举一例。','管理控制']
  ],
};

const predictions = {
  微观经济学: ['计算题','需求 Qd = 120 − 2Pb，供给 Qs = 3Ps。对卖方征收每单位 10 元税。求均衡交易量，并解释买卖双方如何分担税负。',[],'买方价格 30，卖方净价 20，交易量 60。买方承担 6 元，卖方承担 4 元。','无税时价格为 24。征税后令 Pb = Ps + 10，代入供需相等。','市场均衡与税负归宿'],
  高等数学: ['计算题','求 f(x) = x³ − 3x 在区间 [0, 2] 上的最大值与最小值。',[],'最大值 2，最小值 −2。','由导数求驻点 x = 1，再比较驻点与两个端点的函数值。','导数与极值'],
  大学英语: ['简答题','用 although 和现在完成时写一句话，表达虽然复习很难，你从周一以来一直在坚持。',[],'Although revision is difficult, I have kept at it since Monday.','让步从句用 although，since Monday 对应现在完成时。','让步从句与现在完成时'],
  管理学: ['简答题','团队新项目频繁延期。说明如何将目标设定、前馈控制和反馈控制结合起来。',[],'设定明确里程碑，启动前评估风险，每周比较计划与实际进度并纠偏。','评分要点包括明确目标、事前防范与事后纠偏。','计划与控制'],
};

const predictionSections = {
  微观经济学: [
    ['单选题','需求不变、生产成本下降时，均衡价格如何变化？',['上升','下降','不变'],'下降','供给右移，均衡价格下降。','供给变动'],
    ['单选题','提价后总收益增加，该区间需求弹性如何？',['富有弹性','缺乏弹性','单位弹性'],'缺乏弹性','销量降幅小于价格升幅。','需求弹性与收益'],
    ['简答题','低于均衡价格的最高限价会怎样影响市场？',[],'产生短缺。','需求量大于供给量。','价格管制'],
    ['计算题','固定成本为 30，生产 5 单位的变动成本为 20。求平均总成本。',[],'10。','(30 + 20) / 5 = 10。','平均成本']
  ],
  高等数学: [
    ['单选题','当 x 趋近于 0 时，sin(2x)/x 的极限是多少？',['0','1','2'],'2','利用 sin(t)/t 趋近于 1。','重要极限'],
    ['单选题','若 f 在 a 处可导，哪项必成立？',['f 在 a 连续','f 在 a 取极值','f 的导数在 a 连续'],'f 在 a 连续','可导推出连续。','可导与连续'],
    ['简答题','如何用导数的符号变化判断局部极大值点？',[],'在该点左侧导数为正，右侧导数为负。','比较两侧单调性。','一阶导数判别'],
    ['计算题','求 ∫₀² (3x² + 1) dx。',[],'10。','原函数为 x³ + x，代入上下限。','定积分']
  ],
  大学英语: [
    ['单选题','I have lived here ___ 2023.',['since','for','during'],'since','具体起始时间用 since。','现在完成时'],
    ['单选题','___ it was raining, we walked to class.',['Although','Because of','Unless'],'Although','前后句构成让步关系。','让步连词'],
    ['简答题','Rewrite “The committee approved the plan” in the passive voice.',[],'The plan was approved by the committee.','一般过去时用 was + 过去分词。','被动语态'],
    ['简答题','Join the sentences using a relative clause. The tutor helped us. She teaches writing.',[],'The tutor who teaches writing helped us.','用 who 指代人，在从句中作主语。','定语从句']
  ],
  管理学: [
    ['单选题','分配团队任务并明确汇报关系属于哪项职能？',['计划','组织','控制'],'组织','组织职能安排任务、资源和权责。','组织职能'],
    ['单选题','在供应商交货前检查其质量认证，属于哪类控制？',['前馈控制','反馈控制','事后考核'],'前馈控制','认证检查发生在问题可能出现之前。','前馈控制'],
    ['简答题','授权后，管理者如何追踪工作进展？',[],'明确交付标准，设置检查节点，通过反馈纠偏。','覆盖标准、监测和反馈。','授权与监督'],
    ['简答题','当部门目标冲突时，管理者应如何协调？',[],'明确共同目标，澄清资源和责任，协商可执行的安排。','先统一判断标准，再处理分歧。','跨部门协调']
  ]
};

function question(row, paperId, index, source) {
  const [type, prompt, options, answer, explanation, topic] = row;
  return { id: paperId + '-' + index, paperId, no: index + 1, source, type, prompt, options, answer, explanation, topic, verified: true };
}

export const initialCourses = Object.entries(banks).map(([name, bank], courseIndex) => {
  const id = 'course-' + courseIndex;
  const chunks = name === '微观经济学' ? [bank.slice(0, 3), bank.slice(3, 6), bank.slice(6)] : [bank.slice(0, 2), bank.slice(2)];
  return {
    id, name, teacher: ['王老师','李老师','陈老师','赵老师'][courseIndex], term: '本学期',
    papers: chunks.map((chunk, index) => {
      const paperId = id + '-paper-' + index;
      const title = '模拟卷' + ['一','二','三'][index];
      return { id: paperId, title, pages: [], questions: chunk.map((row, i) => question(row, paperId, i, title)) };
    }),
    prediction: [predictions[name], ...predictionSections[name]].map((row, index) =>
      question(row, id + '-prediction', index, name + '预测卷')).sort((a, b) =>
      ['单选题', '简答题', '计算题'].indexOf(a.type) - ['单选题', '简答题', '计算题'].indexOf(b.type)).map((q, index) => ({ ...q, no: index + 1 })),
  };
});

export const initialLearned = Object.fromEntries(initialCourses.flatMap((course, index) =>
  (index === 3 ? course.papers : index < 2 ? course.papers.slice(0, 1) : [])
    .flatMap(paper => paper.questions.map(q => [q.id, true]))
));

// The recognition demo replays a checked result for the bundled PDF.
export const demoPaperTitle = '高等数学期末模拟试卷 A 卷';
export const demoPaperSubject = '高等数学';
export const demoPaperQuestions = [
  ...banks.高等数学,
  ['多选题','关于可导与连续，下列哪些说法正确？（　）',['可导必连续','连续必可导','多项式处处可导','绝对值函数在原点可导'],'AC','可导推出连续。多项式处处可导，绝对值函数在原点的左右导数不同。','可导与连续'],
  ['简答题','说明如何用导数判定函数在某区间单调递增。',[],'若函数在区间内可导且导数恒大于零，则函数在该区间严格递增。','在区间内任选两点，利用拉格朗日中值定理比较函数值。','导数与单调性'],
].sort((a,b) => ['单选题','多选题','计算题','简答题'].indexOf(a[0]) - ['单选题','多选题','计算题','简答题'].indexOf(b[0]))
  .map((row,index) => question(row,'demo-pdf',index,demoPaperTitle));

export function demoRecognitionQuestions(id) {
  return demoPaperQuestions.map(q => ({ ...q, id: id + '-' + q.no, paperId: id, page: q.no <= 3 ? 1 : 2 }));
}

export function demoPredictionFor(paper) {
  const sourceNos = [1, 2, 4, 6, 4];
  return initialCourses.find(course => course.name === demoPaperSubject).prediction.map((q, index) => ({
    ...q, id: paper.id + '-prediction-' + q.no, paperId: paper.id + '-prediction',
    sourceNo: sourceNos[index], evidence: paper.questions.find(item => item.no === sourceNos[index])?.topic,
  }));
}
