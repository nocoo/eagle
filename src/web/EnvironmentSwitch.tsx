import { SegmentControl } from "@nocoo/basalt";
import { useState } from "react";
import {
  environment,
  localFrontend,
  selectEnvironment,
} from "./environment.ts";

export function EnvironmentSwitch() {
  const [error, setError] = useState("");
  if (!localFrontend) return null;
  return (
    <>
      <SegmentControl
        legend="环境"
        className="[&>legend]:sr-only [&_[data-slot=segment-control-viewport]]:overflow-visible [&_[data-slot=segment-control-viewport]]:pb-0"
        value={environment}
        options={[
          { value: "local", label: "Local" },
          { value: "prod", label: "Prod" },
        ]}
        onValueChange={(value) => {
          try {
            selectEnvironment(value);
          } catch {
            setError("无法保存环境选择，请允许会话存储后重试。");
          }
        }}
      />
      {error && (
        <span role="alert" className="text-xs text-basalt-destructive">
          {error}
        </span>
      )}
    </>
  );
}
