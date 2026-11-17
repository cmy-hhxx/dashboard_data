/* 评测接口使用指南 (doc=api): 5003 供数接口 + 5002 页面接口 + 口径与增量同步规范. */
import { $, $$ } from "./core.js";

export function apiDocHTML() {
  return `<div class="cap-shell api-shell">
    <aside class="cap-side">
      <div class="cap-side-title">评测接口指南</div>
      <nav class="cap-toc" id="apiToc" aria-label="接口章节">
        <button type="button" data-api-view="deploy" aria-pressed="true"><span class="num">01</span>部署与概念</button>
        <button type="button" data-api-view="data" aria-pressed="false"><span class="num">02</span>5003 供数接口</button>
        <button type="button" data-api-view="sync" aria-pressed="false"><span class="num">03</span>增量同步与升版</button>
        <button type="button" data-api-view="page" aria-pressed="false"><span class="num">04</span>5002 页面与排查</button>
      </nav>
    </aside>

    <div class="cap-main">
      <!-- 01 部署与概念 -->
      <section class="cap-view is-active" data-api-panel="deploy" aria-label="部署与概念">
        <div class="bento">
          <article class="card cap-hero" style="--span:12">
            <div class="cap-hero-grid">
              <div class="cap-hero-copy">
                <div class="cap-badges">
                  <span class="cap-prov" data-kind="measured">5003 供数 API</span>
                  <span class="cap-prov" data-kind="derived">5002 页面深链</span>
                  <span class="cap-prov">Schema v2.0</span>
                </div>
                <h2>5003 条件查询与聚合 · 5002 对话详情定位</h2>
                <p>先通过 <code>5003 /api/v1/analysis/traces</code> 检索 <code>trace_id / session_id</code>，再拼接 <code>case = split|model|session_id</code> 打开 <code>5002</code> 定位到会话中的具体轮次。</p>
              </div>
              <div class="api-flow-box">
                <div><span class="cap-prov" data-kind="measured">5003</span><code>$API/traces → trace_id / session_id</code></div>
                <div class="api-flow-arrow">↓ <code>case = split|model|session_id</code></div>
                <div><span class="cap-prov" data-kind="derived">5002</span><code>$PAGE/?product=aime&amp;case=…&amp;trace=&lt;trace_id&gt;</code></div>
              </div>
            </div>
          </article>

          <article class="card" style="--span:12">
            <header class="card-head"><h2>两套部署与端口映射</h2><span class="meta">容器内固定：5001 看板 · 5002 页面 · 5003 供数</span></header>
            <div class="cap-table-wrap">
              <table class="cap-table">
                <thead><tr><th>部署环境</th><th>宿主机 IP</th><th>容器名称</th><th>数据目录</th><th class="num">5003 供数</th><th class="num">5002 页面</th><th class="num">5001 看板</th><th class="num">SSH</th></tr></thead>
                <tbody>
                  <tr><td><b>弗吉尼亚（AIME）</b></td><td><code>10.217.219.2</code></td><td><code>interactive-s3ynzadcvm9c</code></td><td><code>/mnt/aime_eval_ssd</code></td><td class="num">2477</td><td class="num">2476</td><td class="num">2475</td><td class="num">2473</td></tr>
                  <tr><td><b>乌兰察布（问财）</b></td><td><code>117.50.195.94</code></td><td><code>interactive-i6piqwvlnsr5</code></td><td><code>/mnt/fin_bench/...</code></td><td class="num faint">停用</td><td class="num">2833</td><td class="num">2768</td><td class="num">2834</td></tr>
                </tbody>
              </table>
            </div>
            <div class="api-vars">
              <div><span>供数基址</span><code>$API = http://10.217.219.2:2477/api/v1/analysis</code></div>
              <div><span>页面基址</span><code>$PAGE = http://10.217.219.2:2476</code></div>
              <div><span>集群内直连</span><code>http://interactive-s3ynzadcvm9c:5003</code></div>
            </div>
          </article>

          <article class="card" style="--span:12">
            <header class="card-head"><h2>核心概念与统一统计口径</h2></header>
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
          </article>
        </div>
      </section>

      <!-- 02 5003 供数接口 -->
      <section class="cap-view" data-api-panel="data" aria-label="5003 供数接口">
        <div class="bento">
          <article class="card" style="--span:12">
            <header class="card-head"><h2>通用协议约定</h2><span class="meta">GET / POST 同语义 · dataset=aime_eval 必填</span></header>
            <div class="cap-figs" style="--cols:4">
              <div class="cap-fig"><span class="cap-k">响应外包</span><b class="num">Schema 2.0</b><small><code>{request_id, schema_version:"2.0", data, meta}</code>，<code>meta.filters</code> 回显生效条件。</small></div>
              <div class="cap-fig"><span class="cap-k">游标分页</span><b class="num">30 min 有效</b><small><code>cursor</code> 过期返回 <code>410</code>；<code>/traces</code> 单页 ≤100（<code>ids_only=true</code> 时 ≤5000）。</small></div>
              <div class="cap-fig"><span class="cap-k">聚合与变更上限</span><b class="num">1,000 条</b><small><code>/summary</code>、<code>/severity</code> 的 <code>limit</code> ≤1000；<code>/changes</code> 的 <code>page_size</code> ≤1000。</small></div>
              <div class="cap-fig"><span class="cap-k">校验与限流</span><b class="num">422 / 413</b><small>未知编码或严重度返回 <code>422</code>；<code>user_ids</code> &gt;5000 或 <code>trace_ids</code> &gt;1000 返回 <code>413</code>。</small></div>
            </div>
          </article>

          <article class="card" style="--span:6">
            <header class="card-head"><h2>1) P0–P4 分布：<code>/severity</code></h2></header>
            <pre class="code">curl -s "$API/severity?dataset=aime_eval"
curl -s "$API/severity?dataset=aime_eval&amp;group_by=app_version"</pre>
            <div class="cap-table-wrap" style="margin-top:var(--sp-3)">
              <table class="cap-table">
                <tbody>
                  <tr><td><code>severity.Pn.problems</code></td><td>该等级问题条目数；总 <code>problems</code> = 各等级之和 + <code>unlabeled</code>。</td></tr>
                  <tr><td><code>severity.Pn.traces</code></td><td>至少含一条该等级问题的 trace 数；分母为 <code>total.analyzed</code>。</td></tr>
                  <tr><td><code>group_by</code></td><td>支持 0–2 个维度：<code>intent / problem / day / user / app_version / source</code>。</td></tr>
                </tbody>
              </table>
            </div>
          </article>

          <article class="card" style="--span:6">
            <header class="card-head"><h2>2) 维度聚合：<code>/summary</code></h2></header>
            <pre class="code">curl -s "$API/summary?dataset=aime_eval&amp;group_by=problem&amp;level=top"
curl -s "$API/summary?dataset=aime_eval&amp;group_by=day"</pre>
            <div class="cap-table-wrap" style="margin-top:var(--sp-3)">
              <table class="cap-table">
                <tbody>
                  <tr><td><code>level</code></td><td><code>top</code>（环节）/ <code>leaf</code>（最细编码）/ <code>children</code>（下一层），仅作用于 <code>intent</code>、<code>problem</code>。</td></tr>
                  <tr><td><code>problems / traces</code></td><td>按 <code>problem</code> 分组时各组 <code>problems</code> 之和 = <code>total.problems</code>；<code>traces</code> 会跨组重复。</td></tr>
                  <tr><td><code>analyzed</code></td><td>去掉 <code>problem / severity</code> 筛选、忽略 <code>problem</code> 分组维度后的总 trace 分母。</td></tr>
                </tbody>
              </table>
            </div>
          </article>

          <article class="card" style="--span:6">
            <header class="card-head"><h2>3) 检索列表：<code>/traces</code></h2></header>
            <pre class="code">curl -s "$API/traces?dataset=aime_eval&amp;severity=P0&amp;page_size=2"</pre>
            <div class="cap-table-wrap" style="margin-top:var(--sp-3)">
              <table class="cap-table">
                <tbody>
                  <tr><td>常用筛选</td><td><code>source</code>、<code>start_day / end_day</code>、<code>intent</code>、<code>problem</code>、<code>severity</code>、<code>app_version</code>、<code>user_ids</code>、<code>q</code>。</td></tr>
                  <tr><td><code>problems[]</code></td><td>列表精简为 <code>{code, current_code, label, severity, component, session_level}</code>。</td></tr>
                  <tr><td><code>ids_only=true</code></td><td>只返回 <code>trace_id</code> 便于导出；<code>trace_id</code> 跨模型/重跑不唯一，导出需去重。</td></tr>
                </tbody>
              </table>
            </div>
          </article>

          <article class="card" style="--span:6">
            <header class="card-head"><h2>4) 批量、单条详情、分类树</h2></header>
            <pre class="code"># 批量查询（≤1000，仅 POST，保序返回）
curl -s -X POST "$API/traces/batch" -H 'Content-Type: application/json' \\
  -d '{"dataset":"aime_eval","trace_ids":["…","…"]}'

# 单条详情（day 必填）与分类树
curl -s "$API/traces/&lt;trace_id&gt;?dataset=aime_eval&amp;day=2026-11-11"
curl -s "$API/taxonomy?kind=problem&amp;app_version=AIME-Atlas_expert"</pre>
            <div class="cap-table-wrap" style="margin-top:var(--sp-3)">
              <table class="cap-table">
                <tbody>
                  <tr><td><code>/traces/batch</code></td><td>未知或未分析 id 返回 <code>status:"not_analyzed"</code>；同 id 多版本自动合并。</td></tr>
                  <tr><td><code>/traces/{id}</code></td><td>返回 <code>data.file</code>（来源归因文件）、完整 <code>analysis.problems[]</code> 与 <code>analysis.history[]</code>。</td></tr>
                  <tr><td><code>session_level</code></td><td>跨轮问题只挂会话最后一轮（<code>session_level: true</code>），只计一次。</td></tr>
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>

      <!-- 03 增量同步与升版 -->
      <section class="cap-view" data-api-panel="sync" aria-label="增量同步与升版">
        <div class="bento">
          <article class="card" style="--span:12">
            <header class="card-head"><h2>分类树升版兼容字段</h2><span class="meta">展示名称优先用 problem_label / current_code，版本看 meta.taxonomy_version</span></header>
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
          </article>

          <article class="card" style="--span:12">
            <header class="card-head"><h2>位点增量同步：<code>/changes</code></h2><span class="meta">禁止按时间窗口重拉（归因文件会补数或整份重写）</span></header>
            <div class="cap-split">
              <div>
                <pre class="code"># 1. 首次全量：不传 since，按 next_cursor 翻页到底
curl -s "$API/changes?dataset=aime_eval&amp;page_size=500"

# 2. 增量拉取：保存上一轮末尾的 next_since，只拉变更
curl -s "$API/changes?dataset=aime_eval&amp;since=&lt;next_since&gt;"

# 3. 在线获取同步文档与客户端伪代码
curl -s "$API/docs/incremental"</pre>
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
          </article>
        </div>
      </section>

      <!-- 04 5002 页面与排查 -->
      <section class="cap-view" data-api-panel="page" aria-label="5002 页面与排查">
        <div class="bento">
          <article class="card" style="--span:12">
            <header class="card-head"><h2>5002 页面深链格式</h2><span class="meta">索引缓存 120 秒 · 跨产品访问返回 404</span></header>
            <pre class="code">/?product=aime&amp;case=&lt;split&gt;|&lt;model&gt;|&lt;session_id&gt;&amp;trace=&lt;trace_id&gt;</pre>
            <div class="cap-table-wrap" style="margin-top:var(--sp-3)">
              <table class="cap-table">
                <thead><tr><th style="width:24%">参数 / 路径</th><th>说明</th></tr></thead>
                <tbody>
                  <tr><td><code>product</code></td><td><code>aime</code>（弗吉尼亚 <code>:2476</code>）或 <code>wencai</code>（乌兰察布 <code>:2833</code>）。</td></tr>
                  <tr><td><code>case</code> / <code>slug</code></td><td><code>&lt;split&gt;|&lt;model&gt;|&lt;session_id&gt;</code>（URL 中 <code>|</code> 编码为 <code>%7C</code>），也可直接传 10 位 <code>slug</code>。</td></tr>
                  <tr><td><code>trace</code></td><td>可选；传入后直接展开并滚动定位到该轮对话。</td></tr>
                  <tr><td>独立展示页</td><td><code>/matrix/?matrix=1</code>（独立聚类矩阵页）、<code>/compare/</code>（独立 A/B 版本对比页）。</td></tr>
                </tbody>
              </table>
            </div>
          </article>

          <article class="card" style="--span:12">
            <header class="card-head"><h2>高频问题排查清单</h2></header>
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
          </article>
        </div>
      </section>
    </div>
  </div>`;
}

export function wireApiDoc(root) {
  $("#apiToc", root)?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-api-view]");
    if (!btn) return;
    const name = btn.dataset.apiView;
    $$("[data-api-panel]", root).forEach((p) => p.classList.toggle("is-active", p.dataset.apiPanel === name));
    $$("#apiToc [data-api-view]", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.apiView === name)));
  });
}
