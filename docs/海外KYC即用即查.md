# 海外 KYC 即用即查（给 judge 服务）

> 在**海外远端**用 user_id 直接查 KYC 画像，输出 JSON 到 stdout。
> 不落盘、不记台账，纯即查。
>
> **本服务用独立冻结版，不受抓取链路改动影响。**

---

## 一、调用方式

```bash
cd /mnt/aime_eval_ssd/0_litefusion_data/kyc_query
python3 kyc_query.py <user_id>
```

**不需要设 PYTHONPATH**，不依赖任何第三方包。

---

## 二、三种用法

### 单个

```bash
python3 kyc_query.py 1808221539
```

```json
{
  "user_id": "1808221539",
  "ok": true,
  "user_id_fp": "41cd5740e3e915cf",
  "fetched_at": "2026-11-23 03:19:13",
  "profile": {
    "goals": {...},
    "background": {...},
    "constraints": {...},
    "investment_status": {...},
    "risk_preference": {...}
  }
}
```

### 多个

```bash
python3 kyc_query.py 1808221539 1888919995 1888713191
```

输出 JSON **数组**。

### 从 stdin 批量

```bash
cat ids.txt | python3 kyc_query.py -
```

`ids.txt` 每行一个 user_id。

### 缩进输出

```bash
python3 kyc_query.py --pretty 1808221539
```

---

## 三、返回字段

| 字段 | 说明 |
|---|---|
| `user_id` | 查询的 user_id |
| `ok` | `true` 成功 / `false` 失败 |
| `user_id_fp` | 用户指纹（16 位 hex，可跨表关联，不暴露原 id）|
| `fetched_at` | 查询时刻 |
| `profile` | **画像内容**（已脱敏）|

### profile 里可能的树

每个用户返回的树**不同**，没有就是该用户没这部分数据，**不是错误**：

```
goals  background  constraints  investment_status  investment_logic
risk_preference  investor_assessment  emotion_and_psychology
personalization_and_rules  app_behavior_analysis  ideas_and_notes
life_needs  executable  behaviour_anlaysis  profile_status_info
```

---

## 四、失败情况

```json
{"user_id": "1854292531", "ok": false, "error": "leak:['state=New York']"}
```

| error | 含义 | 处理 |
|---|---|---|
| `leak:['xxx']` | **脱敏检测拦下**（发现真实姓名/地区/券商等）| 正常，跳过 |
| `not_found` | 该 user_id 无画像 | 正常，跳过 |
| `timeout` / `net_xxx` | 网络问题 | 可重试 |

**退出码**：全部成功 `0`，有失败 `1`。

---

## 五、注意事项

| 项 | 说明 |
|---|---|
| **QPS** | 服务方建议 **≤ 5**；批量请自行限速 |
| **不落盘** | 每次实时查，无缓存 |
| **自动脱敏** | 金额/数量/百分比 → 星号；身份/凭证 → 丢弃 |
| **明文不返回** | 用户指纹代替原始 user_id |

### 批量限速示例

```bash
while read uid; do
  python3 kyc_query.py "$uid"
  sleep 0.2      # 200ms ≈ QPS 5
done < ids.txt
```

---

## 六、稳定性保证

### 文件位置（独立目录，不受抓取链路影响）

```
/mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py
```

| 特性 | 说明 |
|---|---|
| **自包含单文件** | 33 KB，只依赖 Python 标准库 |
| **零外部依赖** | 不 import `lf_plugin` 或任何项目模块 |
| **冻结快照** | 与抓取链路代码完全隔离，我们改抓取不影响你 |
| **无状态** | 不读不写任何本地文件 |

### 已验证

```bash
# 纯净环境（无 PYTHONPATH）运行
cd /mnt/aime_eval_ssd/0_litefusion_data/kyc_query
env -u PYTHONPATH python3 kyc_query.py 1808221539
# → {"user_id": "1808221539", "ok": true, ...}
```

---

## 七、接口信息

| 项 | 值 |
|---|---|
| 接口 | `http://internal-idc-pri.ainvest.com/cbas-kyc-business-beimeipri/user_dynamic_label/label_data/get_label_data` |
| caller | `yangyubang@myhexin.com` |
| 超时 | 60s |
| 重试 | 3 次 |

**只能海外远端访问**。

---

## 八、如需更新冻结版

我们侧改动 KYC 逻辑后，会重新生成并同步：

```bash
# 我们侧（本机）
python tmp/_make_kyc_frozen.py
# 然后推到 /mnt/aime_eval_ssd/0_litefusion_data/kyc_query/kyc_query.py
```

**你侧无需任何操作**，除非我们通知有更新。
