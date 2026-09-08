import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { getOrCreateMasterKey, decrypt, isEncrypted } from "@/lib/auth/encrypt";
import { normalizeAiApiMode } from "@/lib/ai/config";
import { buildResponsesRequestBody, extractResponsesText } from "@/lib/ai/responses";

function joinBaseUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) return `${base}${p.slice(3)}`;
  if (base.endsWith("/v1") && p.startsWith("/api/")) return `${base.slice(0, -3)}${p}`;
  return `${base}${p}`;
}

const TESTS: string[] = [];
TESTS.push("把5月份的买入记录的金额都改成2000","金额改成1000","把这个月买入的金额改为500","把买入记录的金额都改成3000","5月买入金额换成800","把2024年的买入资金改为10000","把买入的金额改成500块","这个月买入金额都改成200","买入金额全部改为100块","这个基金5月份买入金额改成500");
TESTS.push("把当前基金所有买入金额改成2000","5月13号买入记录的金额改为5000","2024年5月的买入金额都换成2000","金额调整为1000","金额设置为800");
TESTS.push("资金账户改成招商借记卡","把5月份的买入记录的资金账户换成招商银行储蓄卡","消费账户改成花呗","把上个月的消费记录账户改成花呗","扣款卡改为建设银行","所有买入记录的资金账户改为余额宝","把这个月买入的资金账户换成工行卡","把2024年的支出记录消费账户改为微信","所有赎回记录的资金账户改成银行卡","把扣款卡换成招商的卡");
TESTS.push("所有买入扣款卡改为尾号3924的卡","把5月买入资金账户换成储蓄卡","把2025年买入记录的扣款卡都换成工行卡","现金红利记录的资金账户改成中行卡","所有买入记录的扣款卡改成借记卡3924");
TESTS.push("把2025年9月份买入资金都乘以2","买入金额乘以3","把买入金额翻倍","这个月买入金额加倍","所有买入金额乘以0.5","金额乘2","把这个月的买入金额乘以2.5","买入金额都加倍","买入金额打八折","买入金额减半","上个月买入金额翻倍");
TESTS.push("把3月的买入金额翻三倍","所有资金乘以1.1","买入金额乘以1.2","把买入金额乘以1.5");
TESTS.push("把买入金额加上500","所有买入金额加1000","5月买入每个加500","金额增加200","把这个月的买入金额加上50","买入金额多加100","所有买入资金增加500块","买入加500","这个月买入加1000","所有买入金额加300");
TESTS.push("把5月份的买入记录的备注改成测试","备注改成定投","把买入记录备注改为补录","所有买入备注改成手动记账","把这个月买入的备注都改成AIPanel导入","把上个月买入记录备注改成系统自动","5月买入备注全部清空","备注换成自动记账","把买入的备注改成基金定投","所有买入记录备注改为批量导入");
TESTS.push("把买入记录的日期后延3天","所有买入日期加1天","日期延后7天","买入日期加3天","所有日期+1","把日期改成5月1号","日期设置为今天","把这个月的买入日期推迟2天");
TESTS.push("把5月份的买入记录金额都改成2000","把2024年5月买入记录的金额改成1000","5月份买入金额乘以2","买入记录资金账户都改成借记卡","5月赎回记录金额改成5000","把3到6月的买入金额都改成500","2024年买入记录金额都改成3000","5月买入资金账户全部换成招行卡","买入金额调成2000","买入金额更新为1500");
TESTS.push("买入金额变更成2000","红利再投金额改成1000","把5月份买入记录的金额改成1000","把买入的金额改成2000","今天的买入金额改成300");
TESTS.push("把2024年买入都删了","统计一下5月份买入总金额","查询回收站最近10条","帮我算一下这个月买入花了多少钱","看看5月份有多少笔买入","把这个月的买入记录全部删除","统计上个月买入总金额","查询买入记录","恢复最近10条","把5月份买入记录删掉");

const SYS = `请从用户输入中提取下列信息，以JSON返回：

1. 操作类型（action）：增加、编辑、删除、统计、未知
2. 如果是编辑/删除，提取限制范围：
   - 开始时间（startDate）、结束时间（endDate）
   - 交易类型（transType）：买入、赎回、现金红利、红利再投、支出、收入、转账
   - 账户名称（accountName）
   - 金额条件（amountCond）
3. 如果是编辑，提取：
   - 要修改的项目（editField）：资金账户、基金账户、金额、日期、备注
   - 修改方式（editOp）：替换、乘、加
   - 目标值（editValue）

示例：
"把5月份的买入金额都改成2000"
→ {"action":"编辑","startDate":"2026-05-01","endDate":"2026-05-31","transType":"买入","editField":"金额","editOp":"替换","editValue":"2000"}

"资金账户改成招商银行借记卡"
→ {"action":"编辑","editField":"资金账户","editOp":"替换","editValue":"招商银行借记卡"}

"统计上个月买入总金额"
→ {"action":"统计","startDate":"2026-05-01","endDate":"2026-05-31","transType":"买入"}

"把2024年买入都删了"
→ {"action":"删除","startDate":"2024-01-01","endDate":"2024-12-31"}`;

const FIELD_MAP_CN: Record<string, string> = {
  "金额": "amount", "资金": "amount",
  "资金账户": "cashAccount", "扣款卡": "cashAccount",
  "基金账户": "toAccount",
  "消费账户": "account", "主账户": "account",
  "日期": "date", "时间": "date",
  "备注": "note", "说明": "note",
};
const OP_MAP_CN: Record<string, string> = {
  "替换": "replace", "改为": "replace", "改成": "replace", "换成": "replace",
  "乘": "multiply", "翻倍": "multiply", "加倍": "multiply",
  "加": "add", "增加": "add",
};

async function getActiveModel() {
  const model = await prisma.aiModel.findFirst({ where: { active: true }, include: { AiChannel: true } });
  if (!model) return null;
  const masterKey = await getOrCreateMasterKey();
  const rawKey = model.AiChannel.apiKey ?? "";
  const apiKey = rawKey && isEncrypted(rawKey) ? decrypt(rawKey, masterKey) : rawKey;
  return {
    modelName: model.model,
    baseUrl: model.AiChannel.baseUrl,
    apiKey,
    isOllama: model.AiChannel.channelType === "ollama",
    apiMode: model.AiChannel.channelType === "ollama"
      ? "chat"
      : normalizeAiApiMode(model.apiMode),
  };
}

export async function POST() {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "Administrator access required." }, { status: 403 });
  }

  try {
    const config = await getActiveModel();
    if (!config) return NextResponse.json({ ok: false, error: "没有活跃的 AI 模型" }, { status: 400 });

    const { baseUrl, apiKey, modelName, isOllama, apiMode } = config;
    const cleanUrl = baseUrl.replace(/\/$/, "");
    const today = new Date().toISOString().slice(0, 10);

    await prisma.commandTestResult.deleteMany({});

    let okCount = 0, failCount = 0;

    for (let i = 0; i < Math.min(TESTS.length, 20); i++) {
      const input = TESTS[i];
      const userMessage = `当前日期：${today}\n\n用户输入：${input}`;

      let rawResponse = "";
      let parsed: any = null;
      let error: string | null = null;
      const startMs = Date.now();

      try {
        const body = isOllama
          ? {
              model: modelName,
              stream: false,
              messages: [
                { role: "system", content: SYS },
                { role: "user", content: userMessage },
              ],
            }
          : apiMode === "responses"
            ? buildResponsesRequestBody({
                modelName,
                instructions: SYS,
                userMessage,
                temperature: 0,
                maxOutputTokens: 200,
              })
            : {
                model: modelName,
                messages: [
                  { role: "system", content: SYS },
                  { role: "user", content: userMessage },
                ],
                max_tokens: 200,
                temperature: 0,
              };
        const url = isOllama
          ? joinBaseUrl(cleanUrl, "/api/chat")
          : joinBaseUrl(cleanUrl, apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions");
        const h: Record<string, string> = { "Content-Type": "application/json" };
        if (!isOllama && apiKey) h.Authorization = `Bearer ${apiKey}`;

        const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
        if (!res.ok) { error = `HTTP ${res.status}`; failCount++; }
        else {
          const data = await res.json().catch(() => null) as any;
          rawResponse = (
            isOllama
              ? data?.message?.content ?? data?.response ?? ""
              : apiMode === "responses"
                ? extractResponsesText(data)
                : data?.choices?.[0]?.message?.content ?? ""
          ).trim();
          const m = rawResponse.match(/\{[\s\S]*\}/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch { /* bad json */ } }
          if (parsed?.action === "编辑" && parsed.editField) {
            parsed.field = FIELD_MAP_CN[parsed.editField] || parsed.editField;
            parsed.operation = OP_MAP_CN[parsed.editOp] || parsed.editOp || "replace";
            parsed.value = parsed.editValue;
            okCount++;
          } else if (parsed?.action === "统计" || parsed?.action === "删除") {
            okCount++;
          } else {
            failCount++;
          }
        }
      } catch (e: any) { error = e.message; failCount++; }

      await prisma.commandTestResult.create({
        data: {
          index: i + 1, input,
          rawResponse: rawResponse.slice(0, 5000),
          field: parsed?.field ?? null,
          operation: parsed?.operation ?? null,
          value: parsed?.value ?? null,
          isSuccess: !!parsed?.field,
          error, latencyMs: Date.now() - startMs, modelName,
        },
      });
    }

    return NextResponse.json({ ok: true, total: TESTS.length, okCount, failCount });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "测试失败" }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "Administrator access required." }, { status: 403 });
  }

  const results = await prisma.commandTestResult.findMany({
    orderBy: { index: "asc" },
  });
  return NextResponse.json({ ok: true, results, total: results.length });
}
