import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ambiguousOrdinal, blindCheck, generatePrediction, missingContainerState, predictionBlueprint } from '../dist/server/prediction-model.js';

const sources = ['栈操作', '队列操作', '顺序表操作', '搜索条件'].map((stem, index) => ({
  id: String(index), stem, kind: 'calculation', paperId: 'source-paper', title: '源卷', page: 1
}));
const response = value => Response.json({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 }
});

test('filters a contradictory candidate, binds evidence server-side and keeps the valid questions', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  process.env.DASHSCOPE_API_KEY = 'stub';
  assert.equal(predictionBlueprint(sources).length, 4);
  const stems = ['空栈压入九后求栈顶。', '按先进先出规则移除一个元素，队首是多少？',
    '在顺序表第四位插入后移动几个元素？', '把查找区间缩小一次后剩余多少元素？'];
  const calls = [];
  const output = await generatePrediction(sources, async (_url, { body }) => {
    const parsed = JSON.parse(body);
    const input = JSON.parse(parsed.messages.at(-1).content.split('\n').at(-1));
    if (parsed.enable_thinking) {
      assert.deepEqual(Object.keys(input).sort(), ['kind', 'stem']);
      const index = stems.indexOf(input.stem);
      return response({ solvable: true, answer: index === 1 ? '19' : '9' });
    }
    if (input.proposedAnswer) return response({ independentAnswer: input.proposedAnswer, supported: true });
    const index = sources.findIndex(item => item.stem === input.evidence.stem);
    return response({ stem: stems[index], sourceIds: ['made-up'], answer: index === 1 ? '23' : '9',
      explanation: '依据定义推算。', rationale: '改编了操作流程。', knowledgePoints: ['基础操作'] });
  }, call => calls.push(call));
  assert.deepEqual(output.map(item => item.sourceIds[0]).sort(), ['0', '2', '3']);
  assert.equal(calls.filter(call => call.stage === 'blind_check' && call.outcome === 'rejected').length, 1);
  const impossible = { kind: 'choice', stem: '一棵二叉树第三层有五个结点。', answer: 'C',
    explanation: '第三层容量为五。', sourceIds: ['0'], rationale: '核对容量。' };
  assert.equal(await blindCheck('https://example.test/', impossible,
    async () => response({ solvable: false, answer: '' }), () => {}), false);
  assert.equal(ambiguousOrdinal('先出队一次、入队25，再连续出队两次。第二次出队的值是多少？'), true);
  assert.equal(ambiguousOrdinal('先出队一次、入队25，再连续出队两次。最后两次出队中的第二次得到什么值？'), false);
  assert.equal(missingContainerState('依次入队5、3、8，出队一次，再入队1。此时队列头部是哪一个？'), true);
  assert.equal(missingContainerState('初始为空队列。依次入队5、3、8，出队一次。此时队首是哪一个？'), false);
});

test('withholds a full prediction paper when a planned question fails verification', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  process.env.DASHSCOPE_API_KEY = 'stub';
  const evidence = [...sources, { ...sources[0], id: '4', stem: '函数积分' }];
  const stems = ['空栈压入九后求栈顶。', '一个空容器加入三个值后求队尾。', '在顺序表第四位插入后移动几个元素？',
    '把查找区间缩小一次后剩余多少元素？', '计算二次函数在指定区间上的面积。'];
  assert.equal(predictionBlueprint(evidence).length, 5);
  await assert.rejects(generatePrediction(evidence, async (_url, { body }) => {
    const parsed = JSON.parse(body);
    const input = JSON.parse(parsed.messages.at(-1).content.split('\n').at(-1));
    if (parsed.enable_thinking) return response({ solvable: true, answer: input.stem === stems[4] ? '8' : '9' });
    if (input.proposedAnswer) return response({ independentAnswer: input.proposedAnswer, supported: true });
    const index = evidence.findIndex(item => item.stem === input.evidence.stem);
    return response({ stem: stems[index], answer: '9', explanation: '依据定义推算。', rationale: '改编了操作流程。', knowledgePoints: ['基础操作'] });
  }), /PREDICTION_VERIFICATION_FAILED/);
});
