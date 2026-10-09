# TypeScript toolchain-01 全部产品脚本以 TS 维护
# TypeScript toolchain-02 干净构建与类型检查
# TypeScript toolchain-03 类型错误不能被迁移掩盖
Feature: TypeScript toolchain
  Background:
    Given 当前项目来自不含生成脚本的干净 checkout
    And 已按锁文件安装项目依赖

  Scenario Outline: TypeScript toolchain-01 全部产品脚本以 TS 维护
    When 检查产品范围 "<scope>" 的维护源码
    Then 该范围的全部手写脚本均为参与类型检查的 TypeScript
    And 不保留同一逻辑的手写 JavaScript 副本

    Examples:
      | scope                       |
      | worker                      |
      | minimal-extension           |
      | features/step_definitions   |

  Scenario: TypeScript toolchain-02 干净构建与类型检查
    When 依次运行 npm run typecheck 和 npm run build
    Then 两个命令均成功退出
    And 严格类型检查覆盖 worker、扩展和验收步骤
    And 构建结果不依赖全局 TypeScript 工具或旧 JS 文件
    And 再次构建无需手工修复或复制脚本

  Scenario Outline: TypeScript toolchain-03 类型错误不能被迁移掩盖
    Given 在隔离副本中对迁移后的 "<domain>" 类型的 "<field>" 字段赋予字符串值
    When 对该副本运行项目类型检查命令
    Then 命令因该字段的类型不匹配而失败
    And 失败不是缺少工具、依赖或配置造成的启动错误

    Examples:
      | domain            | field           |
      | subtitle cue      | start           |
      | extension settings | translateWhole  |
