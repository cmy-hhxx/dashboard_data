/* 评测接口使用指南 (doc=api): progressive 5-chapter editorial document covering 5003 供数接口, 5002 页面接口, 口径与增量同步规范. */
import { $, $$, esc, copyBtnHTML } from "./core.js";

const API_ENVS = [
  { id: "public", label: "外网直连", base: "http://10.217.219.2:2477/api/v1/analysis" },
  { id: "cluster", label: "集群内网", base: "http://interactive-s3ynzadcvm9c:5003/api/v1/analysis" },
  { id: "local", label: "本机调试", base: "http://127.0.0.1:5003/api/v1/analysis" },
  { id: "var", label: "$API 变量", base: "$API" },
];

const PAGE_HOSTS = {
  aime: { label: "AIME · 弗吉尼亚 :2476", base: "http://10.217.219.2:2476" },
  wencai: { label: "问财 · 乌兰察布 :2833", base: "http://117.50.195.94:2833" },
};

function cmdBox(title, tpl) {
  return `<div class="dc-codebox">
    <div class="dc-codehead"><span>${esc(title)}</span>${copyBtnHTML("复制命令", { pre: true })}</div>
    <pre class="code" data-api-tpl="${esc(tpl)}">${esc(tpl.replace(/\{\{API\}\}/g, API_ENVS[0].base))}</pre>
  </div>`;
}

function envBarHTML() {
  const btns = API_ENVS.map((env, i) => `<button type="button" data-api-env="${env.id}" aria-pressed="${i === 0}">${esc(env.label)}</button>`).join("");
  return `<div class="api-env-bar">
    <div class="api-env-pills" role="group" aria-label="调用地址">${btns}</div>
    <code class="api-env-url num" data-api-base>${esc(API_ENVS[0].base)}</code>
    ${copyBtnHTML("复制基址", { fn: "apiBase" })}
  </div>`;
}

export function apiDocHTML() {
  return `<div class="doc-shell api-shell">
    <aside class="doc-side">
      <div class="dc-side-head">
        <button type="button" class="dc-back" data-back><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>全部文档</button>
      </div>
      <div class="doc-side-title">评测接口指南</div>
      <nav class="doc-toc" id="apiToc" aria-label="接口章节">
        <a href="#api-env"><span class="num">01</span><span>环境与链路</span></a>
        <a href="#api-rules"><span class="num">02</span><span>口径与协议</span></a>
        <a href="#api-endpoints"><span class="num">03</span><span>5003 供数接口</span></a>
        <a href="#api-sync"><span class="num">04</span><span>增量同步与升版</span></a>
        <a href="#api-page"><span class="num">05</span><span>5002 页面与排查</span></a>
      </nav>
    </aside>

    <div class="doc-main">
      <header class="doc-hero">
        <div class="doc-hero-top">
          <h1>评测接口指南</h1>
          ${copyBtnHTML("复制环境变量", { text: 'export API="http://10.217.219.2:2477/api/v1/analysis"\nexport PAGE="http://10.217.219.2:2476"' })}
        </div>
        <p class="doc-lead">5003 供数接口负责条件检索、多维聚合与位点增量拉取；5002 页面接口负责单条对话与聚类矩阵直达。典型链路先由 5003 <code>/traces</code> 查得 <code>trace_id</code> 与 <code>session_id</code>，再按 <code>case = split|model|session_id</code> 打开 5002 定位到对话具体轮次。</p>
        <div class="api-flow-box">
          <div class="api-flow-row"><span class="api-flow-tag">5003 供数</span><code>/api/v1/analysis/traces → trace_id / session_id</code></div>
          <div class="api-flow-row"><span class="api-flow-tag">5002 页面</span><code>/?product=aime&amp;case=split%7Cmodel%7Csession_id&amp;trace=&lt;trace_id&gt;</code></div>
        </div>
      </header>

      <section class="doc-sec" id="api-env" aria-label="环境与链路">
        <div class="doc-sec-head"><span class="doc-idx num">01</span><h2>部署环境与调用地址</h2></div>
        <p class="doc-lead">容器内部固定监听 5001（看板）、5002（页面）与 5003（供数）三个端口。当前仅弗吉尼亚（AIME）启用 5003 供数服务；乌兰察布（问财）5003 已停用。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>两套部署与端口映射</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>部署环境</th><th>宿主机 IP</th><th>容器名称</th><th>数据目录</th><th class="num">5003 供数</th><th class="num">5002 页面</th><th class="num">5001 看板</th><th class="num">SSH</th></tr></thead>
              <tbody>
                <tr><td><b>弗吉尼亚（AIME）</b></td><td><code>10.217.219.2</code></td><td><code>interactive-s3ynzadcvm9c</code></td><td><code>/mnt/aime_eval_ssd</code></td><td class="num">2477</td><td class="num">2476</td><td class="num">2475</td><td class="num">2473</td></tr>
                <tr><td><b>乌兰察布（问财）</b></td><td><code>117.50.195.94</code></td><td><code>interactive-i6piqwvlnsr5</code></td><td><code>/mnt/fin_bench/...</code></td><td class="num muted">停用</td><td class="num">2833</td><td class="num">2768</td><td class="num">2834</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="api-vars">
          <div class="api-var">
            <div class="api-var-head"><span>5003 供数基址</span>${copyBtnHTML("复制", { text: "http://10.217.219.2:2477/api/v1/analysis" })}</div>
            <code>http://10.217.219.2:2477/api/v1/analysis</code>
          </div>
          <div class="api-var">
            <div class="api-var-head"><span>5002 页面基址</span>${copyBtnHTML("复制", { text: "http://10.217.219.2:2476" })}</div>
            <code>http://10.217.219.2:2476</code>
          </div>
          <div class="api-var">
            <div class="api-var-head"><span>集群内直连</span>${copyBtnHTML("复制", { text: "http://interactive-s3ynzadcvm9c:5003/api/v1/analysis" })}</div>
            <code>http://interactive-s3ynzadcvm9c:5003/api/v1/analysis</code>
          </div>
        </div>
        ${envBarHTML()}
      </section>

      <section class="doc-sec" id="api-rules" aria-label="口径与协议">
        <div class="doc-sec-head"><span class="doc-idx num">02</span><h2>核心口径与协议约束</h2></div>
        <p class="doc-lead">接口遵循 Schema 2.0 统一外包与看板统计口径，调用方须确保未聚类编码不合并进「其他」、按美东日期聚合，且不把单轮 trace 当作整场 session。</p>
        <div class="cap-figs" style="--cols:4">
          <div class="cap-fig"><span class="cap-k">响应外包</span><b class="num">Schema 2.0</b><span class="cap-fig-detail"><code>{request_id, schema_version:"2.0", data, meta}</code>，<code>meta.filters</code> 回显生效条件。</span></div>
          <div class="cap-fig"><span class="cap-k">游标分页</span><b class="num">30 min 有效</b><span class="cap-fig-detail"><code>cursor</code> 过期返回 <code>410</code>；<code>/traces</code> 单页 ≤100（<code>ids_only=true</code> 时 ≤5000）。</span></div>
          <div class="cap-fig"><span class="cap-k">聚合与变更上限</span><b class="num">1,000 条</b><span class="cap-fig-detail"><code>/summary</code>、<code>/severity</code> 的 <code>limit</code> ≤1000；<code>/changes</code> 的 <code>page_size</code> ≤1000。</span></div>
          <div class="cap-fig"><span class="cap-k">校验与限流</span><b class="num">422 / 413</b><span class="cap-fig-detail">未知编码或严重度返回 <code>422</code>；<code>user_ids</code> &gt;5000 或 <code>trace_ids</code> &gt;1000 返回 <code>413</code>。</span></div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>核心概念与调用方约束</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th style="width:22%">概念 / 字段</th><th>口径定义</th><th style="width:32%">调用方约束</th></tr></thead>
              <tbody>
                <tr><td><b>trace</b></td><td>单轮对话记录；<code>trace_id</code> 取自归因 <code>turns[].meta.trace_id</code>（非外层 session_id）。</td><td>同一 session 的多轮各自独立计为一条 trace。</td></tr>
                <tr><td><b>problem</b></td><td>归因产出的问题条目，含 <code>label</code>、<code>severity</code>（P0–P4）、<code>component</code>、<code>evidence</code>。</td><td>无标准答案，<code>is_correct</code> 恒为 <code>null</code>。</td></tr>
                <tr><td><b>problem code</b></td><td>聚类编码（如 <code>S9.M5.1</code>）；仅已聚类问题具备。</td><td><code>code=null</code> 或 <code>problem_codes=[]</code> 表示<b>未聚类</b>，绝非“其他”或解析失败。</td></tr>
                <tr><td><b>day（美东日期）</b></td><td>按 <code>America/New_York</code>（含夏令时）从每条 trace 的 <code>meta.timestamp</code> 换算。</td><td>禁止用批次文件名日期代替 <code>day</code>；来源文件见详情 <code>data.file</code>。</td></tr>
                <tr><td><b>未聚类问题计数</b></td><td>照常计入 <code>problems</code> 总数与 P0–P4 分布。</td><td>按 <code>problem</code> 分组时归入 <code>{"problem": null}</code>，<code>problem_label</code> 固定为 <code>"未聚类"</code>。</td></tr>
                <tr><td><b>cluster_through</b></td><td><code>meta.cluster_through</code> 表示聚类已覆盖到的<b>批次日期</b>。</td><td>禁止用 <code>day &lt;= cluster_through</code> 判断单条是否已聚类；单条直接看 <code>code</code>。</td></tr>
                <tr><td><b>真实用户过滤</b></td><td>真实 <code>userid</code> = 纯数字且 ≤10 位（2026-11-17 口径）；其余视为测试账号。</td><td>测试账号整条 trace 不进入任何接口，规则与看板 <code>ut</code> 完全一致。</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="api-endpoints" aria-label="5003 供数接口">
        <div class="doc-sec-head"><span class="doc-idx num">03</span><h2>5003 供数接口手册</h2></div>
        <p class="doc-lead">以下接口均支持 GET 与同语义 POST，必填参数为 <code>dataset=aime_eval</code>。在下方切换目标环境后，所有示例命令会同步重写，可直接复制执行。</p>
        ${envBarHTML()}

        <div class="doc-sub">
          <div class="doc-sub-head"><h3>3.1 P0–P4 分布：<code>/severity</code></h3></div>
          <div class="api-ep-stack">
            ${cmdBox("全局分布", 'curl -s "{{API}}/severity?dataset=aime_eval"')}
            ${cmdBox("按版本分组", 'curl -s "{{API}}/severity?dataset=aime_eval&group_by=app_version"')}
            <div class="cap-table-wrap">
              <table class="cap-table">
                <tbody>
                  <tr><td style="width:26%"><code>severity.Pn.problems</code></td><td>该等级问题条目数；总 <code>problems</code> = 各等级之和 + <code>unlabeled</code>。</td></tr>
                  <tr><td><code>severity.Pn.traces</code></td><td>至少含一条该等级问题的 trace 数；分母为 <code>total.analyzed</code>。</td></tr>
                  <tr><td><code>group_by</code></td><td>支持 0–2 个维度：<code>intent / problem / day / user / app_version / source</code>。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="doc-sub">
          <div class="doc-sub-head"><h3>3.2 维度聚合：<code>/summary</code></h3></div>
          <div class="api-ep-stack">
            ${cmdBox("按问题顶层分组", 'curl -s "{{API}}/summary?dataset=aime_eval&group_by=problem&level=top"')}
            ${cmdBox("按美东日期分组", 'curl -s "{{API}}/summary?dataset=aime_eval&group_by=day"')}
            <div class="cap-table-wrap">
              <table class="cap-table">
                <tbody>
                  <tr><td style="width:26%"><code>level</code></td><td><code>top</code>（环节）/ <code>leaf</code>（最细编码）/ <code>children</code>（下一层），仅作用于 <code>intent</code>、<code>problem</code>。</td></tr>
                  <tr><td><code>problems / traces</code></td><td>按 <code>problem</code> 分组时各组 <code>problems</code> 之和 = <code>total.problems</code>；<code>traces</code> 会跨组重复。</td></tr>
                  <tr><td><code>analyzed</code></td><td>去掉 <code>problem / severity</code> 筛选、忽略 <code>problem</code> 分组维度后的总 trace 分母。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="doc-sub">
          <div class="doc-sub-head"><h3>3.3 检索列表：<code>/traces</code></h3></div>
          <div class="api-ep-stack">
            ${cmdBox("按严重度筛选", 'curl -s "{{API}}/traces?dataset=aime_eval&severity=P0&page_size=2"')}
            ${cmdBox("仅导出 trace_id", 'curl -s "{{API}}/traces?dataset=aime_eval&severity=P0&ids_only=true&page_size=1000"')}
            <div class="cap-table-wrap">
              <table class="cap-table">
                <tbody>
                  <tr><td style="width:26%">常用筛选</td><td><code>source</code>、<code>start_day / end_day</code>、<code>intent</code>、<code>problem</code>、<code>severity</code>、<code>app_version</code>、<code>user_ids</code>、<code>q</code>。</td></tr>
                  <tr><td><code>problems[]</code></td><td>列表精简为 <code>{code, current_code, label, severity, component, session_level}</code>。</td></tr>
                  <tr><td><code>ids_only=true</code></td><td>只返回 <code>trace_id</code> 便于导出；<code>trace_id</code> 跨模型/重跑不唯一，导出需去重。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="doc-sub">
          <div class="doc-sub-head"><h3>3.4 批量查询、单条详情与分类树</h3></div>
          <div class="api-ep-stack">
            ${cmdBox("批量查询（≤1000，仅 POST）", 'curl -s -X POST "{{API}}/traces/batch" -H \'Content-Type: application/json\' \\\n  -d \'{"dataset":"aime_eval","trace_ids":["<trace_id_1>","<trace_id_2>"]}\'')}
            ${cmdBox("单条详情（day 必填）", 'curl -s "{{API}}/traces/<trace_id>?dataset=aime_eval&day=2026-11-11"')}
            ${cmdBox("分类树", 'curl -s "{{API}}/taxonomy?kind=problem&app_version=AIME-Atlas_expert"')}
            <div class="cap-table-wrap">
              <table class="cap-table">
                <tbody>
                  <tr><td style="width:26%"><code>/traces/batch</code></td><td>未知或未分析 id 返回 <code>status:"not_analyzed"</code>；同 id 多版本自动合并。</td></tr>
                  <tr><td><code>/traces/{id}</code></td><td>返回 <code>data.file</code>（来源归因文件）、完整 <code>analysis.problems[]</code> 与 <code>analysis.history[]</code>。</td></tr>
                  <tr><td><code>session_level</code></td><td>跨轮问题只挂会话最后一轮（<code>session_level: true</code>），只计一次。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="api-sync" aria-label="增量同步与升版">
        <div class="doc-sec-head"><span class="doc-idx num">04</span><h2>增量同步与分类树升版</h2></div>
        <p class="doc-lead">归因文件会补数或整份重写，业务方禁止按时间窗口重拉，必须通过 <code>/changes</code> 按位点增量同步；同时问题展示名优先使用当前分类树的 <code>problem_label</code> 与 <code>current_code</code>。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>位点增量同步：<code>/changes</code></h3></div>
          <div class="doc-split">
            <div class="api-sync-cmds">
              ${cmdBox("1. 首次全量（不传 since，按 next_cursor 翻页）", 'curl -s "{{API}}/changes?dataset=aime_eval&page_size=500"')}
              ${cmdBox("2. 增量拉取（传入上一轮末尾的 next_since）", 'curl -s "{{API}}/changes?dataset=aime_eval&since=<next_since>"')}
              ${cmdBox("3. 获取在线完整同步文档与客户端伪代码", 'curl -s "{{API}}/docs/incremental"')}
            </div>
            <div class="cap-table-wrap">
              <table class="cap-table">
                <tbody>
                  <tr><td><b>复合主键</b></td><td>本地落库必须以 <code>(trace_id, day, app_version)</code> 为唯一键。</td></tr>
                  <tr><td><b>变更项与墓碑</b></td><td><code>items[]</code> 附带 <code>change:{seq, op, changed_at}</code>；<code>deleted[]</code> 为删除墓碑。</td></tr>
                  <tr><td><b>幂等与位点重置</b></td><td>先落库后存位点；索引重建返回 <code>409 SYNC_RESET</code> 时清空 <code>since</code> 重跑全量。</td></tr>
                  <tr><td><b>新鲜度探针</b></td><td>看响应 <code>meta.data_updated_at</code>、<code>meta.latest_seq</code> 或 <code>/healthz</code>。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>分类树升版兼容字段（版本见 <code>meta.taxonomy_version</code>）</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th>位置</th><th>字段名</th><th>含义与用法</th></tr></thead>
              <tbody>
                <tr><td><code>problems[]</code></td><td><code>current_code</code></td><td>当前分类树中的最近祖先编码。</td></tr>
                <tr><td><code>problems[]</code></td><td><code>legacy_code</code></td><td>仅旧版编码出现，值等于原始 <code>code</code>。</td></tr>
                <tr><td><code>problems[]</code></td><td><code>label</code></td><td>单条归因的问题描述文本（非分类树标准名称）。</td></tr>
                <tr><td>顶层</td><td><code>problem_current_codes</code></td><td>当前分类树下的编码去重列表。</td></tr>
                <tr><td>聚合分组</td><td><code>problem_label</code></td><td>当前分类树标准名称；<code>null</code> 组固定为 <code>"未聚类"</code>。</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="doc-sec" id="api-page" aria-label="5002 页面与排查">
        <div class="doc-sec-head"><span class="doc-idx num">05</span><h2>5002 页面深链与问题排查</h2></div>
        <p class="doc-lead">5002 索引缓存约 120 秒，跨产品访问直接返回 404。通过下方拼接器构造包含 <code>%7C</code> 编码的直达链接，或对照清单定位常见问题。</p>
        <div class="doc-sub">
          <div class="doc-sub-head"><h3>5002 对话页面链接拼接器</h3></div>
          <div class="api-builder">
            <div class="api-builder-row">
              <div class="api-env-pills" role="group" aria-label="选择产品">
                <button type="button" data-page-product="aime" aria-pressed="true">AIME（弗吉尼亚 :2476）</button>
                <button type="button" data-page-product="wencai" aria-pressed="false">问财（乌兰察布 :2833）</button>
              </div>
            </div>
            <div class="api-builder-fields">
              <label><span>split</span><input id="apiSplit" type="text" value="daily" placeholder="daily / lost" autocomplete="off" spellcheck="false"></label>
              <label><span>model</span><input id="apiModel" type="text" value="aime_expert" placeholder="aime_expert" autocomplete="off" spellcheck="false"></label>
              <label><span>session_id</span><input id="apiSession" type="text" value="thread_example_id" placeholder="thread_..." autocomplete="off" spellcheck="false"></label>
              <label><span>trace_id（可选）</span><input id="apiTrace" type="text" value="" placeholder="定位到具体轮次" autocomplete="off" spellcheck="false"></label>
            </div>
            <div class="dc-codebox">
              <div class="dc-codehead"><span>生成的 5002 直达链接（已自动编码 | 为 %7C）</span>${copyBtnHTML("复制链接", { pre: true })}</div>
              <pre class="code" id="apiPageUrlOut"></pre>
            </div>
          </div>
          <div class="api-vars">
            <div class="api-var">
              <div class="api-var-head"><span>独立聚类矩阵页</span>${copyBtnHTML("复制链接", { fn: "apiMatrixUrl" })}</div>
              <code data-page-suffix="/matrix/?matrix=1">http://10.217.219.2:2476/matrix/?matrix=1</code>
            </div>
            <div class="api-var">
              <div class="api-var-head"><span>独立版本对比页</span>${copyBtnHTML("复制链接", { fn: "apiCompareUrl" })}</div>
              <code data-page-suffix="/compare/">http://10.217.219.2:2476/compare/</code>
            </div>
            <div class="api-var">
              <div class="api-var-head"><span>10 位短 slug 写法</span>${copyBtnHTML("复制模板", { fn: "apiSlugUrl" })}</div>
              <code data-page-slug>http://10.217.219.2:2476/?product=aime&amp;slug=&lt;10位slug&gt;</code>
            </div>
          </div>
        </div>

        <div class="doc-sub">
          <div class="doc-sub-head"><h3>高频问题排查清单</h3></div>
          <div class="cap-table-wrap">
            <table class="cap-table">
              <thead><tr><th style="width:28%">现象 / 疑问</th><th>根因与处理方式</th></tr></thead>
              <tbody>
                <tr><td><b><code>/summary</code> 报错缺少参数</b></td><td><code>/summary</code> 必须传 <code>group_by</code>；只需全局总数时请调 <code>/severity</code> 读取 <code>total</code>。</td></tr>
                <tr><td><b>未聚类问题如何展示</b></td><td><code>code=null</code> 单独展示为“未聚类”，仍计入问题总数和 P0–P4，严禁归入“其他”。</td></tr>
                <tr><td><b>按文件名日期查不到 trace</b></td><td><code>day</code> 为美东时间（<code>America/New_York</code>），单个批次文件可跨多天；按批次查请看 <code>data.file</code>。</td></tr>
                <tr><td><b>最新批次显示未聚类</b></td><td><code>cluster_through</code> 是批次日期而非 <code>day</code>；晚到的 trace 等待下一轮聚类刷新即可。</td></tr>
                <tr><td><b>5002 提示“没有找到这条 trace”</b></td><td>5003 与 5002 快照存在时间差（5003 ≤1h、5002 ≤2min）；先核对 <code>case</code> 拼写或去掉 <code>trace</code> 查看整场会话。</td></tr>
                <tr><td><b>问财如何获取样本链接</b></td><td>问财不提供 5003；从看板「具体数据」地址栏复制链接，将端口替换为 <code>2833</code>。</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  </div>`;
}

export function wireApiDoc(root) {
  const shell = $(".api-shell", root);
  if (!shell) return;

  // 接入环境切换（外网 / 内网 / 本机 / $API），同步重写全部 curl 命令
  const setEnv = (envId) => {
    const env = API_ENVS.find((x) => x.id === envId) || API_ENVS[0];
    $$("[data-api-env]", shell).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.apiEnv === env.id)));
    $$("[data-api-base]", shell).forEach((el) => { el.textContent = env.base; });
    $$("[data-api-tpl]", shell).forEach((pre) => {
      pre.textContent = pre.dataset.apiTpl.replace(/\{\{API\}\}/g, env.base);
    });
  };

  // 5002 链接拼接器
  let pageProd = "aime";
  const splitIn = $("#apiSplit", shell);
  const modelIn = $("#apiModel", shell);
  const sessIn = $("#apiSession", shell);
  const traceIn = $("#apiTrace", shell);
  const urlOut = $("#apiPageUrlOut", shell);

  const syncPageUrl = () => {
    const host = PAGE_HOSTS[pageProd] || PAGE_HOSTS.aime;
    const sp = (splitIn?.value || "daily").trim();
    const md = (modelIn?.value || (pageProd === "aime" ? "aime_expert" : "wencai")).trim();
    const sid = (sessIn?.value || "<session_id>").trim();
    const tr = (traceIn?.value || "").trim();
    const caseVal = `${sp}%7C${md}%7C${encodeURIComponent(sid)}`;
    const url = `${host.base}/?product=${pageProd}&case=${caseVal}${tr ? `&trace=${encodeURIComponent(tr)}` : ""}`;
    if (urlOut) urlOut.textContent = url;
    $$("[data-page-suffix]", shell).forEach((el) => { el.textContent = `${host.base}${el.dataset.pageSuffix}`; });
    const slugEl = $("[data-page-slug]", shell);
    if (slugEl) slugEl.textContent = `${host.base}/?product=${pageProd}&slug=<10位slug>`;
  };

  shell.addEventListener("click", (e) => {
    const envBtn = e.target.closest("[data-api-env]");
    if (envBtn) { setEnv(envBtn.dataset.apiEnv); return; }
    const pb = e.target.closest("[data-page-product]");
    if (pb) {
      pageProd = pb.dataset.pageProduct;
      $$("[data-page-product]", shell).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pageProduct === pageProd)));
      if (modelIn && (modelIn.value === "aime_expert" || modelIn.value === "wencai")) {
        modelIn.value = pageProd === "aime" ? "aime_expert" : "wencai";
      }
      syncPageUrl();
    }
  });
  [splitIn, modelIn, sessIn, traceIn].forEach((el) => el?.addEventListener("input", syncPageUrl));
  syncPageUrl();
}

export function apiCopyResolvers(root) {
  return {
    apiBase: () => $("[data-api-base]", root)?.textContent.trim() || API_ENVS[0].base,
    apiMatrixUrl: () => $("[data-page-suffix='/matrix/?matrix=1']", root)?.textContent.trim() || "",
    apiCompareUrl: () => $("[data-page-suffix='/compare/']", root)?.textContent.trim() || "",
    apiSlugUrl: () => $("[data-page-slug]", root)?.textContent.trim() || "",
  };
}
