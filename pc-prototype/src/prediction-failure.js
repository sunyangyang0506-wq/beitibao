export const predictionFailureLabels = {
  MODEL_BUDGET_LIMIT: '已达到当天模型预算，已生成的练习仍可使用。',
  MODEL_RATE_LIMIT: '当前已达到推理容量，请稍后重试。',
  PREDICTION_TIMEOUT: '模型响应超时，请稍后重试。',
  PREDICTION_RATE_LIMITED: '模型调用暂时限流，请稍后重试。',
  PREDICTION_VERIFICATION_FAILED: '通过复算的候选题数量不足，请重试。',
  INVALID_PREDICTION: '本次题目没有通过结构或证据校验，请重试。',
  MODEL_NOT_CONFIGURED: '后台预测模型尚未配置。',
  MODEL_AUTHENTICATION_FAILED: '模型服务凭据验证失败，请联系管理员检查配置，修复后再重试。',
  MODEL_ACCESS_DENIED: '模型服务访问被拒绝，请联系管理员核对权限，恢复后再重试。',
  MODEL_PAYMENT_REQUIRED: '模型服务因欠费或额度不足暂停，请联系管理员核对账单，恢复后再重试。',
  MODEL_SERVICE_NOT_ENABLED: '所需模型服务尚未开通，请联系管理员核对业务空间及服务权限，开通后再重试。'
};

export function predictionFailureMessage(code) {
  return predictionFailureLabels[code] ?? '请稍后重试。';
}
