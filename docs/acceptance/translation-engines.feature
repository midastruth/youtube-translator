Feature: 仅保留正式翻译引擎
  Scenario: 设置页仅提供当前支持的两种翻译模式
    Given 打开构建后的翻译设置页
    When 读取可选择的翻译引擎
    Then 只提供 document 多 Agent 和 legacy 快速模式

  Scenario: 已删除的引擎不能隐式启动旧工作流
    When 向 Worker 提交已删除的 agent 引擎
    Then 明确拒绝而不是回退到旧原型或快速模式
