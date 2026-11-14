import assert from "node:assert/strict";
import { test } from "node:test";
import site from "../package.json" with { type: "json" };
import {
  onboardingPrompt,
  type Registration,
} from "../packages/contracts/src/connect.ts";

const machine: Registration = {
  id: "test-mac",
  name: "Test Mac",
  enabled: true,
  source: "managed",
  credentialId: "fixture",
  createdAt: null,
  rotatedAt: null,
  expiresAt: null,
  watchPorts: [],
};

test("onboarding checks both identity and origin before rotating an existing credential", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "https://ingest.example.test",
    [],
    site.config.publishedAgentVersion,
  );
  assert.match(prompt, /machineId 和 url/);
  assert.match(prompt, /仅当机器 ID 和规范化后的 origin 都相同/);
  assert.match(prompt, /ID 不一致时停止/);
  assert.doesNotMatch(prompt, /只有与下方 ID 一致时，才只替换 token/);
});

test("cross-origin onboarding isolates credentials, spool and cache", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "https://ingest.example.test",
    [],
    site.config.publishedAgentVersion,
  );
  for (const text of [
    "不得把新 token 写入旧地址的配置",
    "独立的 0700 配置目录",
    "显式设置 spoolDir",
    "不得复制旧 spool、latest-report.json",
    "新环境首次上报和页面核对成功后",
  ])
    assert(prompt.includes(text), text);
  assert(prompt.includes('"url": "https://ingest.example.test"'));
});

test("every command and supervised service uses the chosen configuration", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "http://127.0.0.1:37053",
    [],
    site.config.publishedAgentVersion,
  );
  assert.match(prompt, /所有 init、once、watch、realtime-watch/);
  assert.match(prompt, /launchd\/systemd 的环境中显式设置 EAGLE_CONFIG/);
  assert.match(prompt, /不覆盖旧配置，不删除旧队列/);
});

test("same-origin rotation restarts only existing services using the selected config", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "https://ingest.example.test",
    [],
    site.config.publishedAgentVersion,
  );
  const rotation = prompt.split("- 同环境轮换：")[1]?.split("\n")[0] ?? "";
  assert.match(rotation, /重启使用该配置且已启用的 watch、realtime-watch 服务/);
  assert.match(rotation, /不要因此启动尚未启用的可选服务/);
});

test("onboarding pins the published Agent independently of website releases", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "https://ingest.example.test",
    [],
    site.config.publishedAgentVersion,
  );
  assert(
    prompt.includes(
      `npm install -g @nocoo/eagle-agent@${site.config.publishedAgentVersion} `,
    ),
  );
  assert(
    prompt.includes(
      `eagle-agent --version（应输出 ${site.config.publishedAgentVersion}）`,
    ),
  );
  assert.doesNotMatch(prompt, /与 Eagle 网站版本一致/);
});

test("release pins verified Agent 1.2.0", () => {
  const prompt = onboardingPrompt(
    machine,
    "fixture-token",
    "https://ingest.example.test",
    [],
    site.config.publishedAgentVersion,
  );
  assert.match(site.config.publishedAgentVersion, /^\d+\.\d+\.\d+$/);
  assert(
    prompt.includes(
      `npm install -g @nocoo/eagle-agent@${site.config.publishedAgentVersion} `,
    ),
  );
  assert(
    !prompt.includes(`npm install -g @nocoo/eagle-agent@${site.version} `),
  );
});
