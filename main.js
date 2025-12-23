// main.js (建议整体替换你现有版本中对应部分)

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const host = process.env.HOST || "ikuuu.de";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

const LOG_DIR = "logs";
mkdirSync(LOG_DIR, { recursive: true });

function mask(str, keep = 3) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= keep * 2) return "***";
  return s.slice(0, keep) + "***" + s.slice(-keep);
}

function safeFilename(s) {
  return String(s).replace(/[^\w.-]+/g, "_");
}

async function dumpResponse(tag, accountName, response) {
  const ct = response.headers.get("content-type") || "";
  const statusLine = `${response.status} ${response.statusText || ""}`.trim();
  const url = response.url || "";
  const headersObj = {};
  // 仅挑常见关键头输出，避免太乱
  for (const k of ["content-type", "location", "server", "set-cookie"]) {
    const v = response.headers.get(k);
    if (v) headersObj[k] = v;
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (e) {
    bodyText = `[读取 response.text() 失败] ${e?.message || e}`;
  }

  const head = bodyText.slice(0, 800);

  console.log(`\n[${tag}] ${accountName}`);
  console.log(`status: ${statusLine}`);
  console.log(`url: ${url}`);
  console.log(`content-type: ${ct}`);
  console.log(`headers: ${JSON.stringify(headersObj)}`);
  console.log(`body(head 800):\n${head}\n`);

  const file = join(
    LOG_DIR,
    `${safeFilename(accountName)}__${safeFilename(tag)}__${Date.now()}.txt`
  );
  writeFileSync(
    file,
    [
      `tag: ${tag}`,
      `account: ${accountName}`,
      `status: ${statusLine}`,
      `url: ${url}`,
      `content-type: ${ct}`,
      `headers: ${JSON.stringify(headersObj, null, 2)}`,
      "",
      bodyText,
    ].join("\n"),
    "utf-8"
  );

  return { ct, bodyText };
}

async function safeJson(tag, accountName, response) {
  const ct = response.headers.get("content-type") || "";
  // 先把响应转储出来（不管成功失败都落盘）
  const { bodyText } = await dumpResponse(tag, accountName, response);

  // 如果不是 JSON，直接报错：告诉你是 HTML/重定向/风控页
  if (!ct.includes("application/json")) {
    throw new Error(
      `服务端返回非 JSON（content-type=${ct || "unknown"}），很可能是登录页/风控页/重定向页。已保存 logs 响应文件。`
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(
      `JSON 解析失败：${e?.message || e}。已保存 logs 响应文件。`
    );
  }
}

// 格式化 Cookie（保留你原逻辑）
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中... (email=${mask(account.email)})`);

  // 你原来用 FormData；这里先不强改逻辑，保留原方式
  const formData = new FormData();
  formData.append("host", host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetch(logInUrl, {
    method: "POST",
    body: formData,
    redirect: "follow",
    headers: {
      // 更像浏览器一点，减少被风控/重定向到 HTML 的概率
      "accept": "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      "x-requested-with": "XMLHttpRequest",
      "referer": `https://${host}/auth/login`,
    },
  });

  if (!response.ok) {
    // 这里也会把 HTML 写入 logs
    await dumpResponse("login_non_200", account.name, response);
    throw new Error(`登录请求失败 - HTTP ${response.status}`);
  }

  const responseJson = await safeJson("login", account.name, response);

  // 取 cookie（Node fetch 对 set-cookie 支持因版本不同；保留你原来的思路）
  // 如果你原来用的是 response.headers.getSetCookie()，也可以继续用
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    // 仍然不算致命，但提示你看看 logs
    console.log(`${account.name}: 未拿到 set-cookie（可能是风控/重定向）。请查看 logs 文件。`);
  } else {
    account.cookie = formatCookie([setCookie]);
  }

  return responseJson;
}

// 签到
async function checkIn(account) {
  const response = await fetch(checkInUrl, {
    method: "POST",
    redirect: "follow",
    headers: {
      Cookie: account.cookie || "",
      "accept": "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      "x-requested-with": "XMLHttpRequest",
      "referer": `https://${host}/user`,
    },
  });

  if (!response.ok) {
    await dumpResponse("checkin_non_200", account.name, response);
    throw new Error(`签到请求失败 - HTTP ${response.status}`);
  }

  const data = await safeJson("checkin", account.name, response);
  return data;
}

// GitHub output（保留你原逻辑）
function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 入口（你原 main() 逻辑保持即可；这里只强调：catch 时也要继续输出）
async function main() {
  let accounts;
  try {
    if (!process.env.ACCOUNTS) throw new Error("❌ 未配置账户信息。");
    accounts = JSON.parse(process.env.ACCOUNTS);

    const resultLines = [];
    let hasError = false;

    for (const account of accounts) {
      try {
        await logIn(account);
        const checkInData = await checkIn(account);
        resultLines.push(`${account.name}: ✅ ${checkInData?.msg || "success"}`);
      } catch (e) {
        hasError = true;
        resultLines.push(`${account.name}: ❌ ${e?.message || e}`);
      }
    }

    const resultMsg = resultLines.join("\n");
    setGitHubOutput("result", resultMsg);

    if (hasError) process.exit(1);
  } catch (e) {
    setGitHubOutput("result", `❌ 脚本异常：${e?.message || e}`);
    process.exit(1);
  }
}

main();
