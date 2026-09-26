import { useEffect, useRef, useState } from "react";

const sensitive =
  /-----BEGIN [\w ]*PRIVATE KEY-----|\bBearer\s+\S+|\beag1\.[\w.-]+|\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,})\b|(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[\w]*["']?\s*[=:]\s*\S+/i;

export function useInputDraft(key: string) {
  const memory = useRef(new Map<string, string>());
  const [draft, setDraft] = useState({ key: "", text: "" });
  const [warning, setWarning] = useState("");
  useEffect(() => {
    let text = memory.current.get(key) ?? "";
    setWarning("");
    if (key) {
      try {
        if (!memory.current.has(key)) text = localStorage.getItem(key) ?? "";
        if (text.length > 8000 || sensitive.test(text)) {
          localStorage.removeItem(key);
          text = "";
        }
      } catch {
        setWarning("草稿未能保存到浏览器，关闭页面会丢失");
      }
    }
    setDraft({ key, text });
  }, [key]);
  const update = (text: string) => {
    if (!key) return;
    memory.current.set(key, text);
    setDraft({ key, text });
    const privateText = sensitive.test(text);
    try {
      if (text && !privateText) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
      setWarning(privateText ? "含敏感信息的草稿仅保留在当前页面" : "");
    } catch {
      setWarning("草稿未能保存到浏览器，关闭页面会丢失");
    }
  };
  return { text: draft.key === key ? draft.text : "", update, warning };
}
