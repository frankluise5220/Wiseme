export {};

// Fetch results from the app's test API, send to AI for self-improvement
async function main() {
  // Get failed cases
  const res1 = await fetch("http://127.0.0.1:7777/api/v1/test-prompt");
  const data1 = await res1.json() as any;
  const fails = data1.results.filter((r: any) => !r.isSuccess).map((r: any) => r.input).join("\n");

  const CURRENT_PROMPT = `用户想修改记账数据。只提取3个信息，输出JSON：
{"field":"金额|资金账户|消费账户|日期|备注","action":"替换|乘|加","value":"目标值"}

field规则：有"金额"→金额，有"资金账户""扣款卡"→资金账户，有"备注"→备注，有"日期"→日期
action规则："改成""改为"→替换，"乘以""翻倍"→乘，"加上"→加
删除/统计/查询等非修改操作 → {"field":"none"}
示例：
"把5月份买入金额改成2000" → {"field":"金额","action":"替换","value":"2000"}
"资金账户改成招商卡" → {"field":"资金账户","action":"替换","value":"招商卡"}
"买入金额翻倍" → {"field":"金额","action":"乘","value":"2"}
只输出JSON。`;

  const prompt = `你是一个 prompt 工程师。下面是一个系统 prompt，用它去解析用户指令时有几个失败了。

## 当前 prompt
${CURRENT_PROMPT}

## 失败的指令
${fails}

## 任务
分析失败原因，写一个改进版的 prompt。要求更简洁、覆盖这些失败案例、输出格式不变。
只输出改进后的 prompt 文本。`;

  // Send through the app's own AI channel
  const res2 = await fetch("http://127.0.0.1:7777/api/v1/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: prompt,
      // No fund context - this is a prompt engineering task
    }),
  });
  const data2 = await res2.json() as any;
  console.log("=== AI IMPROVED PROMPT ===");
  console.log(data2);
}
main().catch(console.error);
