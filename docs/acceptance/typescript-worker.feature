# TypeScript worker compatibility-01 启动入口仍提供内部 HTTP 接口
# TypeScript worker compatibility-02 提交任务仍可读取快照与字幕流
# TypeScript worker compatibility-03 迁移不改变任务缓存键
Feature: TypeScript worker compatibility
  Background:
    Given 已安装锁定依赖并从 TS 源码构建 worker

  Scenario Outline: TypeScript worker compatibility-01 启动入口仍提供内部 HTTP 接口
    Given TRANSLATION_AGENT_STORAGE 指向场景独占的临时数据库
    And TRANSLATION_AGENT_PORT 配置为 "<port_setting>"
    When 使用 npm run worker 启动真实服务
    Then 服务在端口 <port> 响应 GET /internal/health 为 200 且 ready 为 true
    And GET /internal/jobs/missing-job 响应 404 且 error 为 "Job not found"

    Examples:
      | port_setting | port  |
      | 未设置       | 8788  |
      | 18788        | 18788 |

  Scenario Outline: TypeScript worker compatibility-02 提交任务仍可读取快照与字幕流
    Given 构建后的内部 HTTP 服务使用场景独占数据库且就绪
    And 脚本化模型将源文 "<text>" 翻译为 "<translation>" 并通过审校
    When 向 POST /internal/jobs 提交 cue_id 为 "<cue_id>"、start 为 <start>、end 为 <end> 的该源字幕
    Then 响应为 200 且包含非空的 job_id、job_key 和 status
    And 使用返回的 job_id 读取字幕流最终得到成功 cue 和 done
    And 成功 cue 的 cue_id、text、start、end 与提交值一致且 translation 为 "<translation>"
    And done 的 total_cues 为 1 且 failed_cues 为 0
    And 使用返回的 job_id 读取快照响应为 200 且 status 为 "succeeded"
    And 快照的 published_cues 与 final_result 包含同一条完整字幕

    Examples:
      | cue_id | start | end  | text    | translation |
      | c0     | 100   | 1100 | Hello   | 你好        |
      | c9     | 2050  | 4321 | Goodbye | 再见        |

  Scenario Outline: TypeScript worker compatibility-03 迁移不改变任务缓存键
    Given 视频为 "migration-video" 且源字幕为 c0、100 毫秒到 1100 毫秒、文本 "<text>"
    And 任务缓存配置使用迁移前 keys 模块的默认值
    When 使用迁移后的实际缓存键函数计算 job_key
    Then job_key 精确等于迁移前冻结的 "<job_key>"

    Examples:
      | text    | job_key                                                                                |
      | Hello   | job:migration-video:8702a08ae1a75342b21ce2c4836358fdb3f9ffa93fef5680f86804a4b63d4b00 |
      | Goodbye | job:migration-video:31461e48e8ed5b21b8578aff17a80fb5809c830e386ad9a5257e14e1812d3153 |
