// ===== 설정 상수 =====
const MODEL = "claude-opus-5";
const ALLOWED_ORIGIN = "https://ititrich.github.io";
const MAX_BODY_CHARS = 8000;
const RATE_LIMIT = 5; // 같은 IP 1분당 최대 호출 수
const RATE_WINDOW_MS = 60 * 1000;
const CLAUDE_TIMEOUT_MS = 25000; // 무료: 페이지 쪽 TIMEOUT_MS(30초)보다 짧게
const PAID_TIMEOUT_MS = 170000; // 유료: 분량이 많아 더 오래 걸립니다 (페이지는 180초)
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `당신은 IT 기업 채용 담당자 출신 자소서 첨삭 전문가입니다. 서류 3만 건을 검토한 경험으로 평가합니다.

[평가 기준] 각 100점
1 구체성 - 숫자·기간·역할이 드러나는가
2 직무적합 - 지원 직무 키워드와 맞는가
3 논리 - 질문에 실제로 답하고 있는가
4 가독성 - 첫 두 문장에서 읽히는가

[반드시 할 것]
· 점수마다 근거 한 줄을 붙일 것
· 문장 단위로 "원문 → 수정안 → 이유"
· 수정안은 지원자가 쓴 사실만 재배열

[절대 금지]
· 없는 경험·수치를 지어내지 말 것
· "좋습니다" 같은 뭉뚱그린 칭찬 금지
· 합격을 보장하는 표현 금지

[무료 모드일 때 (mode: "free")]
· 점수 3개 + 가장 치명적인 문제 1개만
· 수정안은 1개만, 나머지 항목은 빈 배열
· 마지막에 "나머지 문항 첨삭과 면접질문은 상세 리포트에서 드립니다" 한 줄

[유료 모드일 때 (mode: "paid")]
· 분량을 억지로 늘리지 말 것. 대신 항목 수를 반드시 채울 것
  - 고칠 문장: 최소 10개
  - 키워드: 있음/없음 각각 최소 5개
  - 예상 면접질문: 정확히 10개

[출력]
JSON만. 앞뒤 설명 문장 금지.
{"scores":{...}, "summary":"",
 "fixes":[{"before":"","after":"","why":""}],
 "keywords":{"있음":[],"없음":[]},
 "questions":[], "next":""}`;

const SCORE_ITEM = {
  type: "object",
  properties: {
    점수: { type: "integer", description: "0~100 사이 정수" },
    근거: { type: "string" },
  },
  required: ["점수", "근거"],
  additionalProperties: false,
};

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        구체성: SCORE_ITEM,
        직무적합: SCORE_ITEM,
        논리: SCORE_ITEM,
        가독성: SCORE_ITEM,
      },
      required: ["구체성", "직무적합", "논리", "가독성"],
      additionalProperties: false,
    },
    summary: { type: "string" },
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          before: { type: "string" },
          after: { type: "string" },
          why: { type: "string" },
        },
        required: ["before", "after", "why"],
        additionalProperties: false,
      },
    },
    keywords: {
      type: "object",
      properties: {
        있음: { type: "array", items: { type: "string" } },
        없음: { type: "array", items: { type: "string" } },
      },
      required: ["있음", "없음"],
      additionalProperties: false,
    },
    questions: { type: "array", items: { type: "string" } },
    next: { type: "string" },
  },
  required: ["scores", "summary", "fixes", "keywords", "questions", "next"],
  additionalProperties: false,
};

// ===== IP별 호출 횟수 (Rate Limiting 바인딩이 없을 때 쓰는 보조 장치) =====
const hits = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // 허용되지 않은 사이트에서 온 요청은 거절
    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "허용되지 않은 요청입니다." }, 403, cors);
    }

    // 프리플라이트
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const mode = url.pathname === "/paid" ? "paid" : url.pathname === "/free" ? "free" : null;
    if (!mode) {
      return json({ error: "잘못된 주소입니다." }, 404, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "POST 요청만 가능합니다." }, 405, cors);
    }

    try {
      // 1분에 5번 제한
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await allowRequest(env, ip))) {
        return json({ error: "요청이 너무 많습니다. 1분 뒤에 다시 시도해 주세요." }, 429, cors);
      }

      // 본문 길이 확인 (8000자 초과 시 거절)
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) {
        return json({ error: `입력은 ${MAX_BODY_CHARS.toLocaleString()}자 이내로 보내 주세요.` }, 400, cors);
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "요청 형식이 올바르지 않습니다." }, 400, cors);
      }
      // 페이지는 input, 그 외 호출은 text 로 보냅니다. 둘 다 받습니다.
      const sent = typeof body?.input === "string" ? body.input : body?.text;
      const text = typeof sent === "string" ? sent.trim() : "";
      if (!text) {
        return json({ error: "자소서 내용을 입력해 주세요." }, 400, cors);
      }

      if (!env.ANTHROPIC_API_KEY) {
        console.error("ANTHROPIC_API_KEY is not set");
        return json({ error: "서비스 준비 중입니다. 잠시 후 다시 시도해 주세요." }, 503, cors);
      }

      const job = typeof body?.job === "string" ? body.job.trim().slice(0, 100) : "";
      const answer = await callClaude(env.ANTHROPIC_API_KEY, text, job, mode);
      return json({ ok: true, mode, result: mode === "free" ? trimToFree(answer) : answer }, 200, cors);
    } catch (err) {
      // 내부 에러 내용은 로그로만 남기고, 사용자에게는 짧은 안내만
      console.error("free diagnosis failed:", err);
      const status = err?.status || 500;
      const message =
        status === 504 ? "진단이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요."
        : status === 422 ? "이 내용은 진단할 수 없습니다. 자소서 문항을 다시 확인해 주세요."
        : "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
      return json({ error: message }, status === 504 || status === 422 ? status : 500, cors);
    }
  },
};

// 무료 모드 규칙 적용: 점수 3개 + 수정안 1개 + 나머지 항목은 빈 배열
function trimToFree(result) {
  const entries = Object.entries(result.scores || {})
    .sort((a, b) => (a[1]?.점수 ?? 0) - (b[1]?.점수 ?? 0)) // 점수가 낮은(= 아쉬운) 항목 우선
    .slice(0, 3);
  return {
    ...result,
    scores: Object.fromEntries(entries),
    fixes: (result.fixes || []).slice(0, 1),
    keywords: { 있음: [], 없음: [] },
    questions: [],
    next: result.next || "나머지 문항 첨삭과 면접질문은 상세 리포트에서 드립니다",
  };
}

async function callClaude(apiKey, text, job, mode) {
  const paid = mode === "paid";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), paid ? PAID_TIMEOUT_MS : CLAUDE_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        // 안전 필터가 요청을 거절하면 다른 모델로 자동 재시도
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: paid ? 16000 : 4000,
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        output_config: {
          // 무료는 빠르고 저렴하게, 유료는 항목을 모두 채워야 하므로 더 깊게
          effort: paid ? "high" : "low",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: `mode: "${paid ? "paid" : "free"}"\n지원 직무: ${job || "미입력(IT 직군 일반 기준으로 평가)"}\n\n[자소서]\n${text}`,
          },
        ],
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw httpError(504, "Claude API timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw httpError(502, `Claude API ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw httpError(422, "Claude refused the request");
  }
  if (data.stop_reason === "max_tokens") {
    throw httpError(502, "Claude response was cut off (max_tokens)");
  }

  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw httpError(502, "No text block in Claude response");
  return JSON.parse(textBlock.text);
}

async function allowRequest(env, ip) {
  // wrangler.toml의 Rate Limiting 바인딩이 있으면 그것을 사용 (여러 서버에 걸쳐 적용)
  if (env.FREE_LIMITER) {
    const { success } = await env.FREE_LIMITER.limit({ key: ip });
    return success;
  }
  // 없으면 메모리 기반으로 대신 제한
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return headers;
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
